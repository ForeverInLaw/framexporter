import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssetFetcher } from "./AssetFetcher.js";
import { AssetRewriter } from "./AssetRewriter.js";
import { BrowserRenderer } from "./BrowserRenderer.js";
import { ResponseArchive } from "./ResponseArchive.js";
import { RoutePathMapper } from "./RoutePathMapper.js";
import { RoutePlanner } from "./RoutePlanner.js";
import { SitemapDiscoverer } from "./SitemapDiscoverer.js";
import { runWithConcurrency } from "./runWithConcurrency.js";
import type { CapturedAsset, ExportManifest, ExportOptions, ExportProgress, ExportedRoute } from "./types.js";

const MAX_TEXT_ASSET_REWRITE_CONCURRENCY = 4;
const MAX_EXTERNAL_URL_SCAN_CONCURRENCY = 8;

export class ExportJob {
  readonly #options: ExportOptions;
  readonly #archive: ResponseArchive;
  readonly #fetcher: AssetFetcher;
  readonly #rewriter: AssetRewriter;
  readonly #renderer: BrowserRenderer;
  readonly #routePaths: RoutePathMapper;
  readonly #sitemapDiscoverer = new SitemapDiscoverer();
  readonly #warnings: string[] = [];
  #routesCompleted = 0;
  #assetFetchesCompleted = 0;

  constructor(options: ExportOptions) {
    this.#options = options;
    this.#archive = new ResponseArchive(options.outputDir);
    this.#fetcher = new AssetFetcher(this.#archive);
    this.#routePaths = new RoutePathMapper(options.startUrl);
    this.#rewriter = new AssetRewriter(this.#archive, this.#routePaths);
    this.#renderer = new BrowserRenderer(this.#archive, { waitMs: options.waitMs });
  }

  async run(): Promise<ExportManifest> {
    await mkdir(this.#options.outputDir, { recursive: true });
    const planner = new RoutePlanner(this.#options.startUrl);
    this.#routePaths.register(this.#options.startUrl.toString());
    const discoveredSitemapUrls = await this.#sitemapDiscoverer.discover(this.#options.startUrl);
    this.#routePaths.registerAll(discoveredSitemapUrls);
    const sitemapRoutes = planner.enqueueAll(discoveredSitemapUrls);
    const routes: ExportedRoute[] = [];

    const activeLocales = new Set<string>();
    // Enqueue default 404 page
    const default404 = new URL("/404", this.#options.startUrl);
    planner.enqueue(default404.toString());
    this.#routePaths.register(default404.toString());

    // Detect locales from sitemap URLs
    for (const urlStr of [this.#options.startUrl.toString(), ...discoveredSitemapUrls]) {
      try {
        const parsed = new URL(urlStr);
        const match = parsed.pathname.match(/^\/([a-z]{2}(?:-[a-zA-Z]{2,4})?)(?:\/|$)/);
        if (match) {
          const locale = match[1];
          if (!activeLocales.has(locale)) {
            activeLocales.add(locale);
            const localized404 = new URL(`/${locale}/404`, this.#options.startUrl);
            planner.enqueue(localized404.toString());
            this.#routePaths.register(localized404.toString());
          }
        }
      } catch {}
    }

    await this.#renderer.start();
    try {
      this.#reportProgress("rendering", this.#options.startUrl.toString());
      while (!this.#isPageLimitReached(routes.length)) {
        const nextUrl = planner.next();
        if (!nextUrl) {
          break;
        }

        planner.markVisited(nextUrl);
        this.#reportProgress("rendering", nextUrl);
        const rendered = await this.#renderer.render(nextUrl);
        const discoveredLinks = planner.discover(rendered.html, rendered.url);
        this.#routePaths.registerAll(discoveredLinks);

        // Detect new active locales from crawled page links and enqueue their 404 pages
        for (const link of discoveredLinks) {
          try {
            const parsed = new URL(link);
            const match = parsed.pathname.match(/^\/([a-z]{2}(?:-[a-zA-Z]{2,4})?)(?:\/|$)/);
            if (match) {
              const locale = match[1];
              if (!activeLocales.has(locale)) {
                activeLocales.add(locale);
                const localized404 = new URL(`/${locale}/404`, this.#options.startUrl);
                planner.enqueue(localized404.toString());
                this.#routePaths.register(localized404.toString());
              }
            }
          } catch {}
        }

        const staticUrls = this.#rewriter.collectHtmlAssetUrls(rendered.html, rendered.url);
        await this.#fetcher.fetchMissing(staticUrls, (sourceUrl) => {
          this.#assetFetchesCompleted += 1;
          this.#reportProgress("fetching", sourceUrl);
        });
        const localPath = this.#routePaths.register(nextUrl) ?? "index.html";
        const rewrittenHtml = this.#rewriter.rewriteHtml(rendered.html, rendered.url, localPath);
        await this.#writeRoute(localPath, rewrittenHtml);

        routes.push({ sourceUrl: rendered.url, localPath, discoveredLinks });
        this.#routesCompleted = routes.length;
        this.#reportProgress("rendering", rendered.url);
      }
    } finally {
      await this.#renderer.stop();
    }

    await this.#rewriteCapturedAssets();
    this.#addRuntimeWarnings();

    const manifest: ExportManifest = {
      generatedAt: new Date().toISOString(),
      startUrl: this.#options.startUrl.toString(),
      sitemapRoutes,
      routes,
      assets: this.#archive.assets,
      skipped: this.#archive.skipped,
      externalUrls: await this.#collectExternalUrls(),
      warnings: this.#warnings,
    };

    await writeFile(
      path.join(this.#options.outputDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    this.#reportProgress("finalizing");

    return manifest;
  }

  async #writeRoute(localPath: string, html: string): Promise<void> {
    const absolutePath = path.join(this.#options.outputDir, ...localPath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, html, "utf8");
  }

  async #rewriteCapturedAssets(): Promise<void> {
    const processed = new Set<string>();

    for (;;) {
      const batch = this.#archive.assets.filter((asset) => !processed.has(asset.sourceUrl) && this.#isTextAsset(asset.contentType, asset.localPath));
      if (batch.length === 0) {
        return;
      }

      await runWithConcurrency(batch, MAX_TEXT_ASSET_REWRITE_CONCURRENCY, async (asset) => {
        processed.add(asset.sourceUrl);
        await this.#rewriteCapturedAsset(asset);
      });
    }
  }

  async #rewriteCapturedAsset(asset: CapturedAsset): Promise<void> {
    if (!this.#shouldRewriteAssetText(asset)) {
      return;
    }

    const absolutePath = this.#absoluteOutputPath(asset.localPath);
    const text = await readFile(absolutePath, "utf8");
    await this.#fetcher.fetchMissing(this.#rewriter.collectTextAssetUrls(text, asset.sourceUrl), (sourceUrl) => {
      this.#assetFetchesCompleted += 1;
      this.#reportProgress("fetching", sourceUrl);
    });
    const rewritten = /text\/css/i.test(asset.contentType)
      ? this.#rewriter.rewriteCss(text, asset.sourceUrl, asset.localPath)
      : this.#rewriter.rewriteCapturedText(text, asset.sourceUrl, asset.localPath);
    await this.#writeAssetCopies(asset.sourceUrl, rewritten);
  }

  async #writeAssetCopies(sourceUrl: string, text: string): Promise<void> {
    await Promise.all(
      this.#archive.localPathsFor(sourceUrl).map((localPath) => writeFile(this.#absoluteOutputPath(localPath), text, "utf8")),
    );
  }

  #absoluteOutputPath(localPath: string): string {
    return path.join(this.#options.outputDir, ...localPath.split("/"));
  }

  #shouldRewriteAssetText(asset: CapturedAsset): boolean {
    try {
      const host = new URL(asset.sourceUrl).host;
      return host !== "app.framerstatic.com" && host !== "framer.com";
    } catch {
      return false;
    }
  }

  #shouldSkipTextScanDirectory(directoryPath: string): boolean {
    const relativePath = path.relative(this.#options.outputDir, directoryPath).replace(/\\/g, "/");
    return relativePath === "assets/app.framerstatic.com" || relativePath === "assets/framer.com";
  }

  #isTextAsset(contentType: string, localPath: string): boolean {
    if (/\.(redstonecms|framercms)$/i.test(localPath)) {
      return false;
    }
    return /text\/css|javascript|application\/json|manifest\+json/i.test(contentType) || /\.(js|mjs|css|json)$/i.test(localPath);
  }

  #addRuntimeWarnings(): void {
    this.#warnings.push(
      "Dynamic Framer backends such as forms, search, ecommerce, auth, analytics, or CMS mutations are not recreated by this static export.",
    );
    if (this.#archive.skipped.length > 0) {
      this.#warnings.push("Some responses were skipped. Review manifest.json before deploying the export.");
    }
    if (this.#options.maxPages !== undefined) {
      this.#warnings.push(`Route export was capped at --max-pages ${this.#options.maxPages}.`);
    }
  }

  #isPageLimitReached(routeCount: number): boolean {
    return this.#options.maxPages !== undefined && routeCount >= this.#options.maxPages;
  }

  #reportProgress(phase: ExportProgress["phase"], currentUrl?: string): void {
    this.#options.onProgress?.({
      phase,
      routesCompleted: this.#routesCompleted,
      assetFetchesCompleted: this.#assetFetchesCompleted,
      assetsSaved: this.#archive.assets.length,
      skippedResponses: this.#archive.skipped.length,
      currentUrl,
    });
  }

  async #collectExternalUrls(): Promise<string[]> {
    const urls = new Set<string>();
    const files = await this.#listTextFiles(this.#options.outputDir);
    await runWithConcurrency(files, MAX_EXTERNAL_URL_SCAN_CONCURRENCY, async (filePath) => {
      const text = await readFile(filePath, "utf8");
      for (const url of this.#rewriter.collectExternalUrls(text)) {
        urls.add(url);
      }
    });
    return [...urls].sort();
  }

  async #listTextFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (this.#shouldSkipTextScanDirectory(entryPath)) {
          continue;
        }
        files.push(...(await this.#listTextFiles(entryPath)));
      } else if (/\.(html|css|js|mjs|json)$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }

    return files;
  }
}

