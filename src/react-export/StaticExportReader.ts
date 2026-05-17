import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ExportManifest, ExportedRoute } from "../core/types.js";
import type { ReactExportSource, ReactRouteSource } from "./types.js";

export class StaticExportReader {
  constructor(private readonly inputDir: string) {}

  async read(): Promise<ReactExportSource> {
    const manifest = await this.#readManifest();
    const routes = manifest ? await this.#readManifestRoutes(manifest) : await this.#discoverHtmlRoutes();

    return { manifest, routes };
  }

  async #readManifest(): Promise<ExportManifest | undefined> {
    try {
      return JSON.parse(await readFile(path.join(this.inputDir, "manifest.json"), "utf8")) as ExportManifest;
    } catch {
      return undefined;
    }
  }

  async #readManifestRoutes(manifest: ExportManifest): Promise<ReactRouteSource[]> {
    const routes: ReactRouteSource[] = [];
    for (const route of manifest.routes) {
      const source = await this.#buildRoute(route);
      if (source) {
        routes.push(source);
      }
    }
    return this.#dedupeRoutes(routes);
  }

  async #buildRoute(route: ExportedRoute): Promise<ReactRouteSource | undefined> {
    const absolutePath = path.join(this.inputDir, ...route.localPath.split("/"));
    try {
      const html = await readFile(absolutePath, "utf8");
      return this.#createRouteSource(route.sourceUrl, route.localPath, html);
    } catch {
      return undefined;
    }
  }

  async #discoverHtmlRoutes(): Promise<ReactRouteSource[]> {
    const files = await this.#listHtmlFiles(this.inputDir);
    const routes = await Promise.all(
      files.map(async (filePath) => {
        const localPath = path.relative(this.inputDir, filePath).split(path.sep).join("/");
        const html = await readFile(filePath, "utf8");
        return this.#createRouteSource("", localPath, html);
      }),
    );
    return this.#dedupeRoutes(routes);
  }

  async #listHtmlFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name !== "assets") {
        files.push(...(await this.#listHtmlFiles(absolutePath)));
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        files.push(absolutePath);
      }
    }
    return files;
  }

  #createRouteSource(sourceUrl: string, localPath: string, html: string): ReactRouteSource {
    const routePath = this.#routePathFromLocalPath(localPath);
    const baseName = routePath === "/" ? "Home" : this.#pascalCase(routePath);
    return {
      sourceUrl,
      localPath,
      routePath,
      componentName: `${baseName}Page`,
      fileName: `${baseName}Page.tsx`,
      html,
    };
  }

  #routePathFromLocalPath(localPath: string): string {
    if (localPath === "index.html") {
      return "/";
    }
    if (localPath.endsWith("/index.html")) {
      return `/${localPath.slice(0, -"/index.html".length)}`;
    }
    return `/${localPath.replace(/\.html$/i, "")}`;
  }

  #pascalCase(value: string): string {
    const words = value.split("/").filter(Boolean).flatMap((part) => part.split(/[^a-z0-9]+/i)).filter(Boolean);
    const name = words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join("") || "Route";
    return /^[A-Za-z]/.test(name) ? name : `Route${name}`;
  }

  #dedupeRoutes(routes: ReactRouteSource[]): ReactRouteSource[] {
    const seen = new Set<string>();
    return routes.filter((route) => {
      if (seen.has(route.routePath)) {
        return false;
      }
      seen.add(route.routePath);
      return true;
    });
  }
}


