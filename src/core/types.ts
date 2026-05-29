export type ExportProgressPhase = "rendering" | "fetching" | "finalizing";

export type ExportProgress = {
  readonly phase: ExportProgressPhase;
  readonly routesCompleted: number;
  readonly assetFetchesCompleted: number;
  readonly assetsSaved: number;
  readonly skippedResponses: number;
  readonly currentUrl?: string;
};

export type ExportProgressReporter = (progress: ExportProgress) => void;

export type ExportOptions = {
  readonly startUrl: URL;
  readonly outputDir: string;
  readonly maxPages: number | undefined;
  readonly waitMs: number;
  readonly renderConcurrency: number;
  readonly onProgress?: ExportProgressReporter;
};

export type CapturedAsset = {
  readonly sourceUrl: string;
  readonly localPath: string;
  readonly contentType: string;
  readonly byteLength: number;
};

export type SkippedAsset = {
  readonly sourceUrl: string;
  readonly reason: string;
};

export type ExportedRoute = {
  readonly sourceUrl: string;
  readonly localPath: string;
  readonly discoveredLinks: string[];
};

export type ExportManifest = {
  readonly generatedAt: string;
  readonly startUrl: string;
  readonly sitemapRoutes: string[];
  readonly routes: ExportedRoute[];
  readonly assets: CapturedAsset[];
  readonly skipped: SkippedAsset[];
  readonly externalUrls: string[];
  readonly warnings: string[];
};

export type RenderedPage = {
  readonly url: string;
  readonly html: string;
};
