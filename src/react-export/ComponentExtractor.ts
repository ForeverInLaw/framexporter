import type { ConvertedPage, SharedComponent } from "./types.js";

type BlockOccurrence = {
  readonly pageIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: string;
};

type BlockCandidate = {
  readonly signature: string;
  readonly body: string;
  readonly lineCount: number;
  readonly charCount: number;
  readonly occurrences: BlockOccurrence[];
};

type OpenElement = {
  readonly tagName: string;
  readonly startLine: number;
};

const MIN_BLOCK_LINES = 8;
const MIN_BLOCK_CHARS = 280;
const MIN_OCCURRENCES = 2;
const MAX_COMPONENTS = 40;

export class ComponentExtractor {
  extract(pages: ConvertedPage[]): { pages: ConvertedPage[]; components: SharedComponent[] } {
    const candidates = this.#rankCandidates(this.#collectCandidates(pages));
    const selected = this.#selectReplacements(candidates, pages.length);
    const components = selected.map((candidate, index) => this.#toComponent(candidate, index + 1));
    const rewrittenPages = this.#rewritePages(pages, selected, components);

    return { pages: rewrittenPages, components };
  }

  #collectCandidates(pages: ConvertedPage[]): BlockCandidate[] {
    const candidates = new Map<string, BlockCandidate>();
    pages.forEach((page, pageIndex) => {
      for (const block of this.#collectPageBlocks(page.jsx, pageIndex)) {
        const existing = candidates.get(block.signature);
        if (existing) {
          existing.occurrences.push(...block.occurrences);
          continue;
        }
        candidates.set(block.signature, block);
      }
    });
    return [...candidates.values()].filter((candidate) => candidate.occurrences.length >= MIN_OCCURRENCES);
  }

  #collectPageBlocks(jsx: string, pageIndex: number): BlockCandidate[] {
    const lines = jsx.split("\n");
    const stack: OpenElement[] = [];
    const candidates: BlockCandidate[] = [];

    lines.forEach((line, lineIndex) => {
      const close = line.trim().match(/^<\/([A-Za-z][\w.-]*)>$/);
      if (close) {
        const open = this.#popMatchingElement(stack, close[1]);
        if (open) {
          const blockLines = lines.slice(open.startLine, lineIndex + 1);
          const candidate = this.#createCandidate(blockLines, pageIndex, open.startLine, lineIndex);
          if (candidate) {
            candidates.push(candidate);
          }
        }
        return;
      }

      const open = line.trim().match(/^<([A-Za-z][\w.-]*)(?:\s|>)/);
      if (open && !line.trim().endsWith("/>") && !line.trim().includes(`</${open[1]}>`)) {
        stack.push({ tagName: open[1], startLine: lineIndex });
      }
    });

    return candidates;
  }

  #createCandidate(blockLines: string[], pageIndex: number, startLine: number, endLine: number): BlockCandidate | undefined {
    if (blockLines.length < MIN_BLOCK_LINES) {
      return undefined;
    }

    const body = this.#stripCommonIndent(blockLines);
    if (body.length < MIN_BLOCK_CHARS || body.includes("<form ")) {
      return undefined;
    }

    const firstLine = blockLines[0] ?? "";
    const indent = firstLine.match(/^\s*/)?.[0] ?? "";
    return {
      signature: body,
      body,
      lineCount: blockLines.length,
      charCount: body.length,
      occurrences: [{ pageIndex, startLine, endLine, indent }],
    };
  }

  #rankCandidates(candidates: BlockCandidate[]): BlockCandidate[] {
    return candidates
      .filter((candidate) => candidate.occurrences.length >= MIN_OCCURRENCES)
      .sort((left, right) => this.#benefit(right) - this.#benefit(left) || right.lineCount - left.lineCount);
  }

  #selectReplacements(candidates: BlockCandidate[], pageCount: number): BlockCandidate[] {
    const occupied = Array.from({ length: pageCount }, () => new Set<number>());
    const selected: BlockCandidate[] = [];

    for (const candidate of candidates) {
      if (selected.length >= MAX_COMPONENTS) {
        break;
      }

      const available = candidate.occurrences.filter((occurrence) => !this.#isOccupied(occupied[occurrence.pageIndex], occurrence));
      if (available.length < MIN_OCCURRENCES) {
        continue;
      }

      for (const occurrence of available) {
        this.#markOccupied(occupied[occurrence.pageIndex], occurrence);
      }
      selected.push({ ...candidate, occurrences: available });
    }

    return selected;
  }

  #rewritePages(pages: ConvertedPage[], selected: BlockCandidate[], components: SharedComponent[]): ConvertedPage[] {
    return pages.map((page, pageIndex) => {
      const replacements = selected.flatMap((candidate, index) => candidate.occurrences
        .filter((occurrence) => occurrence.pageIndex === pageIndex)
        .map((occurrence) => ({ ...occurrence, component: components[index] })))
        .sort((left, right) => right.startLine - left.startLine);

      if (replacements.length === 0) {
        return page;
      }

      const lines = page.jsx.split("\n");
      for (const replacement of replacements) {
        lines.splice(replacement.startLine, replacement.endLine - replacement.startLine + 1, `${replacement.indent}<${replacement.component.name} />`);
      }

      return {
        ...page,
        jsx: lines.join("\n"),
        componentImports: [...page.componentImports, ...new Set(replacements.map((replacement) => replacement.component.name))],
      };
    });
  }

  #toComponent(candidate: BlockCandidate, index: number): SharedComponent {
    return {
      name: `GeneratedComponent${index}`,
      fileName: `GeneratedComponent${index}.tsx`,
      body: candidate.body,
      occurrenceCount: candidate.occurrences.length,
    };
  }

  #popMatchingElement(stack: OpenElement[], tagName: string): OpenElement | undefined {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const open = stack.pop();
      if (open?.tagName === tagName) {
        return open;
      }
    }
    return undefined;
  }

  #stripCommonIndent(lines: string[]): string {
    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^\s*/)?.[0].length ?? 0));
    return lines.map((line) => line.slice(minIndent).trimEnd()).join("\n");
  }

  #benefit(candidate: BlockCandidate): number {
    return candidate.charCount * (candidate.occurrences.length - 1);
  }

  #isOccupied(occupied: Set<number>, occurrence: BlockOccurrence): boolean {
    for (let line = occurrence.startLine; line <= occurrence.endLine; line += 1) {
      if (occupied.has(line)) {
        return true;
      }
    }
    return false;
  }

  #markOccupied(occupied: Set<number>, occurrence: BlockOccurrence): void {
    for (let line = occurrence.startLine; line <= occurrence.endLine; line += 1) {
      occupied.add(line);
    }
  }
}
