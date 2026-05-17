import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AssetFetcher } from "./AssetFetcher.js";
import { AssetRewriter } from "./AssetRewriter.js";
import { BrowserRenderer } from "./BrowserRenderer.js";
import { ResponseArchive } from "./ResponseArchive.js";
import { RoutePathMapper } from "./RoutePathMapper.js";
import { RoutePlanner } from "./RoutePlanner.js";
import { SitemapDiscoverer } from "./SitemapDiscoverer.js";
import type { ExportManifest, ExportOptions, ExportedRoute } from "./types.js";

export class ExportJob {
  readonly #options: ExportOptions;
  readonly #archive: ResponseArchive;
  readonly #fetcher: AssetFetcher;
  readonly #rewriter: AssetRewriter;
  readonly #renderer: BrowserRenderer;
  readonly #routePaths: RoutePathMapper;
  readonly #sitemapDiscoverer = new SitemapDiscoverer();
  readonly #warnings: string[] = [];

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

    await this.#renderer.start();
    try {
      while (!this.#isPageLimitReached(routes.length)) {
        const nextUrl = planner.next();
        if (!nextUrl) {
          break;
        }

        planner.markVisited(nextUrl);
        const rendered = await this.#renderer.render(nextUrl);
        const discoveredLinks = planner.discover(rendered.html, rendered.url);
        this.#routePaths.registerAll(discoveredLinks);
        const staticUrls = this.#rewriter.collectHtmlAssetUrls(rendered.html, rendered.url);
        await this.#fetcher.fetchMissing(staticUrls);
        const localPath = this.#routePaths.register(nextUrl) ?? "index.html";
        const rewrittenHtml = this.#rewriter.rewriteHtml(rendered.html, rendered.url, localPath);
        await this.#writeRoute(localPath, rewrittenHtml);

        routes.push({ sourceUrl: rendered.url, localPath, discoveredLinks });
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
      const asset = this.#archive.assets.find((asset) => !processed.has(asset.sourceUrl) && this.#isTextAsset(asset.contentType, asset.localPath));
      if (!asset) {
        return;
      }

      processed.add(asset.sourceUrl);
      const absolutePath = this.#absoluteOutputPath(asset.localPath);
      const text = await readFile(absolutePath, "utf8");
      await this.#fetcher.fetchMissing(this.#rewriter.collectTextAssetUrls(text, asset.sourceUrl));
      const rewritten = /text\/css/i.test(asset.contentType)
        ? this.#rewriter.rewriteCss(text, asset.sourceUrl, asset.localPath)
        : this.#rewriter.rewriteCapturedText(text, asset.sourceUrl, asset.localPath);
      await this.#writeAssetCopies(asset.sourceUrl, rewritten);
    }
  }

  async #writeAssetCopies(sourceUrl: string, text: string): Promise<void> {
    for (const localPath of this.#archive.localPathsFor(sourceUrl)) {
      await writeFile(this.#absoluteOutputPath(localPath), text, "utf8");
    }
  }

  #absoluteOutputPath(localPath: string): string {
    return path.join(this.#options.outputDir, ...localPath.split("/"));
  }

  #isTextAsset(contentType: string, localPath: string): boolean {
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

  async #collectExternalUrls(): Promise<string[]> {
    const urls = new Set<string>();
    for (const filePath of await this.#listTextFiles(this.#options.outputDir)) {
      const text = await readFile(filePath, "utf8");
      for (const url of this.#rewriter.collectExternalUrls(text)) {
        urls.add(url);
      }
    }
    return [...urls].sort();
  }

  async #listTextFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await this.#listTextFiles(entryPath)));
      } else if (/\.(html|css|js|mjs|json)$/i.test(entry.name)) {
        files.push(entryPath);
      }
    }

    return files;
  }
}

