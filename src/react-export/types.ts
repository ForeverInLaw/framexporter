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
};
