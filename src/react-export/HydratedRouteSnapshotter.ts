import { chromium, type Browser, type Page } from "playwright";
import { StaticPreviewServer } from "../core/StaticPreviewServer.js";
import type { ReactRouteSource } from "./types.js";

export type HydratedRouteSnapshotOptions = {
  readonly rootDir: string;
  readonly waitMs?: number;
};

const DEFAULT_WAIT_MS = 1800;

export class HydratedRouteSnapshotter {
  readonly #rootDir: string;
  readonly #waitMs: number;

  constructor(options: HydratedRouteSnapshotOptions) {
    this.#rootDir = options.rootDir;
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  async snapshot(routes: ReactRouteSource[]): Promise<ReactRouteSource[]> {
    const server = new StaticPreviewServer({ rootDir: this.#rootDir, host: "127.0.0.1", port: 0 });
    const baseUrl = await server.start();
    const browser = await chromium.launch({ headless: true });

    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
      return await this.#snapshotRoutes(page, baseUrl, routes);
    } finally {
      await browser.close();
      await server.stop();
    }
  }

  async #snapshotRoutes(page: Page, baseUrl: string, routes: ReactRouteSource[]): Promise<ReactRouteSource[]> {
    const snapshots: ReactRouteSource[] = [];
    for (const route of routes) {
      const hydratedHtml = await this.#snapshotRoute(page, baseUrl, route);
      snapshots.push({ ...route, html: hydratedHtml });
    }
    return snapshots;
  }

  async #snapshotRoute(page: Page, baseUrl: string, route: ReactRouteSource): Promise<string> {
    await page.goto(new URL(route.routePath, baseUrl).toString(), { waitUntil: "networkidle" });
    await page.evaluate(async (waitMs) => {
      const browserGlobal = globalThis as typeof globalThis & { document: any; window: any };
      await browserGlobal.document.fonts?.ready.catch(() => undefined);
      await new Promise((resolve) => browserGlobal.window.setTimeout(resolve, waitMs));
      for (const animation of browserGlobal.document.getAnimations({ subtree: true })) {
        try {
          if (animation.playState !== "idle") {
            animation.finish();
          }
        } catch {
          continue;
        }
      }
    }, this.#waitMs);
    await page.waitForTimeout(100);
    return await page.evaluate(() => (globalThis as typeof globalThis & { document: any }).document.documentElement.outerHTML);
  }
}

