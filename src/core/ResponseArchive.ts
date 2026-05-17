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
  readonly #skipped: SkippedAsset[] = [];

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
    return this.#assets.get(sourceUrl)?.localPath;
  }

  has(sourceUrl: string): boolean {
    return this.#assets.has(sourceUrl);
  }

  skip(sourceUrl: string, reason: string): void {
    if (this.#assets.has(sourceUrl)) {
      return;
    }
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
    const absolutePath = path.join(this.#outputDir, ...localPath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.body);

    this.#assets.set(input.sourceUrl, {
      sourceUrl: input.sourceUrl,
      localPath,
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    });
  }

  #isSupportedContent(contentType: string, sourceUrl: string): boolean {
    return /text\/css|javascript|image\/|font\/|application\/font|application\/octet-stream|svg\+xml|manifest\+json/i.test(
      contentType,
    ) || /\.(mjs|js|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(new URL(sourceUrl).pathname);
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
    return ".bin";
  }

  #sanitizeSegment(segment: string): string {
    return decodeURIComponent(segment)
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "asset";
  }
}
