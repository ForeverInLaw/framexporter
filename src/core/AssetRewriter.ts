import * as cheerio from "cheerio";
import path from "node:path";
import type { ResponseArchive } from "./ResponseArchive.js";

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

export class AssetRewriter {
  constructor(private readonly archive: ResponseArchive) {}

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

    $("[style]").each((_, element) => {
      const current = $(element).attr("style");
      if (current) {
        $(element).attr("style", this.rewriteCss(current, pageUrl, routeLocalPath));
      }
    });

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
      const relativePath = this.#relativeLocalPath(fromLocalPath, asset.localPath);
      rewritten = rewritten.split(asset.sourceUrl).join(relativePath);
      rewritten = rewritten.split(encodeURI(asset.sourceUrl)).join(relativePath);
      rewritten = rewritten.split(asset.sourceUrl.replace(/&/g, "&amp;")).join(relativePath);
    }

    return this.#rewriteRelativeSpecifiers(rewritten, baseUrl, fromLocalPath);
  }

  collectExternalUrls(text: string): string[] {
    const urls = new Set<string>();
    for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\)]+/gi)) {
      const rawUrl = match[0].replace(/[.,;:]+$/g, "");
      if (!this.archive.localPathFor(rawUrl) && !this.#isIgnorableExternalUrl(rawUrl)) {
        urls.add(rawUrl);
      }
    }
    return [...urls].sort();
  }

  #rewriteSingleUrl(rawUrl: string | undefined, baseUrl: string, fromLocalPath: string): string | undefined {
    if (!rawUrl || this.#shouldIgnore(rawUrl)) {
      return undefined;
    }

    const absoluteUrl = new URL(rawUrl, baseUrl).toString();
    const localPath = this.archive.localPathFor(absoluteUrl);
    return localPath ? this.#relativeLocalPath(fromLocalPath, localPath) : undefined;
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
    urls.add(new URL(rawUrl, baseUrl).toString());
  }

  #parseSrcSetUrls(rawSrcSet: string | undefined): string[] {
    if (!rawSrcSet) {
      return [];
    }
    return rawSrcSet.split(",").map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean);
  }

  #relativeLocalPath(fromLocalPath: string, targetLocalPath: string): string {
    const fromDirectory = path.posix.dirname(fromLocalPath);
    const relative = path.posix.relative(fromDirectory, targetLocalPath);
    return relative.startsWith(".") ? relative : `./${relative}`;
  }

  #rewriteRelativeSpecifiers(text: string, baseUrl: string, fromLocalPath: string): string {
    return text.replace(/(["'`])((?:\.\.?\/|\/)[^"'`]+)\1/g, (match, quote: string, rawUrl: string) => {
      if (this.#shouldIgnore(rawUrl)) {
        return match;
      }

      const absoluteUrl = new URL(rawUrl, baseUrl).toString();
      const localPath = this.archive.localPathFor(absoluteUrl);
      return localPath ? `${quote}${this.#relativeLocalPath(fromLocalPath, localPath)}${quote}` : match;
    });
  }

  #isIgnorableExternalUrl(rawUrl: string): boolean {
    return /^https?:\/\/(www\.w3\.org|example\.com)\b/i.test(rawUrl)
      || /\.map(?:$|[?#])/i.test(rawUrl)
      || /[`{}]/.test(rawUrl);
  }
}
