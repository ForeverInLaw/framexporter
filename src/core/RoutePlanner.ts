import * as cheerio from "cheerio";

export class RoutePlanner {
  readonly #startOrigin: string;
  readonly #onEnqueue?: (url: string) => void;
  readonly #queue: string[] = [];
  readonly #queued = new Set<string>();
  readonly #visited = new Set<string>();

  constructor(startUrl: URL, onEnqueue?: (url: string) => void) {
    this.#startOrigin = startUrl.origin;
    this.#onEnqueue = onEnqueue;
    this.enqueue(startUrl.toString());
  }

  next(): string | undefined {
    return this.#queue.shift();
  }

  markVisited(url: string): void {
    this.#visited.add(this.#normalize(url));
  }

  enqueue(url: string): boolean {
    const normalized = this.#normalize(url);
    if (!normalized || this.#queued.has(normalized) || this.#visited.has(normalized)) {
      return false;
    }
    this.#queued.add(normalized);
    this.#queue.push(normalized);
    this.#onEnqueue?.(normalized);
    return true;
  }

  enqueueAll(urls: string[]): string[] {
    return urls.filter((url) => this.enqueue(url));
  }

  discover(html: string, pageUrl: string): string[] {
    const $ = cheerio.load(html);
    const links: string[] = [];

    $("a[href], link[rel='alternate'][href]").each((_, element) => {
      const href = $(element).attr("href");
      if (!href) {
        return;
      }
      const absolute = this.#normalize(new URL(href, pageUrl).toString());
      if (absolute && this.enqueue(absolute)) {
        links.push(absolute);
      }
    });

    return links;
  }

  #normalize(rawUrl: string): string {
    const parsed = new URL(rawUrl);
    if (parsed.origin !== this.#startOrigin || !/^https?:$/i.test(parsed.protocol)) {
      return "";
    }

    if (parsed.pathname.split("/").some((segment) => segment.startsWith(":"))) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  }
}
