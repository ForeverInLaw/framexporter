import type { ResponseArchive } from "./ResponseArchive.js";
import { runWithConcurrency } from "./runWithConcurrency.js";

const MAX_CONCURRENT_FETCHES = 8;

export class AssetFetcher {
  readonly #pending = new Map<string, Promise<void>>();

  constructor(private readonly archive: ResponseArchive) {}

  async fetchMissing(urls: string[]): Promise<void> {
    const uniqueUrls = [...new Set(urls)].filter((url) => !this.archive.has(url));
    await runWithConcurrency(uniqueUrls, MAX_CONCURRENT_FETCHES, async (sourceUrl) => {
      await this.#fetchDeduped(sourceUrl);
    });
  }

  async #fetchDeduped(sourceUrl: string): Promise<void> {
    const pending = this.#pending.get(sourceUrl);
    if (pending) {
      await pending;
      return;
    }

    const task = this.#fetchOne(sourceUrl);
    this.#pending.set(sourceUrl, task);
    try {
      await task;
    } finally {
      this.#pending.delete(sourceUrl);
    }
  }

  async #fetchOne(sourceUrl: string): Promise<void> {
    try {
      const response = await fetch(sourceUrl, { redirect: "follow" });
      if (!response.ok) {
        this.archive.skip(sourceUrl, `static fetch failed: ${response.status}`);
        return;
      }

      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const body = Buffer.from(await response.arrayBuffer());
      await this.archive.store({ sourceUrl, contentType, body });
    } catch (error: unknown) {
      this.archive.skip(sourceUrl, error instanceof Error ? error.message : "static fetch failed");
    }
  }
}
