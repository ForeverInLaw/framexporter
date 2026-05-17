import path from "node:path";
import { ComponentExtractor } from "./ComponentExtractor.js";
import { HtmlToTsxConverter } from "./HtmlToTsxConverter.js";
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
  readonly #converter = new HtmlToTsxConverter();
  readonly #extractor = new ComponentExtractor();
  readonly #writer: ViteReactProjectWriter;
  readonly #options: ReactExportOptions;

  constructor(options: ReactExportOptions) {
    this.#options = options;
    this.#reader = new StaticExportReader(options.inputDir);
    this.#writer = new ViteReactProjectWriter(options);
  }

  async run(): Promise<ReactExportResult> {
    const source = await this.#reader.read();
    if (source.routes.length === 0) {
      throw new Error(`No HTML routes found in ${path.resolve(this.#options.inputDir)}.`);
    }

    const rawPages: ConvertedPage[] = source.routes.map((route) => this.#converter.convert(route));
    const project = this.#extractor.extract(rawPages);
    await this.#writer.write(project.pages, project.components);

    return {
      routes: project.pages.length,
      components: project.components.length,
      outputDir: this.#options.outputDir,
      warnings: [
        "Clean React export is experimental: complex Framer interactions, CMS queries, forms, ecommerce, and custom runtime animations are not reconstructed yet.",
        "Generated components are exact repeated JSX subtrees; prop inference and semantic naming are planned as later compiler passes.",
      ],
    };
  }
}
