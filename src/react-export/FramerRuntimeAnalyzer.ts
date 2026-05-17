import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FramerRuntimeAnalysis, RuntimeChunkSummary, RuntimeMarkerCounts } from "./types.js";

const MARKER_PATTERNS: Record<keyof RuntimeMarkerCounts, RegExp[]> = {
  transitions: [/\btransition\b/gi, /\bduration\b/gi, /\bdelay\b/gi, /\bease\b/gi, /\bdamping\b/gi, /\bstiffness\b/gi],
  variants: [/\bvariant\w*\b/gi, /framer-v-/gi, /data-framer-name/gi],
  gestures: [/whileHover/gi, /whileTap/gi, /\bhover\b/gi, /pointerenter/gi, /pointerleave/gi, /\btap\b/gi],
  scroll: [/IntersectionObserver/g, /whileInView/gi, /\binView\b/g, /\bviewport\b/gi, /\bscroll\b/gi],
  slideshows: [/slideshow/gi, /carousel/gi, /pagination/gi],
  forms: [/\bform\b/gi, /submit/gi, /FormData/g],
  cms: [/\bcms\b/gi, /collection/gi, /\bquery\b/gi, /\bslug\b/gi],
};

export class FramerRuntimeAnalyzer {
  constructor(private readonly inputDir: string) {}

  async analyze(): Promise<FramerRuntimeAnalysis> {
    const files = await this.#findModuleFiles(path.join(this.inputDir, "assets"));
    const chunks = await this.#summarizeUniqueChunks(files);
    return {
      version: 1,
      chunkCount: chunks.length,
      totalBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
      markerTotals: this.#sumMarkers(chunks),
      chunks: chunks.sort((a, b) => b.score - a.score || b.bytes - a.bytes),
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
      });
    }
    return chunks;
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
