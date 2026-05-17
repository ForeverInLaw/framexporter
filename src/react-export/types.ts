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

export type RuntimeComponentModel = {
  readonly chunkPath: string;
  readonly symbol: string;
  readonly displayName: string;
  readonly rootClass?: string;
  readonly defaultVariant?: string;
  readonly variantClassMap: Readonly<Record<string, string>>;
  readonly variantStyleTargets: readonly RuntimeVariantStyleTarget[];
  readonly transition?: Readonly<Record<string, string | number | boolean>>;
  readonly enabledGestures: RuntimeEnabledGestures;
  readonly gestureCounts: {
    readonly whileHover: number;
    readonly whileTap: number;
    readonly hover: number;
    readonly tap: number;
  };
};

export type RuntimeEnabledGestures = {
  readonly hover: boolean;
  readonly tap: boolean;
};

export type RuntimeVariantStyleTarget = {
  readonly variant: string;
  readonly state: "hover" | "tap";
  readonly targetClass: string;
  readonly styles: Readonly<Record<string, string | number | boolean>>;
};

export type RuntimeChunkSummary = {
  readonly path: string;
  readonly bytes: number;
  readonly sha1: string;
  readonly score: number;
  readonly markers: RuntimeMarkerCounts;
  readonly samples: readonly string[];
  readonly componentModels: readonly RuntimeComponentModel[];
};

export type FramerRuntimeAnalysis = {
  readonly version: 1;
  readonly chunkCount: number;
  readonly totalBytes: number;
  readonly markerTotals: RuntimeMarkerCounts;
  readonly chunks: readonly RuntimeChunkSummary[];
  readonly componentModels: readonly RuntimeComponentModel[];
};
