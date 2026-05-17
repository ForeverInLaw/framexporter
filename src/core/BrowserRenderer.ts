import { chromium, type Browser, type Page, type Response } from "playwright";
import type { ResponseArchive } from "./ResponseArchive.js";
import type { RenderedPage } from "./types.js";

type BrowserRendererOptions = {
  readonly waitMs: number;
};

export class BrowserRenderer {
  readonly #archive: ResponseArchive;
  readonly #waitMs: number;
  #browser: Browser | undefined;

  constructor(archive: ResponseArchive, options: BrowserRendererOptions) {
    this.#archive = archive;
    this.#waitMs = options.waitMs;
  }

  async start(): Promise<void> {
    this.#browser = await chromium.launch({ headless: true });
  }

  async stop(): Promise<void> {
    await this.#browser?.close();
    this.#browser = undefined;
  }

  async render(url: string): Promise<RenderedPage> {
    if (!this.#browser) {
      throw new Error("BrowserRenderer must be started before render().");
    }

    const page = await this.#browser.newPage();
    const pendingResponses = new Set<Promise<void>>();
    page.on("response", (response) => {
      const capture = this.#captureResponse(response).catch((error: unknown) => {
        this.#archive.skip(response.url(), error instanceof Error ? error.message : "response capture failed");
      });
      pendingResponses.add(capture);
      capture.finally(() => pendingResponses.delete(capture));
    });

    try {
      const documentResponse = await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
      await page.waitForTimeout(this.#waitMs);
      await Promise.allSettled([...pendingResponses]);
      return { url: page.url(), html: await this.#documentHtml(documentResponse, page) };
    } finally {
      await page.close();
    }
  }

  async #documentHtml(response: Response | null, page: Page): Promise<string> {
    if (!response?.ok()) {
      return page.content();
    }

    const contentType = response.headers()["content-type"] ?? "";
    if (!/text\/html/i.test(contentType)) {
      return page.content();
    }

    return response.text();
  }

  #shouldSkipCapturedAsset(sourceUrl: string): boolean {
    try {
      return new URL(sourceUrl).pathname.endsWith(".framercms");
    } catch {
      return false;
    }
  }

  async #captureResponse(response: Response): Promise<void> {
    const request = response.request();
    if (!response.ok() || response.status() === 206 || request.method() !== "GET" || request.resourceType() === "document") {
      return;
    }

    const sourceUrl = response.url();
    if (!/^https?:\/\//i.test(sourceUrl) || this.#shouldSkipCapturedAsset(sourceUrl)) {
      return;
    }

    const headers = response.headers();
    const contentType = headers["content-type"]?.split(";")[0]?.trim() ?? "";
    const body = await response.body();
    await this.#archive.store({ sourceUrl, contentType, body });
  }
}
