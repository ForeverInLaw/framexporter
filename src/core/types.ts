export type ExportOptions = {
  readonly startUrl: URL;
  readonly outputDir: string;
  readonly maxPages: number;
  readonly waitMs: number;
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
  readonly routes: ExportedRoute[];
  readonly assets: CapturedAsset[];
  readonly skipped: SkippedAsset[];
  readonly warnings: string[];
};

export type RenderedPage = {
  readonly url: string;
  readonly html: string;
};
