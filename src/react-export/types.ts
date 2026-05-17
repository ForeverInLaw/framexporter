import type { ExportManifest } from "../core/types.js";

export type ReactExportOptions = {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly appName: string;
};

export type ReactRouteSource = {
  readonly sourceUrl: string;
  readonly localPath: string;
  readonly routePath: string;
  readonly componentName: string;
  readonly fileName: string;
  readonly html: string;
};

export type ReactExportSource = {
  readonly manifest: ExportManifest | undefined;
  readonly routes: ReactRouteSource[];
};

export type ConvertedPage = {
  readonly route: ReactRouteSource;
  readonly jsx: string;
  readonly css: string;
  readonly componentImports: string[];
};

export type SharedComponent = {
  readonly name: string;
  readonly fileName: string;
  readonly body: string;
  readonly occurrenceCount: number;
  readonly props?: string[];
  readonly propSlotIndexes?: number[];
  readonly propSamples?: readonly string[][];
};

export type RuntimeMarkerCounts = {
  readonly transitions: number;
  readonly variants: number;
  readonly gestures: number;
  readonly scroll: number;
  readonly slideshows: number;
  readonly forms: number;
  readonly cms: number;
};

export type RuntimeChunkSummary = {
  readonly path: string;
  readonly bytes: number;
  readonly sha1: string;
  readonly score: number;
  readonly markers: RuntimeMarkerCounts;
  readonly samples: readonly string[];
};

export type FramerRuntimeAnalysis = {
  readonly version: 1;
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly markerTotals: RuntimeMarkerCounts;
  readonly chunks: readonly RuntimeChunkSummary[];
};
