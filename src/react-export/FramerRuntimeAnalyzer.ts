import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FramerRuntimeAnalysis, RuntimeChunkSummary, RuntimeComponentModel, RuntimeMarkerCounts } from "./types.js";

const MARKER_PATTERNS: Record<keyof RuntimeMarkerCounts, RegExp[]> = {
  transitions: [/\btransition\b/gi, /\bduration\b/gi, /\bdelay\b/gi, /\bease\b/gi, /\bdamping\b/gi, /\bstiffness\b/gi],
  variants: [/\bvariant\w*\b/gi, /framer-v-/gi, /data-framer-name/gi],
  gestures: [/whileHover/gi, /whileTap/gi, /\bhover\b/gi, /pointerenter/gi, /pointerleave/gi, /\btap\b/gi],
  scroll: [/IntersectionObserver/g, /whileInView/gi, /\binView\b/g, /\bviewport\b/gi, /\bscroll\b/gi],
  slideshows: [/slideshow/gi, /carousel/gi, /pagination/gi],
  forms: [/\bform\b/gi, /submit/gi, /FormData/g],
  cms: [/\bcms\b/gi, /collection/gi, /\bquery\b/gi, /\bslug\b/gi],
};

const COMPONENT_WINDOW_CHARS = 9_000;
const MAX_COMPONENT_MODELS = 120;

export class FramerRuntimeAnalyzer {
  constructor(private readonly inputDir: string) {}

  async analyze(): Promise<FramerRuntimeAnalysis> {
    const files = await this.#findModuleFiles(path.join(this.inputDir, "assets"));
    const chunks = await this.#summarizeUniqueChunks(files);
    const sortedChunks = chunks.sort((a, b) => b.score - a.score || b.bytes - a.bytes);
    return {
      version: 1,
      chunkCount: sortedChunks.length,
      totalBytes: sortedChunks.reduce((total, chunk) => total + chunk.bytes, 0),
      markerTotals: this.#sumMarkers(sortedChunks),
      chunks: sortedChunks,
      componentModels: this.#componentModels(sortedChunks),
    };
  }

  async #findModuleFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...await this.#findModuleFiles(absolutePath));
      } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
        files.push(absolutePath);
      }
    }
    return files;
  }

  async #summarizeUniqueChunks(files: string[]): Promise<RuntimeChunkSummary[]> {
    const seen = new Set<string>();
    const chunks: RuntimeChunkSummary[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const hash = createHash("sha1").update(source).digest("hex");
      if (seen.has(hash)) {
        continue;
      }
      seen.add(hash);

      const fileStat = await stat(file);
      const markers = this.#countMarkers(source);
      chunks.push({
        path: this.#relativePath(file),
        bytes: fileStat.size,
        sha1: hash,
        score: this.#score(markers),
        markers,
        samples: this.#sampleTerms(source),
        componentModels: this.#extractComponentModels(source, this.#relativePath(file)),
      });
    }
    return chunks;
  }

  #extractComponentModels(source: string, chunkPath: string): RuntimeComponentModel[] {
    const models: RuntimeComponentModel[] = [];
    const displayNamePattern = /([A-Za-z_$][\w$]*)\.displayName=`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = displayNamePattern.exec(source)) && models.length < MAX_COMPONENT_MODELS) {
      const windowStart = Math.max(0, match.index - COMPONENT_WINDOW_CHARS);
      const windowSource = source.slice(windowStart, match.index);
      const variantClassMap = this.#lastVariantClassMap(windowSource);
      const transition = this.#lastTransitionObject(windowSource);
      const rootClass = this.#lastBacktickMatch(windowSource, /`(framer-[A-Za-z0-9]+)`/g);
      const defaultVariant = this.#lastBacktickMatch(windowSource, /defaultVariant:`([^`]+)`/g);
      const gestureCounts = this.#gestureCounts(windowSource);
      if (!rootClass && Object.keys(variantClassMap).length === 0) {
        continue;
      }
      if (match[2].includes("${")) {
        continue;
      }

      models.push({
        chunkPath,
        symbol: match[1],
        displayName: match[2],
        rootClass,
        defaultVariant,
        variantClassMap,
        transition,
        gestureCounts,
      });
    }
    return models;
  }

  #lastVariantClassMap(source: string): Record<string, string> {
    const maps = [...source.matchAll(/[A-Za-z_$][\w$]*=\{([^{}]*framer-v-[^{}]*)\}/g)];
    const latest = maps.at(-1)?.[1];
    if (!latest) {
      return {};
    }

    const variants: Record<string, string> = {};
    for (const match of latest.matchAll(/([A-Za-z0-9_$]+):`(framer-v-[^`]+)`/g)) {
      variants[match[1]] = match[2];
    }
    return variants;
  }

  #lastTransitionObject(source: string): Record<string, string | number | boolean> | undefined {
    const objects = [...source.matchAll(/[A-Za-z_$][\w$]*=\{([^{}]*(?:bounce|delay|duration|ease|damping|stiffness)[^{}]*)\}/g)];
    const rawObject = objects.at(-1)?.[1];
    if (!rawObject) {
      return undefined;
    }

    const transition: Record<string, string | number | boolean> = {};
    for (const match of rawObject.matchAll(/([A-Za-z_$][\w$]*):(`[^`]*`|-?\d+(?:\.\d+)?|!0|!1)/g)) {
      transition[match[1]] = this.#parseRuntimeLiteral(match[2]);
    }
    return Object.keys(transition).length > 0 ? transition : undefined;
  }

  #parseRuntimeLiteral(value: string): string | number | boolean {
    if (value === "!0") return true;
    if (value === "!1") return false;
    if (value.startsWith("`")) return value.slice(1, -1);
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : value;
  }

  #lastBacktickMatch(source: string, pattern: RegExp): string | undefined {
    return [...source.matchAll(pattern)].at(-1)?.[1];
  }

  #gestureCounts(source: string): RuntimeComponentModel["gestureCounts"] {
    return {
      whileHover: source.match(/whileHover/g)?.length ?? 0,
      whileTap: source.match(/whileTap/g)?.length ?? 0,
      hover: source.match(/\bhover\b/gi)?.length ?? 0,
      tap: source.match(/\btap\b/gi)?.length ?? 0,
    };
  }

  #componentModels(chunks: RuntimeChunkSummary[]): RuntimeComponentModel[] {
    const models = chunks.flatMap((chunk) => chunk.componentModels ?? []);
    return models.slice(0, MAX_COMPONENT_MODELS);
  }

  #countMarkers(source: string): RuntimeMarkerCounts {
    return {
      transitions: this.#countPatternGroup(source, MARKER_PATTERNS.transitions),
      variants: this.#countPatternGroup(source, MARKER_PATTERNS.variants),
      gestures: this.#countPatternGroup(source, MARKER_PATTERNS.gestures),
      scroll: this.#countPatternGroup(source, MARKER_PATTERNS.scroll),
      slideshows: this.#countPatternGroup(source, MARKER_PATTERNS.slideshows),
      forms: this.#countPatternGroup(source, MARKER_PATTERNS.forms),
      cms: this.#countPatternGroup(source, MARKER_PATTERNS.cms),
    };
  }

  #countPatternGroup(source: string, patterns: RegExp[]): number {
    return patterns.reduce((total, pattern) => total + (source.match(pattern)?.length ?? 0), 0);
  }

  #score(markers: RuntimeMarkerCounts): number {
    return markers.transitions + markers.variants * 2 + markers.gestures * 3 + markers.scroll * 3 + markers.slideshows * 3 + markers.forms + markers.cms;
  }

  #sumMarkers(chunks: RuntimeChunkSummary[]): RuntimeMarkerCounts {
    return chunks.reduce<RuntimeMarkerCounts>((totals, chunk) => ({
      transitions: totals.transitions + chunk.markers.transitions,
      variants: totals.variants + chunk.markers.variants,
      gestures: totals.gestures + chunk.markers.gestures,
      scroll: totals.scroll + chunk.markers.scroll,
      slideshows: totals.slideshows + chunk.markers.slideshows,
      forms: totals.forms + chunk.markers.forms,
      cms: totals.cms + chunk.markers.cms,
    }), this.#emptyMarkers());
  }

  #sampleTerms(source: string): string[] {
    const samples = new Set<string>();
    for (const pattern of [/whileHover|whileTap|whileInView/g, /framer-v-[a-z0-9]+/gi, /data-framer-[a-z-]+/gi, /IntersectionObserver/g]) {
      for (const match of source.match(pattern) ?? []) {
        samples.add(match);
        if (samples.size >= 12) {
          return [...samples];
        }
      }
    }
    return [...samples];
  }

  #emptyMarkers(): RuntimeMarkerCounts {
    return { transitions: 0, variants: 0, gestures: 0, scroll: 0, slideshows: 0, forms: 0, cms: 0 };
  }

  #relativePath(file: string): string {
    return path.relative(this.inputDir, file).replace(/\\/g, "/");
  }
}
