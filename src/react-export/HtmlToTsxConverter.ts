import * as cheerio from "cheerio";
import path from "node:path";
import type { AnyNode, Element } from "domhandler";
import type { ConvertedPage, ReactRouteSource } from "./types.js";

const ATTRIBUTE_RENAMES = new Map<string, string>([
  ["class", "className"],
  ["for", "htmlFor"],
  ["http-equiv", "httpEquiv"],
  ["accept-charset", "acceptCharset"],
  ["tabindex", "tabIndex"],
  ["readonly", "readOnly"],
  ["maxlength", "maxLength"],
  ["minlength", "minLength"],
  ["srcset", "srcSet"],
  ["crossorigin", "crossOrigin"],
  ["referrerpolicy", "referrerPolicy"],
  ["playsinline", "playsInline"],
  ["autoplay", "autoPlay"],
  ["autocomplete", "autoComplete"],
  ["autocapitalize", "autoCapitalize"],
  ["autocorrect", "autoCorrect"],
  ["fetchpriority", "fetchPriority"],
  ["spellcheck", "spellCheck"],
  ["viewbox", "viewBox"],
  ["fill-rule", "fillRule"],
  ["clip-rule", "clipRule"],
  ["stroke-width", "strokeWidth"],
  ["stroke-linecap", "strokeLinecap"],
  ["stroke-linejoin", "strokeLinejoin"],
  ["stop-color", "stopColor"],
  ["stop-opacity", "stopOpacity"],
]);

const BOOLEAN_ATTRIBUTES = new Set(["allowFullScreen", "async", "autoFocus", "autoPlay", "checked", "controls", "default", "defer", "disabled", "hidden", "loop", "multiple", "muted", "open", "playsInline", "readOnly", "required", "selected"]);
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const URL_ATTRIBUTES = new Set(["href", "src", "poster", "content"]);
const NUMERIC_ATTRIBUTES = new Set(["cols", "colSpan", "height", "max", "min", "rows", "rowSpan", "size", "span", "start", "step", "tabIndex", "width"]);

export class HtmlToTsxConverter {
  convert(route: ReactRouteSource): ConvertedPage {
    const $ = cheerio.load(route.html);
    this.#stripRuntime($);
    const css = this.#extractCss($);
    const bodyChildren = $("body").contents().toArray();
    const jsx = bodyChildren.map((node) => this.#nodeToTsx(node, route, 3)).filter(Boolean).join("\n");

    return { route, jsx: jsx || "<main />", css, componentImports: [] };
  }

  #stripRuntime($: cheerio.CheerioAPI): void {
    $("script, noscript, meta, link[rel='modulepreload'], link[rel='preload'], link[rel='prefetch'], iframe[src*='events.framer.com']").remove();
    $("[data-framer-appear-id], [data-framer-name]").each((_, element) => {
      $(element).removeAttr("data-framer-appear-id");
      $(element).removeAttr("data-framer-name");
    });
  }

  #extractCss($: cheerio.CheerioAPI): string {
    const css: string[] = [];
    $("style").each((_, element) => {
      const text = $(element).html()?.trim();
      if (text) {
        css.push(text);
      }
      $(element).remove();
    });
    $("link[rel='stylesheet']").remove();
    return css.join("\n\n");
  }

  #nodeToTsx(node: AnyNode, route: ReactRouteSource, depth: number): string {
    if (node.type === "text") {
      return this.#textToTsx(node.data ?? "", depth);
    }
    if (node.type === "comment") {
      return "";
    }
    if (node.type !== "tag" && node.type !== "script" && node.type !== "style") {
      return "";
    }

    const element = node as Element;
    const tagName = element.name;
    if (!tagName || tagName === "script" || tagName === "style") {
      return "";
    }

    const indent = this.#indent(depth);
    const attributes = this.#attributesToTsx(element, route);
    const open = attributes ? `<${tagName} ${attributes}>` : `<${tagName}>`;

    if (VOID_ELEMENTS.has(tagName)) {
      const selfClosing = attributes ? `<${tagName} ${attributes} />` : `<${tagName} />`;
      return `${indent}${selfClosing}`;
    }

    const children = element.children.map((child) => this.#nodeToTsx(child, route, depth + 1)).filter(Boolean);
    if (children.length === 0) {
      return `${indent}${open}</${tagName}>`;
    }

    return `${indent}${open}\n${children.join("\n")}\n${indent}</${tagName}>`;
  }

  #attributesToTsx(element: Element, route: ReactRouteSource): string {
    const attributes: string[] = [];
    for (const [rawName, rawValue] of Object.entries(element.attribs ?? {})) {
      if (rawName.startsWith("data-framer") || rawName === "data-highlighted") {
        continue;
      }
      if (rawName === "space" || rawName === "weight") {
        continue;
      }
      if (rawName === "name" && !this.#allowsNameAttribute(element.name)) {
        continue;
      }

      const name = this.#normalizedAttributeName(element.name, rawName);
      const value = this.#rewriteAttributeValue(name, rawValue, route);
      if (name === "style") {
        const styleObject = this.#styleToObject(value);
        if (styleObject) {
          attributes.push(`style={${styleObject} as React.CSSProperties}`);
        }
        continue;
      }

      if (BOOLEAN_ATTRIBUTES.has(name) && (value === "" || value.toLowerCase() === name.toLowerCase())) {
        attributes.push(name);
        continue;
      }

      attributes.push(`${name}=${this.#attributeExpression(name, value)}`);
    }
    return attributes.join(" ");
  }

  #normalizedAttributeName(tagName: string, rawName: string): string {
    const renamed = ATTRIBUTE_RENAMES.get(rawName.toLowerCase()) ?? rawName;
    if (renamed === "value" && ["input", "textarea"].includes(tagName)) {
      return "defaultValue";
    }
    return renamed;
  }

  #allowsNameAttribute(tagName: string): boolean {
    return ["button", "fieldset", "form", "iframe", "input", "map", "meta", "object", "output", "param", "select", "textarea"].includes(tagName);
  }

  #rewriteAttributeValue(name: string, value: string, route: ReactRouteSource): string {
    if (name === "srcSet") {
      return value.split(",").map((entry) => {
        const parts = entry.trim().split(/\s+/);
        return [this.#rewriteUrl(parts[0], route), ...parts.slice(1)].join(" ");
      }).join(", ");
    }

    if (!URL_ATTRIBUTES.has(name)) {
      return value;
    }
    return this.#rewriteUrl(value, route);
  }

  #rewriteUrl(value: string, route: ReactRouteSource): string {
    if (!value || /^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) {
      return value;
    }

    const normalized = value.replace(/\\/g, "/");
    const assetIndex = normalized.indexOf("assets/");
    if (assetIndex >= 0) {
      return `/${normalized.slice(assetIndex)}`;
    }

    if (normalized.startsWith("/")) {
      return normalized;
    }

    const fromDirectory = path.posix.dirname(route.localPath);
    const resolved = path.posix.normalize(path.posix.join(fromDirectory, normalized));
    if (resolved === "." || resolved === "" || resolved === "index.html") {
      return "/";
    }
    if (resolved.endsWith("/index.html")) {
      return `/${resolved.slice(0, -"/index.html".length)}`;
    }
    if (resolved.endsWith(".html")) {
      return `/${resolved.slice(0, -".html".length)}`;
    }
    if (!path.posix.extname(resolved)) {
      return `/${resolved}`;
    }
    return normalized;
  }

  #styleToObject(style: string): string {
    const declarations = style.split(";").map((part) => part.trim()).filter(Boolean);
    const entries = declarations.flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon <= 0) {
        return [];
      }
      const prop = this.#camelCase(declaration.slice(0, colon).trim());
      const value = declaration.slice(colon + 1).trim();
      return [`${JSON.stringify(prop)}: ${JSON.stringify(value)}`];
    });
    return entries.length > 0 ? `{ ${entries.join(", ")} }` : "";
  }

  #textToTsx(text: string, depth: number): string {
    if (!text.trim()) {
      return "";
    }
    return `${this.#indent(depth)}{${JSON.stringify(text.replace(/\s+/g, " "))}}`;
  }

  #camelCase(value: string): string {
    if (value.startsWith("--")) {
      return value;
    }
    return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
  }

  #attributeExpression(name: string, value: string): string {
    if (NUMERIC_ATTRIBUTES.has(name) && /^-?\d+(?:\.\d+)?$/.test(value)) {
      return `{${value}}`;
    }
    return `{${JSON.stringify(value)}}`;
  }

  #indent(depth: number): string {
    return "  ".repeat(depth);
  }
}

