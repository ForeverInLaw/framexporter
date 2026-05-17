import path from "node:path";
import { ComponentExtractor } from "./ComponentExtractor.js";
import { HtmlToTsxConverter } from "./HtmlToTsxConverter.js";
import { PropComponentExtractor } from "./PropComponentExtractor.js";
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
  readonly #propExtractor = new PropComponentExtractor();
  readonly #exactExtractor = new ComponentExtractor();
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
    const propProject = this.#propExtractor.extract(rawPages);
    const exactProject = this.#exactExtractor.extract(propProject.pages);
    const components = [...propProject.components, ...exactProject.components];
    await this.#writer.write(exactProject.pages, components);

    return {
      routes: exactProject.pages.length,
      components: components.length,
      outputDir: this.#options.outputDir,
      warnings: [
        "Clean React export is experimental: complex Framer interactions, CMS queries, forms, ecommerce, and custom runtime animations are not reconstructed yet.",
        "Generated components use conservative prop inference for repeated JSX shapes; semantic naming is planned as a later compiler pass.",
      ],
    };
  }
}
