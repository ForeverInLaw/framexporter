import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssetFetcher } from "./AssetFetcher.js";
import { AssetRewriter } from "./AssetRewriter.js";
import { BrowserRenderer } from "./BrowserRenderer.js";
import { ResponseArchive } from "./ResponseArchive.js";
import { RoutePlanner } from "./RoutePlanner.js";
import type { ExportManifest, ExportOptions, ExportedRoute } from "./types.js";

export class ExportJob {
  readonly #options: ExportOptions;
  readonly #archive: ResponseArchive;
  readonly #fetcher: AssetFetcher;
  readonly #rewriter: AssetRewriter;
  readonly #renderer: BrowserRenderer;
  readonly #warnings: string[] = [];

  constructor(options: ExportOptions) {
    this.#options = options;
    this.#archive = new ResponseArchive(options.outputDir);
    this.#fetcher = new AssetFetcher(this.#archive);
    this.#rewriter = new AssetRewriter(this.#archive);
    this.#renderer = new BrowserRenderer(this.#archive, { waitMs: options.waitMs });
  }

  async run(): Promise<ExportManifest> {
    await mkdir(this.#options.outputDir, { recursive: true });
    const planner = new RoutePlanner(this.#options.startUrl);
    const routes: ExportedRoute[] = [];

    await this.#renderer.start();
    try {
      while (routes.length < this.#options.maxPages) {
        const nextUrl = planner.next();
        if (!nextUrl) {
          break;
        }

        planner.markVisited(nextUrl);
        const rendered = await this.#renderer.render(nextUrl);
        const discoveredLinks = planner.discover(rendered.html, rendered.url);
        const staticUrls = this.#rewriter.collectHtmlAssetUrls(rendered.html, rendered.url);
        await this.#fetcher.fetchMissing(staticUrls);
        const localPath = this.#routePath(rendered.url);
        const rewrittenHtml = this.#rewriter.rewriteHtml(rendered.html, rendered.url, localPath);
        await this.#writeRoute(localPath, rewrittenHtml);

        routes.push({ sourceUrl: rendered.url, localPath, discoveredLinks });
      }
    } finally {
      await this.#renderer.stop();
    }

    await this.#rewriteCapturedCss();
    this.#addRuntimeWarnings();

    const manifest: ExportManifest = {
      generatedAt: new Date().toISOString(),
      startUrl: this.#options.startUrl.toString(),
      routes,
      assets: this.#archive.assets,
      skipped: this.#archive.skipped,
      warnings: this.#warnings,
    };

    await writeFile(
      path.join(this.#options.outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    return manifest;
  }

  async #writeRoute(localPath: string, html: string): Promise<void> {
    const absolutePath = path.join(this.#options.outputDir, ...localPath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, html, "utf8");
  }

  async #rewriteCapturedCss(): Promise<void> {
    for (const asset of this.#archive.assets) {
      if (!/text\/css/i.test(asset.contentType)) {
        continue;
      }

      const absolutePath = path.join(this.#options.outputDir, ...asset.localPath.split("/"));
      const css = await import("node:fs/promises").then((fs) => fs.readFile(absolutePath, "utf8"));
      await this.#fetcher.fetchMissing(this.#rewriter.collectCssAssetUrls(css, asset.sourceUrl));
      const rewritten = this.#rewriter.rewriteCss(css, asset.sourceUrl, asset.localPath);
      await writeFile(absolutePath, rewritten, "utf8");
    }
  }

  #routePath(rawUrl: string): string {
    const parsed = new URL(rawUrl);
    const cleanPath = parsed.pathname.replace(/^\/|\/$/g, "");
    if (!cleanPath) {
      return "index.html";
    }

    if (path.posix.extname(cleanPath)) {
      return cleanPath;
    }

    return `${cleanPath}/index.html`;
  }

  #addRuntimeWarnings(): void {
    this.#warnings.push(
      "Dynamic Framer backends such as forms, search, ecommerce, auth, analytics, or CMS mutations are not recreated by this static export.",
    );
    if (this.#archive.skipped.length > 0) {
      this.#warnings.push("Some responses were skipped. Review manifest.json before deploying the export.");
    }
  }
}
