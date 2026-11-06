import type { ParsedNote } from "./note.ts";

export interface Chunk {
  index: number;
  /** Breadcrumb of headings, e.g. "Goals > Q3". Empty for the preamble. */
  headingPath: string;
  /** Raw chunk text from the note. */
  text: string;
  /** 0-based inclusive line range in the full file. */
  startLine: number;
  endLine: number;
}

export interface ChunkOptions {
  maxChars: number;
  /** Sections smaller than this are merged into the next sibling chunk when possible. */
  minChars: number;
}

const DEFAULTS: ChunkOptions = { maxChars: 1500, minChars: 200 };

interface Section {
  headingPath: string;
  lines: string[];
  startLine: number;
}

/**
 * Split a note into heading-scoped chunks. Each heading starts a new section; long
 * sections are split on blank lines (never inside a fenced code block), then by lines.
 */
export function chunkNote(text: string, note: ParsedNote, opts: Partial<ChunkOptions> = {}): Chunk[] {
  const o = { ...DEFAULTS, ...opts };
  const allLines = text.split("\n");
  const headingByLine = new Map(note.headings.map((h) => [h.line, h]));

  const sections: Section[] = [];
  const stack: { level: number; text: string }[] = [];
  let cur: Section = { headingPath: "", lines: [], startLine: note.bodyStartLine };
  for (let i = note.bodyStartLine; i < allLines.length; i++) {
    const h = headingByLine.get(i);
    if (h) {
      if (cur.lines.some((l) => l.trim())) sections.push(cur);
      while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
      stack.push({ level: h.level, text: h.text });
      cur = { headingPath: stack.map((s) => s.text).join(" > "), lines: [allLines[i]!], startLine: i };
    } else {
      cur.lines.push(allLines[i]!);
    }
  }
  if (cur.lines.some((l) => l.trim())) sections.push(cur);

  const chunks: Chunk[] = [];
  const push = (headingPath: string, lines: string[], startLine: number) => {
    // Trim blank lines at both ends, adjusting line numbers.
    let a = 0;
    let b = lines.length - 1;
    while (a <= b && !lines[a]!.trim()) a++;
    while (b >= a && !lines[b]!.trim()) b--;
    if (a > b) return;
    chunks.push({
      index: chunks.length,
      headingPath,
      text: lines.slice(a, b + 1).join("\n"),
      startLine: startLine + a,
      endLine: startLine + b,
    });
  };

  for (const s of sections) {
    const size = s.lines.join("\n").length;
    if (size <= o.maxChars) {
      push(s.headingPath, s.lines, s.startLine);
      continue;
    }
    // Group into blocks separated by blank lines, keeping code fences intact.
    const blocks: { start: number; end: number }[] = [];
    let inFence: string | null = null;
    let bStart = 0;
    for (let i = 0; i < s.lines.length; i++) {
      const line = s.lines[i]!;
      const fence = /^[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (!inFence) inFence = fence[1]![0]!;
        else if (fence[1]![0] === inFence) inFence = null;
      }
      if (!inFence && !line.trim()) {
        if (i > bStart) blocks.push({ start: bStart, end: i });
        bStart = i + 1;
      }
    }
    if (bStart < s.lines.length) blocks.push({ start: bStart, end: s.lines.length });

    let accStart = -1;
    let accEnd = -1;
    let accLen = 0;
    const flush = () => {
      if (accStart >= 0) push(s.headingPath, s.lines.slice(accStart, accEnd), s.startLine + accStart);
      accStart = -1;
      accLen = 0;
    };
    for (const blk of blocks) {
      const len = s.lines.slice(blk.start, blk.end).join("\n").length;
      if (len > o.maxChars) {
        // Oversized single block: hard split by lines.
        flush();
        let ls = blk.start;
        let l = 0;
        for (let i = blk.start; i < blk.end; i++) {
          l += s.lines[i]!.length + 1;
          if (l >= o.maxChars) {
            push(s.headingPath, s.lines.slice(ls, i + 1), s.startLine + ls);
            ls = i + 1;
            l = 0;
          }
        }
        if (ls < blk.end) push(s.headingPath, s.lines.slice(ls, blk.end), s.startLine + ls);
        continue;
      }
      if (accStart >= 0 && accLen + len > o.maxChars) flush();
      if (accStart < 0) accStart = blk.start;
      accEnd = blk.end;
      accLen += len + 2;
    }
    flush();
  }

  // Merge tiny chunks into their successor when they share a heading prefix and fit.
  const merged: Chunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.text.length < o.minChars &&
      prev.text.length + c.text.length + 2 <= o.maxChars &&
      (c.headingPath === prev.headingPath || c.headingPath.startsWith(prev.headingPath))
    ) {
      prev.text = `${prev.text}\n\n${c.text}`;
      prev.endLine = c.endLine;
      prev.headingPath = prev.headingPath || c.headingPath;
      continue;
    }
    merged.push({ ...c });
  }
  return merged.map((c, i) => ({ ...c, index: i }));
}
