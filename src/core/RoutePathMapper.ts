import path from "node:path";

export class RoutePathMapper {
  readonly #origin: string;
  readonly #routes = new Map<string, string>();

  constructor(startUrl: URL) {
    this.#origin = startUrl.origin;
  }

  get entries(): ReadonlyArray<readonly [string, string]> {
    return [...this.#routes.entries()];
  }

  register(rawUrl: string): string | undefined {
    const normalized = this.#normalize(rawUrl);
    if (!normalized) {
      return undefined;
    }

    const localPath = this.#routePath(normalized);
    this.#routes.set(normalized, localPath);
    return localPath;
  }

  registerAll(rawUrls: string[]): void {
    for (const rawUrl of rawUrls) {
      this.register(rawUrl);
    }
  }

  localPathFor(rawUrl: string, baseUrl: string): string | undefined {
    if (this.#shouldIgnore(rawUrl)) {
      return undefined;
    }

    const normalized = this.#normalize(new URL(rawUrl, baseUrl).toString());
    return normalized ? this.#routes.get(normalized) : undefined;
  }

  hrefFor(fromLocalPath: string, targetLocalPath: string): string {
    const fromDirectory = path.posix.dirname(fromLocalPath);
    const targetRoutePath = this.#routeHrefPath(targetLocalPath);
    const relative = path.posix.relative(fromDirectory, targetRoutePath);

    if (!relative) {
      return "./";
    }
    if (relative === ".." || relative.startsWith("../")) {
      return relative;
    }
    return `./${relative}`;
  }

  #normalize(rawUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return "";
    }

    if (parsed.origin !== this.#origin || !/^https?:$/i.test(parsed.protocol)) {
      return "";
    }

    if (parsed.pathname.split("/").some((segment) => segment.startsWith(":"))) {
      return "";
    }

    parsed.hash = "";
    return parsed.toString();
  }

  #routePath(rawUrl: string): string {
    const parsed = new URL(rawUrl);
    const cleanSegments = parsed.pathname.split("/").filter(Boolean).map((segment) => this.#safeRouteSegment(segment));
    if (cleanSegments.length === 0) {
      return "index.html";
    }

    const cleanPath = cleanSegments.join("/");
    const extension = path.posix.extname(cleanPath);
    if (extension && extension !== ".") {
      return cleanPath;
    }

    return `${cleanPath}/index.html`;
  }

  #routeHrefPath(localPath: string): string {
    if (localPath === "index.html") {
      return "";
    }
    if (localPath.endsWith("/index.html")) {
      return localPath.slice(0, -"/index.html".length);
    }
    return localPath;
  }

  #safeRouteSegment(segment: string): string {
    return decodeURIComponent(segment)
      .replace(/[<>:"\\|?*\x00-\x1F]+/g, "-")
      .replace(/[. ]+$/g, "")
      .replace(/^-+|-+$/g, "") || "route";
  }

  #shouldIgnore(rawUrl: string): boolean {
    return /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(rawUrl);
  }
}
