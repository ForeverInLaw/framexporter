import type { ConvertedPage, SharedComponent } from "./types.js";

type BlockOccurrence = {
  readonly pageIndex: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly indent: string;
  readonly values: string[];
};

type BlockCandidate = {
  readonly signature: string;
  readonly template: string;
  readonly slotKinds: string[];
  readonly lineCount: number;
  readonly charCount: number;
  readonly occurrences: BlockOccurrence[];
};

type OpenElement = {
  readonly tagName: string;
  readonly startLine: number;
};

type SlotMatch = {
  readonly start: number;
  readonly end: number;
  readonly literal: string;
  readonly kind: string;
};

type Replacement = BlockOccurrence & {
  readonly component: SharedComponent;
};

const MIN_BLOCK_LINES = 5;
const MIN_BLOCK_CHARS = 180;
const MIN_OCCURRENCES = 3;
const MAX_COMPONENTS = 24;
const MAX_SLOTS = 10;
const STRING_LITERAL_PATTERN = '"(?:\\\\.|[^"\\\\])*"';
const TEXT_PATTERN = new RegExp(`^\\s*\\{(${STRING_LITERAL_PATTERN})\\}\\s*$`, "gm");
const ATTR_PATTERN = new RegExp(`\\b(href|src|srcSet|alt|title|aria-label|placeholder|content)=\\{(${STRING_LITERAL_PATTERN})\\}`, "g");

export class PropComponentExtractor {
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

    return [...candidates.values()].filter((candidate) => this.#isUsefulCandidate(candidate));
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

    const parameterized = this.#parameterize(body);
    if (!parameterized || parameterized.values.length > MAX_SLOTS) {
      return undefined;
    }

    const firstLine = blockLines[0] ?? "";
    const indent = firstLine.match(/^\s*/)?.[0] ?? "";
    return {
      signature: parameterized.signature,
      template: parameterized.template,
      slotKinds: parameterized.kinds,
      lineCount: blockLines.length,
      charCount: body.length,
      occurrences: [{ pageIndex, startLine, endLine, indent, values: parameterized.values }],
    };
  }

  #parameterize(body: string): { signature: string; template: string; kinds: string[]; values: string[] } | undefined {
    const matches = this.#slotMatches(body);
    if (matches.length === 0) {
      return undefined;
    }

    let signature = body;
    let template = body;
    const kinds: string[] = [];
    const values: string[] = [];

    [...matches].reverse().forEach((match, reversedIndex) => {
      const index = matches.length - reversedIndex - 1;
      const marker = `__FRAMEPORTER_SLOT_${index}__`;
      signature = `${signature.slice(0, match.start)}${marker}${signature.slice(match.end)}`;
      template = `${template.slice(0, match.start)}${marker}${template.slice(match.end)}`;
      kinds[index] = match.kind;
      values[index] = match.literal;
    });

    return { signature, template, kinds, values };
  }

  #slotMatches(body: string): SlotMatch[] {
    const matches: SlotMatch[] = [];
    for (const match of body.matchAll(ATTR_PATTERN)) {
      const literal = match[2];
      const start = (match.index ?? 0) + match[0].lastIndexOf(literal);
      matches.push({ start, end: start + literal.length, literal, kind: this.#propBaseName(match[1]) });
    }

    for (const match of body.matchAll(TEXT_PATTERN)) {
      const literal = match[1];
      const start = (match.index ?? 0) + match[0].indexOf(literal);
      matches.push({ start, end: start + literal.length, literal, kind: "text" });
    }

    return matches.sort((left, right) => left.start - right.start).filter((match, index, all) => index === 0 || match.start >= all[index - 1].end);
  }

  #isUsefulCandidate(candidate: BlockCandidate): boolean {
    if (candidate.occurrences.length < MIN_OCCURRENCES) {
      return false;
    }

    const variableSlots = this.#variableSlotIndexes(candidate);
    return variableSlots.length > 0 && variableSlots.length <= MAX_SLOTS;
  }

  #rankCandidates(candidates: BlockCandidate[]): BlockCandidate[] {
    return candidates.sort((left, right) => this.#benefit(right) - this.#benefit(left) || right.lineCount - left.lineCount);
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
        lines.splice(replacement.startLine, replacement.endLine - replacement.startLine + 1, this.#componentCall(replacement));
      }

      return {
        ...page,
        jsx: lines.join("\n"),
        componentImports: [...page.componentImports, ...new Set(replacements.map((replacement) => replacement.component.name))],
      };
    });
  }

  #toComponent(candidate: BlockCandidate, index: number): SharedComponent {
    const variableIndexes = this.#variableSlotIndexes(candidate);
    const propNames = this.#propNames(candidate, variableIndexes);
    return {
      name: `InferredComponent${index}`,
      fileName: `InferredComponent${index}.tsx`,
      body: this.#componentBody(candidate, variableIndexes, propNames),
      occurrenceCount: candidate.occurrences.length,
      props: propNames,
      propSlotIndexes: variableIndexes,
    };
  }

  #componentBody(candidate: BlockCandidate, variableIndexes: number[], propNames: string[]): string {
    let body = candidate.template;
    candidate.slotKinds.forEach((_, index) => {
      const marker = `__FRAMEPORTER_SLOT_${index}__`;
      const propIndex = variableIndexes.indexOf(index);
      const replacement = propIndex >= 0 ? `props.${propNames[propIndex]}` : candidate.occurrences[0].values[index];
      body = body.split(marker).join(replacement);
    });
    return body;
  }

  #componentCall(replacement: Replacement): string {
    const props = replacement.component.props ?? [];
    if (props.length === 0) {
      return `${replacement.indent}<${replacement.component.name} />`;
    }

    const slotIndexes = replacement.component.propSlotIndexes ?? props.map((_, index) => index);
    const assignments = props.map((propName, index) => `${propName}={${replacement.values[slotIndexes[index]]}}`).join(" ");
    return `${replacement.indent}<${replacement.component.name} ${assignments} />`;
  }

  #variableSlotIndexes(candidate: BlockCandidate): number[] {
    return candidate.slotKinds
      .map((_, index) => index)
      .filter((index) => new Set(candidate.occurrences.map((occurrence) => occurrence.values[index])).size > 1);
  }

  #propNames(candidate: BlockCandidate, variableIndexes: number[]): string[] {
    const counts = new Map<string, number>();
    return variableIndexes.map((index) => {
      const baseName = candidate.slotKinds[index];
      const count = (counts.get(baseName) ?? 0) + 1;
      counts.set(baseName, count);
      return count === 1 ? baseName : `${baseName}${count}`;
    });
  }

  #propBaseName(attributeName: string): string {
    if (attributeName === "aria-label") {
      return "label";
    }
    if (attributeName === "srcSet") {
      return "srcSet";
    }
    return attributeName;
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

