import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";

export type StaticPreviewOptions = {
  readonly rootDir: string;
  readonly host: string;
  readonly port: number;
};

export class StaticPreviewServer {
  readonly #rootDir: string;
  readonly #host: string;
  readonly #port: number;
  #server: Server | undefined;

  constructor(options: StaticPreviewOptions) {
    this.#rootDir = path.resolve(options.rootDir);
    this.#host = options.host;
    this.#port = options.port;
  }

  async start(): Promise<string> {
    this.#server = createServer((request, response) => {
      this.#handle(request, response).catch(() => this.#sendText(response, 500, "Internal server error"));
    });

    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.#port, this.#host, resolve);
    });

    const address = this.#server.address();
    const port = typeof address === "object" && address ? address.port : this.#port;
    return `http://${this.#host}:${port}/`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.#server) {
        resolve();
        return;
      }
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      this.#sendText(response, 405, "Method not allowed");
      return;
    }

    const requestPath = this.#requestPath(request.url ?? "/");
    const resolved = await this.#resolveFile(requestPath);
    if (!resolved) {
      this.#sendText(response, 404, "Not found");
      return;
    }

    const fileStat = await stat(resolved.filePath);
    const range = this.#requestRange(request.url ?? "/", fileStat.size);
    if (range === "invalid") {
      response.writeHead(416, {
        "Content-Range": `bytes */${fileStat.size}`,
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Range not satisfiable");
      return;
    }

    const status = range ? 206 : resolved.status;
    const contentLength = range ? range.end - range.start + 1 : fileStat.size;
    const headers: Record<string, string | number> = {
      "Content-Type": this.#contentType(resolved.filePath),
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
    };
    if (range) {
      headers["Content-Range"] = `bytes ${range.start}-${range.end}/${fileStat.size}`;
    }

    response.writeHead(status, headers);

    if (request.method === "HEAD") {
      response.end();
      return;
    }

    createReadStream(resolved.filePath, range ? { start: range.start, end: range.end } : undefined).pipe(response);
  }

  #requestRange(rawUrl: string, fileSize: number): { start: number; end: number } | "invalid" | undefined {
    const parsed = new URL(rawUrl, "http://preview.local");
    const queryRange = parsed.searchParams.get("range");
    const headerRange = queryRange ? undefined : parsed.searchParams.get("bytes");
    const rawRange = queryRange ?? headerRange;
    if (!rawRange) {
      return undefined;
    }

    const match = rawRange.match(/^(?:bytes=)?(\d+)-(\d+)$/i);
    if (!match) {
      return "invalid";
    }

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= fileSize) {
      return "invalid";
    }
    return { start, end };
  }

  async #resolveFile(requestPath: string): Promise<{ filePath: string; status: number } | undefined> {
    const candidates = this.#candidatePaths(requestPath);
    for (const candidate of candidates) {
      const filePath = path.resolve(this.#rootDir, candidate);
      if (!this.#isInsideRoot(filePath)) {
        continue;
      }
      if (await this.#isFile(filePath)) {
        return { filePath, status: candidate === "404/index.html" ? 404 : 200 };
      }
    }
    return undefined;
  }

  #candidatePaths(requestPath: string): string[] {
    const cleanPath = requestPath.replace(/^\/+/, "");
    const candidates: string[] = [];

    if (!cleanPath) {
      candidates.push("index.html");
    } else {
      candidates.push(cleanPath);
      if (requestPath.endsWith("/")) {
        candidates.push(path.posix.join(cleanPath, "index.html"));
      } else if (!path.posix.extname(cleanPath)) {
        candidates.push(path.posix.join(cleanPath, "index.html"));
      }
    }

    candidates.push("404/index.html", "index.html");
    return [...new Set(candidates)];
  }

  #requestPath(rawUrl: string): string {
    const parsed = new URL(rawUrl, "http://preview.local");
    try {
      return decodeURIComponent(parsed.pathname);
    } catch {
      return parsed.pathname;
    }
  }

  #isInsideRoot(filePath: string): boolean {
    const relative = path.relative(this.#rootDir, filePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  async #isFile(filePath: string): Promise<boolean> {
    try {
      return (await stat(filePath)).isFile();
    } catch {
      return false;
    }
  }

  #sendText(response: ServerResponse, status: number, text: string): void {
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(text);
  }

  #contentType(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    if (extension === ".html") return "text/html; charset=utf-8";
    if (extension === ".css") return "text/css; charset=utf-8";
    if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
    if (extension === ".json") return "application/json; charset=utf-8";
    if (extension === ".svg") return "image/svg+xml";
    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    if (extension === ".webp") return "image/webp";
    if (extension === ".gif") return "image/gif";
    if (extension === ".ico") return "image/x-icon";
    if (extension === ".woff") return "font/woff";
    if (extension === ".woff2") return "font/woff2";
    return "application/octet-stream";
  }
}
