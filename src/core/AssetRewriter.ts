import * as cheerio from "cheerio";
import path from "node:path";
import type { ResponseArchive } from "./ResponseArchive.js";
import type { RoutePathMapper } from "./RoutePathMapper.js";

const URL_ATTRIBUTES = [
  ["a", "href"],
  ["link", "href"],
  ["script", "src"],
  ["img", "src"],
  ["source", "src"],
  ["video", "src"],
  ["audio", "src"],
  ["iframe", "src"],
] as const;

const ASSET_URL_ATTRIBUTES = URL_ATTRIBUTES.filter(([selector]) => selector !== "a" && selector !== "iframe");
const FRAMER_SCROLLBAR_FIX_CSS = `html,body,[class^="framer-"],[class*=" framer-"]{scrollbar-width:none;-ms-overflow-style:none}html::-webkit-scrollbar,body::-webkit-scrollbar,[class^="framer-"]::-webkit-scrollbar,[class*=" framer-"]::-webkit-scrollbar{width:0;height:0;display:none}`;

export class AssetRewriter {
  constructor(
    private readonly archive: ResponseArchive,
    private readonly routes: RoutePathMapper,
  ) {}

  collectHtmlAssetUrls(html: string, pageUrl: string): string[] {
    const $ = cheerio.load(html);

    $("script[src]").each((_, element) => {
      const source = $(element).attr("src");
      if (source && new URL(source, pageUrl).host === "events.framer.com") {
        $(element).remove();
      }
    });
    const urls = new Set<string>();

    for (const [selector, attribute] of ASSET_URL_ATTRIBUTES) {
      $(selector).each((_, element) => this.#collectSingleUrl($(element).attr(attribute), pageUrl, urls));
    }

    $("img[srcset], source[srcset]").each((_, element) => {
      const srcset = $(element).attr("srcset");
      for (const rawUrl of this.#parseSrcSetUrls(srcset)) {
        this.#collectSingleUrl(rawUrl, pageUrl, urls);
      }
    });

    $("style").each((_, element) => {
      for (const rawUrl of this.collectCssAssetUrls($(element).html() ?? "", pageUrl)) {
        urls.add(rawUrl);
      }
    });

    $("script:not([src])").each((_, element) => {
      this.#collectEmbeddedAssetUrls($(element).html() ?? "", pageUrl, urls);
    });

    $("[content]").each((_, element) => {
      this.#collectEmbeddedAssetUrls($(element).attr("content") ?? "", pageUrl, urls);
    });

    $("[style]").each((_, element) => {
      for (const rawUrl of this.collectCssAssetUrls($(element).attr("style") ?? "", pageUrl)) {
        urls.add(rawUrl);
      }
    });

    return [...urls];
  }

  collectCssAssetUrls(css: string, baseUrl: string): string[] {
    const urls = new Set<string>();
    for (const match of css.matchAll(/url\((['"]?)([^)'"\s]+)\1\)/gi)) {
      this.#collectSingleUrl(match[2], baseUrl, urls);
    }
    return [...urls];
  }

  collectTextAssetUrls(text: string, baseUrl: string): string[] {
    const urls = new Set(this.collectCssAssetUrls(text, baseUrl));
    this.#collectConstructedUrlAssets(text, baseUrl, urls);
    this.#collectRelativeSpecifierAssets(text, baseUrl, urls);
    this.#collectEmbeddedAssetUrls(text, baseUrl, urls);
    return [...urls];
  }

  rewriteHtml(html: string, pageUrl: string, routeLocalPath: string): string {
    const $ = cheerio.load(html);

    for (const [selector, attribute] of URL_ATTRIBUTES) {
      $(selector).each((_, element) => {
        const current = $(element).attr(attribute);
        const rewritten = this.#rewriteSingleUrl(current, pageUrl, routeLocalPath);
        if (rewritten) {
          $(element).attr(attribute, rewritten);
        }
      });
    }

    $("[content]").each((_, element) => {
      const current = $(element).attr("content");
      const rewritten = this.#rewriteSingleUrl(current, pageUrl, routeLocalPath);
      if (rewritten) {
        $(element).attr("content", rewritten);
      }
    });

    $("img[srcset], source[srcset]").each((_, element) => {
      const current = $(element).attr("srcset");
      const rewritten = this.#rewriteSrcSet(current, pageUrl, routeLocalPath);
      if (rewritten) {
        $(element).attr("srcset", rewritten);
      }
    });

    $("style").each((_, element) => {
      const current = $(element).html();
      if (current) {
        $(element).html(this.rewriteCss(current, pageUrl, routeLocalPath));
      }
    });

    $("script:not([src])").each((_, element) => {
      const current = $(element).html();
      if (current) {
        if (current.includes("__framer_force_showing_editorbar_since")) {
          $(element).remove();
          return;
        }
        $(element).text(this.rewriteCapturedText(current, pageUrl, routeLocalPath));
      }
    });

    $("[style]").each((_, element) => {
      const current = $(element).attr("style");
      if (current) {
        $(element).attr("style", this.rewriteCss(current, pageUrl, routeLocalPath));
      }
    });

    this.#injectScrollbarFix($);
    return $.html().replace(/<script\b[^>]*src=["']https:\/\/events\.framer\.com\/script[^>]*><\/script>/gi, "");
  }

  rewriteCss(css: string, baseUrl: string, fromLocalPath: string): string {
    return this.rewriteCapturedText(css, baseUrl, fromLocalPath).replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote: string, rawUrl: string) => {
      const rewritten = this.#rewriteSingleUrl(rawUrl, baseUrl, fromLocalPath);
      return rewritten ? `url(${quote}${rewritten}${quote})` : match;
    });
  }

  rewriteCapturedText(text: string, baseUrl: string, fromLocalPath: string): string {
    let rewritten = text;
    const assets = [...this.archive.assets].sort((left, right) => right.sourceUrl.length - left.sourceUrl.length);

    for (const asset of assets) {
      const localPath = /\.(mjs|js)$/i.test(fromLocalPath) ? `/${asset.localPath}` : this.#relativeLocalPath(fromLocalPath, asset.localPath);
      rewritten = this.#replaceUrlText(rewritten, asset.sourceUrl, localPath);
    }


    const withLocalSpecifiers = this.#rewriteRelativeSpecifiers(rewritten, baseUrl, fromLocalPath);
    if (!/\.(mjs|js)$/i.test(fromLocalPath)) {
      return withLocalSpecifiers;
    }

    return this.#disableFramerEditorBar(this.#repairRelativeNewUrlBases(withLocalSpecifiers));
  }

  collectExternalUrls(text: string): string[] {
    const urls = new Set<string>();
    for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)) {
      const rawUrl = match[0].replace(/[.,;:]+$/g, "");
      if (!this.archive.localPathFor(rawUrl) && !this.#isKnownRoute(rawUrl) && !this.#isIgnorableExternalUrl(rawUrl)) {
        urls.add(rawUrl);
      }
    }
    return [...urls].sort();
  }

  #injectScrollbarFix($: cheerio.CheerioAPI): void {
    if ($("style[data-framexporter-scrollbar-fix]").length > 0) {
      return;
    }

    const style = `<style data-framexporter-scrollbar-fix>${FRAMER_SCROLLBAR_FIX_CSS}</style>`;
    const head = $("head");
    if (head.length > 0) {
      head.append(style);
      return;
    }
    $.root().prepend(style);
  }
  #rewriteSingleUrl(rawUrl: string | undefined, baseUrl: string, fromLocalPath: string): string | undefined {
    if (!rawUrl || this.#shouldIgnore(rawUrl)) {
      return undefined;
    }

    let absoluteUrl: string;
    try {
      absoluteUrl = new URL(rawUrl, baseUrl).toString();
    } catch {
      return undefined;
    }

    const localPath = this.archive.localPathFor(absoluteUrl);
    if (localPath) {
      return this.#relativeLocalPath(fromLocalPath, localPath);
    }

    const routeLocalPath = this.routes.localPathFor(rawUrl, baseUrl);
    return routeLocalPath ? this.routes.hrefFor(fromLocalPath, routeLocalPath) : undefined;
  }

  #rewriteSrcSet(rawSrcSet: string | undefined, baseUrl: string, fromLocalPath: string): string | undefined {
    if (!rawSrcSet) {
      return undefined;
    }

    let changed = false;
    const entries = rawSrcSet.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const rewritten = this.#rewriteSingleUrl(parts[0], baseUrl, fromLocalPath);
      if (!rewritten) {
        return entry.trim();
      }
      changed = true;
      return [rewritten, ...parts.slice(1)].join(" ");
    });

    return changed ? entries.join(", ") : undefined;
  }

  #shouldIgnore(rawUrl: string): boolean {
    return /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(rawUrl);
  }

  #collectSingleUrl(rawUrl: string | undefined, baseUrl: string, urls: Set<string>): void {
    if (!rawUrl || this.#shouldIgnore(rawUrl)) {
      return;
    }
    try {
      urls.add(new URL(rawUrl, baseUrl).toString());
    } catch {
      return;
    }
  }

  #parseSrcSetUrls(rawSrcSet: string | undefined): string[] {
    if (!rawSrcSet) {
      return [];
    }
    return rawSrcSet.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
  }

  #collectEmbeddedAssetUrls(text: string, baseUrl: string, urls: Set<string>): void {
    for (const match of text.matchAll(/https?:\/\/[^\s"'`<>\\)]+/gi)) {
      const rawUrl = match[0].replace(/&amp;/g, "&").replace(/[.,;:]+$/g, "");
      if (this.routes.localPathFor(rawUrl, baseUrl)) {
        continue;
      }
      if (this.#isLikelyStaticAsset(rawUrl)) {
        this.#collectSingleUrl(rawUrl, baseUrl, urls);
      }
    }
  }

  #collectConstructedUrlAssets(text: string, baseUrl: string, urls: Set<string>): void {
    const newUrlPattern = /new URL\(\s*(["'`])([^"'`]+)\1\s*,\s*(["'`])([^"'`]+)\3\s*\)(?:\.href\.replace\(\s*(["'`])\/modules\/\5\s*,\s*(["'`])\/cms\/\6\s*\))?/g;

    for (const match of text.matchAll(newUrlPattern)) {
      try {
        let resolved = new URL(match[2], new URL(match[4], baseUrl)).toString();
        if (match[0].includes(".href.replace")) {
          resolved = resolved.replace("/modules/", "/cms/");
        }
        if (this.#isLikelyStaticAsset(resolved)) {
          urls.add(resolved);
        }
      } catch {
        continue;
      }
    }
  }
  #collectRelativeSpecifierAssets(text: string, baseUrl: string, urls: Set<string>): void {
    for (const match of text.matchAll(/(["'`])((?:\.\.?\/|\/)[^"'`]+)\1/g)) {
      const rawUrl = match[2];
      if (this.#shouldIgnore(rawUrl)) {
        continue;
      }

      try {
        const resolved = new URL(rawUrl, baseUrl).toString();
        if (this.#isLikelyStaticAsset(resolved)) {
          urls.add(resolved);
        }
      } catch {
        continue;
      }
    }
  }

  #isLikelyStaticAsset(rawUrl: string): boolean {
    try {
      const url = new URL(rawUrl);
      return url.hostname === "framerusercontent.com"
        || /\.(mjs|js|css|framercms|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|json)$/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  #relativeLocalPath(fromLocalPath: string, targetLocalPath: string): string {
    const fromDirectory = path.posix.dirname(fromLocalPath);
    const relative = path.posix.relative(fromDirectory, targetLocalPath);
    return relative.startsWith(".") ? relative : `./${relative}`;
  }

  #replaceUrlText(text: string, sourceUrl: string, replacement: string): string {
    return text
      .split(sourceUrl).join(replacement)
      .split(encodeURI(sourceUrl)).join(replacement)
      .split(sourceUrl.replace(/&/g, "&amp;")).join(replacement);
  }

  #repairRelativeNewUrlBases(text: string): string {
    return text.replace(
      /new URL\(([^,\n]+),\s*(["'`])((?:\.\.?\/|\/)[^"'`]+)\2\)/g,
      (match, input: string, quote: string, relativeBase: string) => {
        if (/import\.meta\.url/.test(match)) {
          return match;
        }
        return `new URL(${input},new URL(${quote}${relativeBase}${quote},import.meta.url))`;
      },
    );
  }

  #disableFramerEditorBar(text: string): string {
    return text
      .replace(/EditorBar:\(\)=>import\((['"`])https:\/\/framer\.com\/edit[^'"`]*\1\)/g, "EditorBar:void 0")
      .replace(/EditorBar:\(\)=>import\((['"`])(?:\.\.?\/|\/)assets\/framer\.com\/edit[^'"`]*\1\)/g, "EditorBar:void 0")
      .replace(
        /EditorBar:(?:(?!adaptLayoutToTextDirection)[\s\S])*?framer\.com\/edit(?:(?!adaptLayoutToTextDirection)[\s\S])*?,adaptLayoutToTextDirection/g,
        "EditorBar:void 0,adaptLayoutToTextDirection",
      );
  }

  #rewriteRelativeSpecifiers(text: string, baseUrl: string, fromLocalPath: string): string {
    return text.replace(/(["'`])((?:\.\.?\/|\/)[^"'`]+)\1/g, (match, quote: string, rawUrl: string) => {
      if (this.#shouldIgnore(rawUrl)) {
        return match;
      }

      let absoluteUrl: string;
      try {
        absoluteUrl = new URL(rawUrl, baseUrl).toString();
      } catch {
        return match;
      }

      const localPath = this.archive.localPathFor(absoluteUrl);
      if (localPath) {
        const replacementPath = /\.(mjs|js)$/i.test(fromLocalPath) ? `/${localPath}` : this.#relativeLocalPath(fromLocalPath, localPath);
        return `${quote}${replacementPath}${quote}`;
      }

      const routeLocalPath = this.routes.localPathFor(rawUrl, baseUrl);
      return routeLocalPath ? `${quote}${this.routes.hrefFor(fromLocalPath, routeLocalPath)}${quote}` : match;
    });
  }

  #isKnownRoute(rawUrl: string): boolean {
    try {
      return this.routes.localPathFor(rawUrl, rawUrl) !== undefined;
    } catch {
      return false;
    }
  }

  #isIgnorableExternalUrl(rawUrl: string): boolean {
    return /^https?:\/\/(www\.w3\.org|example\.com)\b/i.test(rawUrl)
      || /\.map(?:$|[?#])/i.test(rawUrl)
      || /[`{}]/.test(rawUrl);
  }
}

