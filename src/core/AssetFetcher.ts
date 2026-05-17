import type { ResponseArchive } from "./ResponseArchive.js";

export class AssetFetcher {
  constructor(private readonly archive: ResponseArchive) {}

  async fetchMissing(urls: string[]): Promise<void> {
    for (const url of urls) {
      if (this.archive.has(url)) {
        continue;
      }
      await this.#fetchOne(url);
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
