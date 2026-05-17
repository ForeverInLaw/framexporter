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
      this.#writeMotionRegistry(runtimeAnalysis),
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

  async #writeMotionRegistry(runtimeAnalysis: FramerRuntimeAnalysis): Promise<void> {
    const entries = runtimeAnalysis.componentModels
      .filter((model) => model.rootClass)
      .map((model) => ({
        displayName: model.displayName,
        rootClass: model.rootClass,
        defaultVariant: model.defaultVariant,
        variantClassMap: model.variantClassMap,
        variantStyleTargets: model.variantStyleTargets,
        transition: model.transition,
        enabledGestures: model.enabledGestures,
      }));

    await this.#writeText(
      path.join("src", "motion", "FramexporterMotionRegistry.ts"),
      `export type FramexporterMotionEntry = {\n  readonly displayName: string;\n  readonly rootClass: string;\n  readonly defaultVariant?: string;\n  readonly variantClassMap: Readonly<Record<string, string>>;\n  readonly variantStyleTargets: readonly FramexporterVariantStyleTarget[];\n  readonly transition?: Readonly<Record<string, string | number | boolean>>;\n  readonly enabledGestures: Readonly<{ hover: boolean; tap: boolean }>;\n};\n\nexport type FramexporterVariantStyleTarget = {\n  readonly variant: string;\n  readonly state: "hover" | "tap";\n  readonly targetClass: string;\n  readonly styles: Readonly<Record<string, string | number | boolean>>;\n};\n\nexport const framexporterMotionRegistry = ${JSON.stringify(entries, null, 2)} as const satisfies readonly FramexporterMotionEntry[];\n`,
    );
  }

  async #writeMotionRuntime(): Promise<void> {
    await this.#writeText(
      path.join("src", "motion", "FramexporterMotion.tsx"),
      `import { useGSAP } from "@gsap/react";\nimport gsap from "gsap";\nimport { framexporterMotionRegistry, type FramexporterMotionEntry, type FramexporterVariantStyleTarget } from "./FramexporterMotionRegistry";\n\ngsap.registerPlugin(useGSAP);\n\ntype MotionKind = "fade-up" | "fade-left" | "fade-right";\ntype InteractionState = "hover" | "tap";\ntype ContextSafe = <T extends (...args: never[]) => void>(callback: T) => T;\n\nconst baseStyles = new WeakMap<HTMLElement, Record<string, string>>();\n\nexport function FramexporterMotion() {\n  useGSAP((_, contextSafe) => {\n    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;\n    const elements = gsap.utils.toArray<HTMLElement>("[data-framexporter-motion]");\n    const observer = new IntersectionObserver((entries) => {\n      for (const entry of entries) {\n        if (!entry.isIntersecting) {\n          continue;\n        }\n\n        const element = entry.target as HTMLElement;\n        observer.unobserve(element);\n        if (!reduceMotion) {\n          animateElement(element);\n        }\n      }\n    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });\n\n    for (const element of elements) {\n      observer.observe(element);\n    }\n\n    const cleanups = bindInteractions(contextSafe as ContextSafe, reduceMotion);\n    return () => {\n      observer.disconnect();\n      for (const cleanup of cleanups) {\n        cleanup();\n      }\n    };\n  }, { dependencies: [] });\n\n  return null;\n}\n\nfunction animateElement(element: HTMLElement): void {\n  const entry = motionEntry(element);\n  gsap.fromTo(element, initialVars(motionKind(element)), {\n    autoAlpha: 1,\n    x: 0,\n    y: 0,\n    ...transitionVars(entry, false),\n    delay: delaySeconds(element) + transitionDelay(entry),\n    overwrite: "auto",\n    clearProps: "transform,opacity,visibility,willChange",\n  });\n}\n\nfunction bindInteractions(contextSafe: ContextSafe, reduceMotion: boolean): Array<() => void> {\n  const cleanups: Array<() => void> = [];\n  for (const entry of framexporterMotionRegistry) {\n    if (!hasInteraction(entry)) {\n      continue;\n    }\n\n    for (const root of document.querySelectorAll<HTMLElement>(\`.\${entry.rootClass}\`)) {\n      const onEnter = contextSafe(() => {\n        root.classList.add("hover");\n        applyInteraction(root, entry, "hover", true, reduceMotion);\n      });\n      const onLeave = contextSafe(() => {\n        root.classList.remove("tap");\n        root.classList.remove("hover");\n        applyInteraction(root, entry, "tap", false, reduceMotion);\n        applyInteraction(root, entry, "hover", false, reduceMotion);\n      });\n      const onDown = contextSafe(() => {\n        root.classList.add("tap");\n        applyInteraction(root, entry, "tap", true, reduceMotion);\n      });\n      const onUp = contextSafe(() => {\n        root.classList.remove("tap");\n        applyInteraction(root, entry, "tap", false, reduceMotion);\n      });\n\n      if (entry.enabledGestures.hover || hasState(entry, "hover")) {\n        root.addEventListener("pointerenter", onEnter);\n        root.addEventListener("pointerleave", onLeave);\n        cleanups.push(() => {\n          root.removeEventListener("pointerenter", onEnter);\n          root.removeEventListener("pointerleave", onLeave);\n        });\n      }\n      if (entry.enabledGestures.tap || hasState(entry, "tap")) {\n        root.addEventListener("pointerdown", onDown);\n        root.addEventListener("pointerup", onUp);\n        root.addEventListener("pointercancel", onUp);\n        cleanups.push(() => {\n          root.removeEventListener("pointerdown", onDown);\n          root.removeEventListener("pointerup", onUp);\n          root.removeEventListener("pointercancel", onUp);\n        });\n      }\n    }\n  }\n  return cleanups;\n}\n\nfunction applyInteraction(root: HTMLElement, entry: FramexporterMotionEntry, state: InteractionState, active: boolean, reduceMotion: boolean): void {\n  for (const target of matchingTargets(root, entry, state)) {\n    for (const element of targetElements(root, target)) {\n      captureBaseStyles(element, target.styles);\n      gsap.to(element, {\n        ...styleVars(element, target.styles, active),\n        ...transitionVars(entry, reduceMotion),\n        overwrite: "auto",\n      });\n    }\n  }\n}\n\nfunction matchingTargets(root: HTMLElement, entry: FramexporterMotionEntry, state: InteractionState): FramexporterVariantStyleTarget[] {\n  const activeVariant = activeVariantKey(root, entry);\n  return entry.variantStyleTargets.filter((target) => target.state === state && (!activeVariant || target.variant === activeVariant));\n}\n\nfunction targetElements(root: HTMLElement, target: FramexporterVariantStyleTarget): HTMLElement[] {\n  const elements = Array.from(root.querySelectorAll<HTMLElement>(\`.\${target.targetClass}\`));\n  if (root.classList.contains(target.targetClass)) {\n    elements.unshift(root);\n  }\n  return elements;\n}\n\nfunction captureBaseStyles(element: HTMLElement, styles: Readonly<Record<string, string | number | boolean>>): void {\n  const base = baseStyles.get(element) ?? {};\n  const computed = window.getComputedStyle(element);\n  for (const property of Object.keys(styles)) {\n    if (property in base) {\n      continue;\n    }\n    const cssProperty = cssPropertyName(property);\n    base[property] = isTransformAlias(property) ? String(defaultStyleValue(property)) : element.style.getPropertyValue(cssProperty) || computed.getPropertyValue(cssProperty);\n  }\n  baseStyles.set(element, base);\n}\n\nfunction styleVars(element: HTMLElement, styles: Readonly<Record<string, string | number | boolean>>, active: boolean): gsap.TweenVars {\n  if (active) {\n    return Object.fromEntries(Object.entries(styles).map(([property, value]) => [property, value])) as gsap.TweenVars;\n  }\n  const base = baseStyles.get(element) ?? {};\n  return Object.fromEntries(Object.keys(styles).map((property) => [property, base[property] ?? defaultStyleValue(property)])) as gsap.TweenVars;\n}\n\nfunction activeVariantKey(root: HTMLElement, entry: FramexporterMotionEntry): string | undefined {\n  for (const [variant, className] of Object.entries(entry.variantClassMap)) {\n    if (root.classList.contains(className)) {\n      return variant;\n    }\n  }\n  return entry.defaultVariant;\n}\n\nfunction hasInteraction(entry: FramexporterMotionEntry): boolean {\n  return entry.enabledGestures.hover || entry.enabledGestures.tap || entry.variantStyleTargets.length > 0;\n}\n\nfunction hasState(entry: FramexporterMotionEntry, state: InteractionState): boolean {\n  return entry.variantStyleTargets.some((target) => target.state === state);\n}\n\nfunction initialVars(kind: MotionKind): gsap.TweenVars {\n  if (kind === "fade-left") {\n    return { autoAlpha: 0, x: 36, y: 0, willChange: "transform,opacity" };\n  }\n  if (kind === "fade-right") {\n    return { autoAlpha: 0, x: -36, y: 0, willChange: "transform,opacity" };\n  }\n  return { autoAlpha: 0, x: 0, y: 42, willChange: "transform,opacity" };\n}\n\nfunction motionEntry(element: HTMLElement): FramexporterMotionEntry | undefined {\n  for (let current: HTMLElement | null = element; current; current = current.parentElement) {\n    for (const entry of framexporterMotionRegistry) {\n      if (current.classList.contains(entry.rootClass)) {\n        return entry;\n      }\n    }\n  }\n  return undefined;\n}\n\nfunction transitionVars(entry: FramexporterMotionEntry | undefined, reduceMotion: boolean): gsap.TweenVars {\n  if (reduceMotion) {\n    return { duration: 0 };\n  }\n  const transition = entry?.transition;\n  const type = transitionValue(transition?.type);\n  const duration = numberValue(transition?.duration);\n  const ease = transitionValue(transition?.ease);\n  return {\n    duration: duration ?? (type === "spring" ? 0.68 : 0.72),\n    ease: ease ?? (type === "spring" ? "power3.out" : "power2.out"),\n  };\n}\n\nfunction transitionDelay(entry: FramexporterMotionEntry | undefined): number {\n  return Math.max(0, numberValue(entry?.transition?.delay) ?? 0);\n}\n\nfunction motionKind(element: HTMLElement): MotionKind {\n  const raw = element.dataset.framexporterMotion;\n  return raw === "fade-left" || raw === "fade-right" ? raw : "fade-up";\n}\n\nfunction delaySeconds(element: HTMLElement): number {\n  const raw = element.style.getPropertyValue("--framexporter-motion-delay").trim();\n  const milliseconds = Number(raw.replace("ms", ""));\n  return Number.isFinite(milliseconds) ? milliseconds / 1000 : 0;\n}\n\nfunction cssPropertyName(property: string): string {\n  if (property.startsWith("--")) {\n    return property;\n  }\n  return property.replace(/[A-Z]/g, (char) => \`-\${char.toLowerCase()}\`);\n}\n\nfunction isTransformAlias(property: string): boolean {\n  return property === "scale" || property === "scaleX" || property === "scaleY" || property === "x" || property === "y" || property === "rotate" || property === "rotation";\n}\n\nfunction defaultStyleValue(property: string): string | number {\n  if (property === "scale" || property === "scaleX" || property === "scaleY") {\n    return 1;\n  }\n  if (property === "x" || property === "y" || property === "rotate" || property === "rotation") {\n    return 0;\n  }\n  return "";\n}\n\nfunction numberValue(value: unknown): number | undefined {\n  return typeof value === "number" && Number.isFinite(value) ? value : undefined;\n}\n\nfunction transitionValue(value: unknown): string | undefined {\n  return typeof value === "string" && value.length > 0 ? value : undefined;\n}\n`,
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
