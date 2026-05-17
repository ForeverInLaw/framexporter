import path from "node:path";
import { HtmlToTsxConverter } from "./HtmlToTsxConverter.js";
import { StaticExportReader } from "./StaticExportReader.js";
import type { ConvertedPage, ReactExportOptions } from "./types.js";
import { ViteReactProjectWriter } from "./ViteReactProjectWriter.js";

export type ReactExportResult = {
  readonly routes: number;
  readonly outputDir: string;
  readonly warnings: string[];
};

export class ReactExportJob {
  readonly #reader: StaticExportReader;
  readonly #converter = new HtmlToTsxConverter();
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

    const pages: ConvertedPage[] = source.routes.map((route) => this.#converter.convert(route));
    await this.#writer.write(pages);

    return {
      routes: pages.length,
      outputDir: this.#options.outputDir,
      warnings: [
        "Clean React export is experimental: complex Framer interactions, CMS queries, forms, ecommerce, and custom runtime animations are not reconstructed yet.",
        "Generated JSX preserves rendered structure and CSS; semantic component extraction is planned as a separate compiler pass.",
      ],
    };
  }
}
