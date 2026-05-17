import path from "node:path";
import { ComponentExtractor } from "./ComponentExtractor.js";
import { HtmlToTsxConverter } from "./HtmlToTsxConverter.js";
import { HydratedRouteSnapshotter } from "./HydratedRouteSnapshotter.js";
import { PropComponentExtractor } from "./PropComponentExtractor.js";
import { SemanticComponentNamer } from "./SemanticComponentNamer.js";
import { StaticExportReader } from "./StaticExportReader.js";
import type { ConvertedPage, ReactExportOptions } from "./types.js";
import { ViteReactProjectWriter } from "./ViteReactProjectWriter.js";

export type ReactExportResult = {
  readonly routes: number;
  readonly components: number;
  readonly outputDir: string;
  readonly warnings: string[];
};

export class ReactExportJob {
  readonly #reader: StaticExportReader;
  readonly #snapshotter: HydratedRouteSnapshotter;
  readonly #converter = new HtmlToTsxConverter();
  readonly #propExtractor = new PropComponentExtractor();
  readonly #exactExtractor = new ComponentExtractor();
  readonly #namer = new SemanticComponentNamer();
  readonly #writer: ViteReactProjectWriter;
  readonly #options: ReactExportOptions;

  constructor(options: ReactExportOptions) {
    this.#options = options;
    this.#reader = new StaticExportReader(options.inputDir);
    this.#snapshotter = new HydratedRouteSnapshotter({ rootDir: options.inputDir });
    this.#writer = new ViteReactProjectWriter(options);
  }

  async run(): Promise<ReactExportResult> {
    const source = await this.#reader.read();
    if (source.routes.length === 0) {
      throw new Error(`No HTML routes found in ${path.resolve(this.#options.inputDir)}.`);
    }

    const hydratedRoutes = await this.#snapshotter.snapshot(source.routes);
    const rawPages: ConvertedPage[] = hydratedRoutes.map((route) => this.#converter.convert(route));
    const propProject = this.#propExtractor.extract(rawPages);
    const exactProject = this.#exactExtractor.extract(propProject.pages);
    const namedProject = this.#namer.rename(exactProject.pages, [...propProject.components, ...exactProject.components]);
    await this.#writer.write(namedProject.pages, namedProject.components);

    return {
      routes: namedProject.pages.length,
      components: namedProject.components.length,
      outputDir: this.#options.outputDir,
      warnings: [
        "Clean React export is experimental: complex Framer interactions, CMS queries, forms, ecommerce, and custom runtime animations are not reconstructed yet.",
        "React export is generated from hydrated browser DOM snapshots, then scripts are removed and visible final states are preserved.",
      ],
    };
  }
}
