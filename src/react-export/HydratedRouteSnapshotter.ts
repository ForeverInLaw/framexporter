import { chromium, type Page } from "playwright";
import { StaticPreviewServer } from "../core/StaticPreviewServer.js";
import type { ReactRouteSource } from "./types.js";

export type HydratedRouteSnapshotOptions = {
  readonly rootDir: string;
  readonly waitMs?: number;
};

const DEFAULT_WAIT_MS = 1200;
const SCROLL_STEP_RATIO = 0.75;
const SCROLL_WAIT_MS = 120;

type BrowserGlobal = typeof globalThis & {
  readonly document: any;
  readonly window: any;
};

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
    await this.#waitForHydration(page);
    await this.#markMotionTargets(page);
    await this.#triggerScrollAnimations(page);
    await this.#finishDocumentAnimations(page);
    await this.#finalizeMotionTargets(page);
    return await page.evaluate(() => (globalThis as BrowserGlobal).document.documentElement.outerHTML);
  }

  async #waitForHydration(page: Page): Promise<void> {
    await page.evaluate(async (waitMs) => {
      const browserGlobal = globalThis as BrowserGlobal;
      await browserGlobal.document.fonts?.ready.catch(() => undefined);
      await new Promise((resolve) => browserGlobal.window.setTimeout(resolve, waitMs));
    }, this.#waitMs);
  }

  async #markMotionTargets(page: Page): Promise<void> {
    await page.evaluate(() => {
      const browserGlobal = globalThis as BrowserGlobal;
      const elements = Array.from(browserGlobal.document.querySelectorAll("[data-framer-appear-id], [style*='opacity: 0'], [style*='opacity:0']"));
      for (const rawElement of elements) {
        const element = rawElement as any;
        if (element.closest("[aria-hidden='true']")) {
          continue;
        }

        const className = typeof element.className === "string" ? element.className : "";
        const isFramerElement = className.includes("framer-") || element.hasAttribute("data-framer-name") || element.hasAttribute("data-framer-component-type");
        if (!isFramerElement) {
          continue;
        }

        const style = element.getAttribute("style") ?? "";
        const hasAppearId = element.hasAttribute("data-framer-appear-id");
        const hasEntranceStyle = /opacity\s*:\s*0(?:\.0+)?\b/i.test(style) && /translate(?:3d|x|y)?\(/i.test(style);
        if (!hasAppearId && !hasEntranceStyle) {
          continue;
        }

        element.dataset.framexporterMotion = inferMotionName(style);
      }

      function inferMotionName(style: string): string {
        const lower = style.toLowerCase();
        if (/translatex\(-/.test(lower) || /translate3d\(-/.test(lower)) {
          return "fade-right";
        }
        if (/translatex\(/.test(lower) || /translate3d\(/.test(lower)) {
          return "fade-left";
        }
        return "fade-up";
      }
    });
  }

  async #triggerScrollAnimations(page: Page): Promise<void> {
    await page.evaluate(async ({ stepRatio, waitMs }) => {
      const browserGlobal = globalThis as BrowserGlobal;
      const maxScroll = Math.max(0, browserGlobal.document.documentElement.scrollHeight - browserGlobal.window.innerHeight);
      const step = Math.max(360, Math.floor(browserGlobal.window.innerHeight * stepRatio));
      for (let y = 0; y <= maxScroll; y += step) {
        browserGlobal.window.scrollTo(0, y);
        await new Promise((resolve) => browserGlobal.window.setTimeout(resolve, waitMs));
      }
      browserGlobal.window.scrollTo(0, maxScroll);
      await new Promise((resolve) => browserGlobal.window.setTimeout(resolve, waitMs));
      browserGlobal.window.scrollTo(0, 0);
      await new Promise((resolve) => browserGlobal.window.setTimeout(resolve, waitMs));
    }, { stepRatio: SCROLL_STEP_RATIO, waitMs: SCROLL_WAIT_MS });
  }

  async #finishDocumentAnimations(page: Page): Promise<void> {
    await page.evaluate(() => {
      const browserGlobal = globalThis as BrowserGlobal;
      for (const animation of browserGlobal.document.getAnimations({ subtree: true })) {
        try {
          if (animation.playState !== "idle") {
            animation.finish();
          }
        } catch {
          continue;
        }
      }
    });
    await page.waitForTimeout(100);
  }

  async #finalizeMotionTargets(page: Page): Promise<void> {
    await page.evaluate(() => {
      const browserGlobal = globalThis as BrowserGlobal;
      const targets = Array.from(browserGlobal.document.querySelectorAll("[data-framexporter-motion]"));
      targets.forEach((rawElement, index) => {
        const element = rawElement as any;
        element.style.opacity = "1";
        element.style.transform = "none";
        element.style.visibility = "visible";
        element.style.setProperty("--framexporter-motion-delay", `${Math.min(index * 35, 420)}ms`);
      });
    });
  }
}
