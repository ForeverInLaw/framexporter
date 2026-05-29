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
const DEFAULT_RENDER_CONCURRENCY = 5;

export class ExportJob {
  readonly #options: ExportOptions;
  readonly #archive: ResponseArchive;
  readonly #fetcher: AssetFetcher;
  readonly #rewriter: AssetRewriter;
  readonly #renderer: BrowserRenderer;
  readonly #routePaths: RoutePathMapper;
  readonly #sitemapDiscoverer = new SitemapDiscoverer();
  readonly #warnings: string[] = [];
  readonly #crawlWaiters: Array<() => void> = [];
  readonly #renderConcurrency: number;
  #routesCompleted = 0;
  #assetFetchesCompleted = 0;
  #routesScheduled = 0;
  #routesInFlight = 0;
  #crawlFailure: Error | undefined;

  constructor(options: ExportOptions) {
    this.#options = options;
    this.#renderConcurrency = Math.max(1, options.renderConcurrency || DEFAULT_RENDER_CONCURRENCY);
    this.#archive = new ResponseArchive(options.outputDir);
    this.#fetcher = new AssetFetcher(this.#archive);
    this.#routePaths = new RoutePathMapper(options.startUrl);
    this.#rewriter = new AssetRewriter(this.#archive, this.#routePaths);
    this.#renderer = new BrowserRenderer(this.#archive, { waitMs: options.waitMs });
  }

  async run(): Promise<ExportManifest> {
    await mkdir(this.#options.outputDir, { recursive: true });
    const activeLocales = new Set<string>();
    const planner = new RoutePlanner(this.#options.startUrl, () => this.#signalCrawlWork());
    this.#routePaths.register(this.#options.startUrl.toString());
    const discoveredSitemapUrls = await this.#sitemapDiscoverer.discover(this.#options.startUrl);
    this.#routePaths.registerAll(discoveredSitemapUrls);
    const sitemapRoutes = planner.enqueueAll(discoveredSitemapUrls);

    // Enqueue default 404 page
    const default404 = new URL("/404", this.#options.startUrl);
    planner.enqueue(default404.toString());
    this.#routePaths.register(default404.toString());

    // Detect locales from sitemap URLs
    for (const urlStr of [this.#options.startUrl.toString(), ...discoveredSitemapUrls]) {
      this.#enqueueLocalized404(planner, activeLocales, urlStr);
    }

    await this.#renderer.start();
    try {
      this.#reportProgress("rendering", this.#options.startUrl.toString());
      const routes = await this.#crawlRoutes(planner, activeLocales);
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
    } finally {
      await this.#renderer.stop();
    }
  }

  async #writeRoute(localPath: string, html: string): Promise<void> {
    const absolutePath = path.join(this.#options.outputDir, ...localPath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, html, "utf8");
  }

  async #crawlRoutes(planner: RoutePlanner, activeLocales: Set<string>): Promise<ExportedRoute[]> {
    const completedRoutes: Array<{ readonly order: number; readonly route: ExportedRoute }> = [];
    const workers = Array.from({ length: this.#renderConcurrency }, async () => {
      await this.#crawlWorker(planner, activeLocales, completedRoutes);
    });
    await Promise.allSettled(workers);

    if (this.#crawlFailure) {
      throw this.#crawlFailure;
    }

    const sortedRoutes = completedRoutes.sort((left, right) => left.order - right.order);
    return sortedRoutes.map((entry) => entry.route);
  }

  async #crawlWorker(
    planner: RoutePlanner,
    activeLocales: Set<string>,
    completedRoutes: Array<{ readonly order: number; readonly route: ExportedRoute }>,
  ): Promise<void> {
    for (;;) {
      if (this.#crawlFailure) {
        return;
      }

      if (this.#isPageLimitReached(this.#routesScheduled)) {
        return;
      }

      const nextUrl = planner.next();
      if (!nextUrl) {
        if (this.#routesInFlight === 0) {
          return;
        }

        await this.#waitForCrawlWork();
        continue;
      }

      planner.markVisited(nextUrl);
      const routeOrder = this.#routesScheduled;
      this.#routesScheduled += 1;
      this.#routesInFlight += 1;
      this.#reportProgress("rendering", nextUrl);

      try {
        const route = await this.#crawlRoute(planner, activeLocales, nextUrl);
        completedRoutes.push({ order: routeOrder, route });
        this.#routesCompleted += 1;
        this.#reportProgress("rendering", route.sourceUrl);
      } catch (error: unknown) {
        this.#crawlFailure ??= error instanceof Error ? error : new Error(String(error));
        this.#signalCrawlWork();
        throw this.#crawlFailure;
      } finally {
        this.#routesInFlight -= 1;
        this.#signalCrawlWork();
      }
    }
  }

  async #crawlRoute(planner: RoutePlanner, activeLocales: Set<string>, nextUrl: string): Promise<ExportedRoute> {
    const rendered = await this.#renderer.render(nextUrl);
    const discoveredLinks = planner.discover(rendered.html, rendered.url);
    this.#routePaths.registerAll(discoveredLinks);

    for (const link of discoveredLinks) {
      this.#enqueueLocalized404(planner, activeLocales, link);
    }

    const staticUrls = this.#rewriter.collectHtmlAssetUrls(rendered.html, rendered.url);
    await this.#fetcher.fetchMissing(staticUrls, (sourceUrl) => {
      this.#assetFetchesCompleted += 1;
      this.#reportProgress("fetching", sourceUrl);
    });
    const localPath = this.#routePaths.register(nextUrl) ?? "index.html";
    const rewrittenHtml = this.#rewriter.rewriteHtml(rendered.html, rendered.url, localPath);
    await this.#writeRoute(localPath, rewrittenHtml);

    return { sourceUrl: rendered.url, localPath, discoveredLinks };
  }

  #enqueueLocalized404(planner: RoutePlanner, activeLocales: Set<string>, rawUrl: string): void {
    try {
      const parsed = new URL(rawUrl);
      const match = /^\/([a-z]{2}(?:-[a-zA-Z]{2,4})?)(?:\/|$)/.exec(parsed.pathname);
      if (!match) {
        return;
      }

      const locale = match[1];
      if (activeLocales.has(locale)) {
        return;
      }

      activeLocales.add(locale);
      const localized404 = new URL(`/${locale}/404`, this.#options.startUrl);
      planner.enqueue(localized404.toString());
      this.#routePaths.register(localized404.toString());
    } catch {
      return;
    }
  }

  async #waitForCrawlWork(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#crawlWaiters.push(resolve);
    });
  }

  #signalCrawlWork(): void {
    if (this.#crawlWaiters.length === 0) {
      return;
    }

    const waiters = this.#crawlWaiters.splice(0, this.#crawlWaiters.length);
    for (const resolve of waiters) {
      resolve();
    }
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
    const relativePath = path.relative(this.#options.outputDir, directoryPath).replaceAll("\\", "/");
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
    return [...urls].sort((left, right) => left.localeCompare(right));
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

