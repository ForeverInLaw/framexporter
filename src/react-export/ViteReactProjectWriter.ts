import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConvertedPage, FramerRuntimeAnalysis, ReactExportOptions, ReactRouteSource, SharedComponent } from "./types.js";

export class ViteReactProjectWriter {
  constructor(private readonly options: ReactExportOptions) {}

  async write(pages: ConvertedPage[], components: SharedComponent[], runtimeAnalysis: FramerRuntimeAnalysis): Promise<void> {
    await rm(this.options.outputDir, { recursive: true, force: true });
    await mkdir(path.join(this.options.outputDir, "src", "components"), { recursive: true });
    await mkdir(path.join(this.options.outputDir, "src", "motion"), { recursive: true });
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
      this.#writeFavicon(),
      this.#writeMotionRuntime(),
      this.#writeRuntimeAnalysis(runtimeAnalysis),
      this.#writeApp(pages.map((page) => page.route)),
      this.#writeCss(pages),
      ...pages.map((page) => this.#writePage(page)),
      ...components.map((component) => this.#writeSharedComponent(component)),
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
        "@gsap/react": "latest",
        "@vitejs/plugin-react": "latest",
        gsap: "latest",
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

  async #writeFavicon(): Promise<void> {
    await this.#writeText(path.join("public", "favicon.ico"), "");
  }

  async #writeRuntimeAnalysis(runtimeAnalysis: FramerRuntimeAnalysis): Promise<void> {
    await this.#writeJson("framexporter-runtime-analysis.json", runtimeAnalysis);
  }

  async #writeMotionRuntime(): Promise<void> {
    await this.#writeText(
      path.join("src", "motion", "FramexporterMotion.tsx"),
      `import { useGSAP } from "@gsap/react";\nimport gsap from "gsap";\n\ngsap.registerPlugin(useGSAP);\n\ntype MotionKind = "fade-up" | "fade-left" | "fade-right";\n\nexport function FramexporterMotion() {\n  useGSAP(() => {\n    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {\n      return;\n    }\n\n    const elements = gsap.utils.toArray<HTMLElement>("[data-framexporter-motion]");\n    const observer = new IntersectionObserver((entries) => {\n      for (const entry of entries) {\n        if (!entry.isIntersecting) {\n          continue;\n        }\n\n        const element = entry.target as HTMLElement;\n        observer.unobserve(element);\n        animateElement(element);\n      }\n    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });\n\n    for (const element of elements) {\n      observer.observe(element);\n    }\n\n    return () => observer.disconnect();\n  }, { dependencies: [] });\n\n  return null;\n}\n\nfunction animateElement(element: HTMLElement): void {\n  gsap.fromTo(\n    element,\n    initialVars(motionKind(element)),\n    {\n      autoAlpha: 1,\n      x: 0,\n      y: 0,\n      duration: 0.72,\n      delay: delaySeconds(element),\n      ease: "power3.out",\n      overwrite: "auto",\n      clearProps: "transform,opacity,visibility,willChange",\n    },\n  );\n}\n\nfunction initialVars(kind: MotionKind): gsap.TweenVars {\n  if (kind === "fade-left") {\n    return { autoAlpha: 0, x: 36, y: 0, willChange: "transform,opacity" };\n  }\n  if (kind === "fade-right") {\n    return { autoAlpha: 0, x: -36, y: 0, willChange: "transform,opacity" };\n  }\n  return { autoAlpha: 0, x: 0, y: 42, willChange: "transform,opacity" };\n}\n\nfunction motionKind(element: HTMLElement): MotionKind {\n  const raw = element.dataset.framexporterMotion;\n  return raw === "fade-left" || raw === "fade-right" ? raw : "fade-up";\n}\n\nfunction delaySeconds(element: HTMLElement): number {\n  const raw = element.style.getPropertyValue("--framexporter-motion-delay").trim();\n  const milliseconds = Number(raw.replace("ms", ""));\n  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;\n}\n`,
    );
  }

  async #writeApp(routes: ReactRouteSource[]): Promise<void> {
    const imports = routes.map((route) => `import { ${route.componentName} } from "./pages/${route.fileName.replace(/\.tsx$/, "")}";`).join("\n");
    const routeEntries = routes.map((route) => `  { path: ${JSON.stringify(route.routePath)}, Component: ${route.componentName} },`).join("\n");
    await this.#writeText(
      path.join("src", "App.tsx"),
      `import { FramexporterMotion } from "./motion/FramexporterMotion";\n${imports}\n\nconst routes = [\n${routeEntries}\n];\n\nexport function App() {\n  const currentPath = normalizePath(window.location.pathname);\n  const match = routes.find((route) => normalizePath(route.path) === currentPath) ?? routes[0];\n  const Component = match.Component;\n  return (\n    <>\n      <FramexporterMotion />\n      <Component />\n    </>\n  );\n}\n\nfunction normalizePath(pathname: string): string {\n  if (pathname.length > 1 && pathname.endsWith("/")) {\n    return pathname.slice(0, -1);\n  }\n  return pathname || "/";\n}\n`,
    );
  }

  async #writeCss(pages: ConvertedPage[]): Promise<void> {
    const css = pages.map((page) => this.#rewriteCssUrls(page.css)).filter(Boolean).join("\n\n");
    const baseCss = `html, body, #root { margin: 0; min-height: 100%; }\nbody { font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }\na { color: inherit; }\n*, *::before, *::after { box-sizing: border-box; }\n[data-framexporter-motion] { will-change: transform, opacity; }\n@media (prefers-reduced-motion: reduce) { [data-framexporter-motion] { opacity: 1 !important; transform: none !important; visibility: visible !important; } }\n`;
    await this.#writeText(path.join("src", "styles", "generated.css"), `${baseCss}\n${css}\n`);
  }

  async #writePage(page: ConvertedPage): Promise<void> {
    const imports = [...new Set(page.componentImports)]
      .sort()
      .map((name) => `import { ${name} } from "../components/${name}";`)
      .join("\n");
    await this.#writeText(
      path.join("src", "pages", page.route.fileName),
      `${this.#reactTypeImport()}${imports ? `${imports}\n\n` : ""}export function ${page.route.componentName}() {\n  return (\n    <>\n${page.jsx}\n    </>\n  );\n}\n`,
    );
  }

  async #writeSharedComponent(component: SharedComponent): Promise<void> {
    const props = component.props ?? [];
    const propsType = props.length > 0 ? `type Props = {\n${props.map((prop) => `  readonly ${prop}: string;`).join("\n")}\n};\n\n` : "";
    const propsArgument = props.length > 0 ? "props: Props" : "";
    await this.#writeText(
      path.join("src", "components", component.fileName),
      `${this.#reactTypeImport()}${propsType}export function ${component.name}(${propsArgument}) {\n  return (\n    <>\n${this.#indentBody(component.body, 3)}\n    </>\n  );\n}\n`,
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

  #indentBody(body: string, depth: number): string {
    const indent = "  ".repeat(depth);
    return body.split("\n").map((line) => `${indent}${line}`).join("\n");
  }

  #reactTypeImport(): string {
    return `import type * as React from "react";\n\n`;
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
