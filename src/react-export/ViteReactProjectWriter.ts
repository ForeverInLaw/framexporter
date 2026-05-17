import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConvertedPage, ReactExportOptions, ReactRouteSource } from "./types.js";

export class ViteReactProjectWriter {
  constructor(private readonly options: ReactExportOptions) {}

  async write(pages: ConvertedPage[]): Promise<void> {
    await rm(this.options.outputDir, { recursive: true, force: true });
    await mkdir(path.join(this.options.outputDir, "src", "pages"), { recursive: true });
    await mkdir(path.join(this.options.outputDir, "src", "styles"), { recursive: true });
    await mkdir(path.join(this.options.outputDir, "public"), { recursive: true });

    await Promise.all([
      this.#copyAssets(),
      this.#writePackageJson(),
      this.#writeIndexHtml(),
      this.#writeTsConfig(),
      this.#writeViteConfig(),
      this.#writeMain(),
      this.#writeViteEnv(),
      this.#writeApp(pages.map((page) => page.route)),
      this.#writeCss(pages),
      ...pages.map((page) => this.#writePage(page)),
    ]);
  }

  async #copyAssets(): Promise<void> {
    const sourceAssets = path.join(this.options.inputDir, "assets");
    const targetAssets = path.join(this.options.outputDir, "public", "assets");
    await cp(sourceAssets, targetAssets, { recursive: true, force: true }).catch(() => undefined);
  }

  async #writePackageJson(): Promise<void> {
    await this.#writeJson("package.json", {
      name: this.options.appName,
      private: true,
      version: "0.0.0",
      type: "module",
      scripts: {
        dev: "vite",
        build: "tsc -b && vite build",
        preview: "vite preview",
      },
      dependencies: {
        "@vitejs/plugin-react": "latest",
        vite: "latest",
        typescript: "latest",
        react: "latest",
        "react-dom": "latest",
      },
      devDependencies: {
        "@types/react": "latest",
        "@types/react-dom": "latest",
      },
    });
  }

  async #writeIndexHtml(): Promise<void> {
    await this.#writeText("index.html", `<div id="root"></div><script type="module" src="/src/main.tsx"></script>\n`);
  }

  async #writeTsConfig(): Promise<void> {
    await this.#writeJson("tsconfig.json", {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        lib: ["DOM", "DOM.Iterable", "ES2022"],
        allowJs: false,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        strict: true,
        forceConsistentCasingInFileNames: true,
        module: "ESNext",
        moduleResolution: "Bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        noEmit: true,
        jsx: "react-jsx",
      },
      include: ["src"],
    });
  }

  async #writeViteConfig(): Promise<void> {
    await this.#writeText("vite.config.ts", `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({ plugins: [react()] });\n`);
  }

  async #writeMain(): Promise<void> {
    await this.#writeText(
      path.join("src", "main.tsx"),
      `import React from "react";\nimport { createRoot } from "react-dom/client";\nimport { App } from "./App";\nimport "./styles/generated.css";\n\ncreateRoot(document.getElementById("root")!).render(\n  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n`,
    );
  }

  async #writeViteEnv(): Promise<void> {
    await this.#writeText(path.join("src", "vite-env.d.ts"), "/// <reference types=\"vite/client\" />\n");
  }

  async #writeApp(routes: ReactRouteSource[]): Promise<void> {
    const imports = routes.map((route) => `import { ${route.componentName} } from "./pages/${route.fileName.replace(/\.tsx$/, "")}";`).join("\n");
    const routeEntries = routes.map((route) => `  { path: ${JSON.stringify(route.routePath)}, Component: ${route.componentName} },`).join("\n");
    await this.#writeText(
      path.join("src", "App.tsx"),
      `${imports}\n\nconst routes = [\n${routeEntries}\n];\n\nexport function App() {\n  const currentPath = normalizePath(window.location.pathname);\n  const match = routes.find((route) => normalizePath(route.path) === currentPath) ?? routes[0];\n  const Component = match.Component;\n  return <Component />;\n}\n\nfunction normalizePath(pathname: string): string {\n  if (pathname.length > 1 && pathname.endsWith("/")) {\n    return pathname.slice(0, -1);\n  }\n  return pathname || "/";\n}\n`,
    );
  }

  async #writeCss(pages: ConvertedPage[]): Promise<void> {
    const css = pages.map((page) => this.#rewriteCssUrls(page.css)).filter(Boolean).join("\n\n");
    const baseCss = `html, body, #root { margin: 0; min-height: 100%; }\nbody { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }\na { color: inherit; }\n*, *::before, *::after { box-sizing: border-box; }\n`;
    await this.#writeText(path.join("src", "styles", "generated.css"), `${baseCss}\n${css}\n`);
  }

  async #writePage(page: ConvertedPage): Promise<void> {
    await this.#writeText(
      path.join("src", "pages", page.route.fileName),
      `import type * as React from "react";\n\nexport function ${page.route.componentName}() {\n  return (\n    <>\n${page.jsx}\n    </>\n  );\n}\n`,
    );
  }

  #rewriteCssUrls(css: string): string {
    return css.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote: string, rawUrl: string) => {
      if (/^(https?:|data:|blob:|#)/i.test(rawUrl)) {
        return match;
      }
      const normalized = rawUrl.replace(/\\/g, "/");
      const assetIndex = normalized.indexOf("assets/");
      if (assetIndex < 0) {
        return match;
      }
      return `url(${quote}/${normalized.slice(assetIndex)}${quote})`;
    });
  }

  async #writeJson(relativePath: string, value: unknown): Promise<void> {
    await this.#writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async #writeText(relativePath: string, text: string): Promise<void> {
    const absolutePath = path.join(this.options.outputDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, text, "utf8");
  }
}

