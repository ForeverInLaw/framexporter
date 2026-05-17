import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapturedAsset, SkippedAsset } from "./types.js";

type StoreInput = {
  readonly sourceUrl: string;
  readonly contentType: string;
  readonly body: Buffer;
};

export class ResponseArchive {
  readonly #outputDir: string;
  readonly #assets = new Map<string, CapturedAsset>();
  readonly #assetsByBareUrl = new Map<string, CapturedAsset>();
  readonly #skipped: SkippedAsset[] = [];
  readonly #skippedUrls = new Set<string>();

  constructor(outputDir: string) {
    this.#outputDir = outputDir;
  }

  get assets(): CapturedAsset[] {
    return [...this.#assets.values()];
  }

  get skipped(): SkippedAsset[] {
    return [...this.#skipped];
  }

  localPathFor(sourceUrl: string): string | undefined {
    return this.#assets.get(sourceUrl)?.localPath ?? this.#assetsByBareUrl.get(this.#bareUrl(sourceUrl))?.localPath;
  }

  localPathsFor(sourceUrl: string): string[] {
    const asset = this.#assets.get(sourceUrl) ?? this.#assetsByBareUrl.get(this.#bareUrl(sourceUrl));
    return asset ? [asset.localPath, ...this.#aliasPaths(asset.sourceUrl, asset.localPath)] : [];
  }

  has(sourceUrl: string): boolean {
    return this.#assets.has(sourceUrl);
  }

  skip(sourceUrl: string, reason: string): void {
    if (this.#assets.has(sourceUrl) || this.#skippedUrls.has(sourceUrl)) {
      return;
    }
    this.#skippedUrls.add(sourceUrl);
    this.#skipped.push({ sourceUrl, reason });
  }

  async store(input: StoreInput): Promise<void> {
    if (this.#assets.has(input.sourceUrl)) {
      return;
    }

    const blockedReason = this.#blockedReason(input.sourceUrl);
    if (blockedReason) {
      this.skip(input.sourceUrl, blockedReason);
      return;
    }

    if (!this.#isSupportedContent(input.contentType, input.sourceUrl)) {
      this.skip(input.sourceUrl, `unsupported content-type: ${input.contentType || "unknown"}`);
      return;
    }

    const localPath = this.#buildLocalPath(input.sourceUrl, input.contentType);
    await this.#writeFile(localPath, input.body);
    for (const aliasPath of this.#aliasPaths(input.sourceUrl, localPath)) {
      await this.#writeFile(aliasPath, input.body);
    }

    const asset = {
      sourceUrl: input.sourceUrl,
      localPath,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    };

    this.#assets.set(input.sourceUrl, asset);
    this.#assetsByBareUrl.set(this.#bareUrl(input.sourceUrl), asset);
  }

  async #writeFile(localPath: string, body: Buffer): Promise<void> {
    const absolutePath = path.join(this.#outputDir, ...localPath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, body);
  }

  #aliasPaths(sourceUrl: string, localPath: string): string[] {
    const aliases = new Set<string>();
    const parsed = new URL(sourceUrl);
    const stablePath = this.#stableLocalPath(parsed);
    if (stablePath && stablePath !== localPath) {
      aliases.add(stablePath);
      if (stablePath.startsWith("assets/")) {
        aliases.add(`assets/${stablePath}`);
      }
    }
    if (localPath.startsWith("assets/")) {
      aliases.add(`assets/${localPath}`);
    }
    if (parsed.host === "framerusercontent.com" && parsed.pathname.startsWith("/images/")) {
      aliases.add(`images/${path.posix.basename(localPath)}`);
      const originalName = this.#sanitizeSegment(path.posix.basename(parsed.pathname));
      aliases.add(`images/${originalName}`);
    }
    if (parsed.host === "framerusercontent.com" && parsed.pathname.startsWith("/modules/")) {
      const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => this.#sanitizeSegment(segment));
      segments[0] = "cms";
      aliases.add(["assets", this.#sanitizeSegment(parsed.host), ...segments].join("/"));
    }
    aliases.delete(localPath);
    return [...aliases];
  }

  #stableLocalPath(parsed: URL): string | undefined {
    const safeHost = this.#sanitizeSegment(parsed.host);
    const segments = parsed.pathname.split("/").filter(Boolean).map((segment) => this.#sanitizeSegment(segment));
    return segments.length > 0 ? ["assets", safeHost, ...segments].join("/") : undefined;
  }

  #bareUrl(sourceUrl: string): string {
    try {
      const parsed = new URL(sourceUrl);
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return sourceUrl;
    }
  }

  #isSupportedContent(contentType: string, sourceUrl: string): boolean {
    return /text\/css|javascript|image\/|video\/|audio\/|font\/|application\/font|application\/json|application\/octet-stream|svg\+xml|manifest\+json/i.test(
      contentType,
    ) || /\.(mjs|js|css|json|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp4|webm|mov|mp3|wav)$/i.test(new URL(sourceUrl).pathname);
  }

  #blockedReason(sourceUrl: string): string | undefined {
    const host = new URL(sourceUrl).host;
    if (/^(api|events)\.framer\.com$/i.test(host)) {
      return `dynamic Framer service skipped: ${host}`;
    }
    return undefined;
  }

  #buildLocalPath(sourceUrl: string, contentType: string): string {
    const parsed = new URL(sourceUrl);
    const hash = createHash("sha256").update(sourceUrl).digest("hex").slice(0, 10);
    const extension = this.#extensionFor(parsed.pathname, contentType);
    const safeHost = this.#sanitizeSegment(parsed.host);
    const rawSegments = parsed.pathname.split("/").filter(Boolean);
    const segments = rawSegments.map((segment) => this.#sanitizeSegment(segment));
    const last = segments.pop() ?? "index";
    const basename = last.replace(/\.[a-z0-9]+$/i, "") || "index";
    const filename = `${basename}-${hash}${extension}`;

    return ["assets", safeHost, ...segments, filename].join("/");
  }

  #extensionFor(pathname: string, contentType: string): string {
    const existing = path.posix.extname(pathname);
    if (existing && existing.length <= 12) {
      return existing;
    }

    if (/text\/html/i.test(contentType)) return ".html";
    if (/text\/css/i.test(contentType)) return ".css";
    if (/javascript/i.test(contentType)) return ".js";
    if (/application\/json/i.test(contentType)) return ".json";
    if (/svg\+xml/i.test(contentType)) return ".svg";
    if (/png/i.test(contentType)) return ".png";
    if (/jpe?g/i.test(contentType)) return ".jpg";
    if (/webp/i.test(contentType)) return ".webp";
    if (/woff2/i.test(contentType)) return ".woff2";
    if (/woff/i.test(contentType)) return ".woff";
    if (/mp4/i.test(contentType)) return ".mp4";
    if (/webm/i.test(contentType)) return ".webm";
    if (/mpeg/i.test(contentType)) return ".mp3";
    return ".bin";
  }

  #sanitizeSegment(segment: string): string {
    return decodeURIComponent(segment)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "asset";
  }
}
