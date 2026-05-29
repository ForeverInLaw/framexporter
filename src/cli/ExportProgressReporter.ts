import type { ExportProgress } from "../core/types.js";

export class ExportProgressReporter {
  readonly #stream: NodeJS.WriteStream;
  #lastLength = 0;
  #finished = false;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.#stream = stream;
  }

  update(progress: ExportProgress): void {
    const message = this.#format(progress);

    if (!this.#stream.isTTY) {
      this.#stream.write(`${message}\n`);
      return;
    }

    const padded = message.padEnd(this.#lastLength, " ");
    this.#stream.write(`\r${padded}`);
    this.#lastLength = Math.max(this.#lastLength, message.length);
  }

  finish(): void {
    if (this.#finished || !this.#stream.isTTY) {
      return;
    }

    this.#stream.write("\n");
    this.#finished = true;
  }

  #format(progress: ExportProgress): string {
    const phaseLabels: Record<ExportProgress["phase"], string> = {
      rendering: "rendering",
      fetching: "fetching",
      finalizing: "finalizing",
    };

    const fragments = [
      `[export] ${phaseLabels[progress.phase]}`,
      `routes ${progress.routesCompleted}`,
      `asset fetches ${progress.assetFetchesCompleted}`,
      `saved ${progress.assetsSaved}`,
      `skipped ${progress.skippedResponses}`,
    ];

    if (progress.currentUrl) {
      fragments.push(progress.currentUrl);
    }

    return fragments.join(" | ");
  }
}