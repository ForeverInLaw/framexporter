import type { ConvertedPage, SharedComponent } from "./types.js";

export class SemanticComponentNamer {
  rename(pages: ConvertedPage[], components: SharedComponent[]): { pages: ConvertedPage[]; components: SharedComponent[] } {
    const renameMap = this.#buildRenameMap(components);
    return {
      pages: pages.map((page) => this.#renamePage(page, renameMap)),
      components: components.map((component) => this.#renameComponent(component, renameMap)),
    };
  }

  #buildRenameMap(components: SharedComponent[]): Map<string, string> {
    const used = new Map<string, number>();
    const renameMap = new Map<string, string>();

    for (const component of components) {
      const baseName = this.#baseName(component);
      const next = (used.get(baseName) ?? 0) + 1;
      used.set(baseName, next);
      renameMap.set(component.name, next === 1 ? baseName : `${baseName}${next}`);
    }

    return renameMap;
  }

  #renamePage(page: ConvertedPage, renameMap: Map<string, string>): ConvertedPage {
    return {
      ...page,
      jsx: this.#replaceComponentNames(page.jsx, renameMap),
      componentImports: page.componentImports.map((name) => renameMap.get(name) ?? name),
    };
  }

  #renameComponent(component: SharedComponent, renameMap: Map<string, string>): SharedComponent {
    const name = renameMap.get(component.name) ?? component.name;
    return {
      ...component,
      name,
      fileName: `${name}.tsx`,
      body: this.#replaceComponentNames(component.body, renameMap),
    };
  }

  #replaceComponentNames(text: string, renameMap: Map<string, string>): string {
    let renamed = text;
    for (const [from, to] of renameMap) {
      renamed = renamed.replace(new RegExp(`\\b${from}\\b`, "g"), to);
    }
    return renamed;
  }

  #baseName(component: SharedComponent): string {
    const props = new Set(component.props ?? []);
    const body = component.body;
    const samples = (component.propSamples ?? []).flat();

    if (props.has("href") && (props.has("text") || props.has("label"))) {
      return body.includes("<nav") || body.includes("framer-mw93t7") ? "NavigationLink" : "LinkItem";
    }
    if (props.has("href")) {
      return "LinkedBlock";
    }
    if ((props.has("src") || props.has("srcSet")) && props.has("text")) {
      return body.includes("blog") ? "ArticleCard" : "MediaCard";
    }
    if (props.has("src") || props.has("srcSet")) {
      return "ResponsiveImage";
    }
    if (props.has("text") && (props.has("text2") || props.has("description"))) {
      return this.#hasStatSamples(samples) ? "StatCard" : "ContentCard";
    }
    if (props.has("text")) {
      return this.#hasShortSamples(samples) ? "TextLabel" : "TextBlock";
    }
    if (body.includes("<nav")) {
      return "NavigationSection";
    }
    if (body.includes("<svg") || body.includes("svgContainer")) {
      return "IconGraphic";
    }
    if (body.includes("footer") || body.includes("Footer")) {
      return "FooterSection";
    }
    if (body.includes("framer-text")) {
      return "TextSection";
    }
    return component.name.startsWith("Generated") ? "SharedSection" : "InferredSection";
  }

  #hasStatSamples(samples: readonly string[]): boolean {
    return samples.some((sample) => /(?:\d|%|\+)/.test(sample) && sample.length <= 32);
  }

  #hasShortSamples(samples: readonly string[]): boolean {
    return samples.length > 0 && samples.every((sample) => sample.length <= 48);
  }
}
