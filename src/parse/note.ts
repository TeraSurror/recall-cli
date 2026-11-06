import { parse as parseYaml } from "yaml";

export interface WikiLink {
  /** Link target as written, without heading/block/alias: `Folder/Note` in `[[Folder/Note#H|Alias]]`. */
  target: string;
  /** `#Heading` or `#^block` subpath, without the leading `#`. */
  subpath?: string;
  alias?: string;
  /** `![[...]]` embed. */
  embed: boolean;
  /** `[[..]]` wikilink vs `[..](..)` markdown link. */
  kind: "wiki" | "markdown";
  /** 0-based line in the full file. */
  line: number;
  /** Character offsets of the whole link in the full file (for rewriting). */
  start: number;
  end: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  /** Raw frontmatter block including the `---` fences, or "" if none. */
  frontmatterRaw: string;
  frontmatterError?: string;
  /** Content after the frontmatter. */
  body: string;
  /** Line number (0-based, in the full file) where the body starts. */
  bodyStartLine: number;
  /** Lowercased tags without '#', from both frontmatter and inline, deduplicated. */
  tags: string[];
  aliases: string[];
  links: WikiLink[];
  headings: Heading[];
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** Replace a range with spaces, keeping newlines so offsets and line numbers are stable. */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

/**
 * Mask regions where Obsidian does NOT parse links or tags: fenced code, inline code,
 * %% comments %%, HTML comments, and $$ math blocks. Output has identical length/lines.
 */
export function maskNonContent(text: string): string {
  let out = text;
  // Fenced code blocks (``` or ~~~, 3+), allowing indentation; unterminated fences run to EOF.
  out = out.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[`~]*[ \t]*$|(?![\s\S]))/gm, blank);
  out = out.replace(/%%[\s\S]*?%%/g, blank);
  out = out.replace(/<!--[\s\S]*?-->/g, blank);
  out = out.replace(/\$\$[\s\S]*?\$\$/g, blank);
  // Inline code: matching backtick runs on one line.
  out = out.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, blank);
  return out;
}

function toStringList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(toStringList);
  if (typeof v === "string") return v.split(/[,\s]+/).filter(Boolean);
  return [String(v)];
}

const TAG_RE = /(?<=^|[\s(\[{,;])#([\p{L}\p{N}_\/-]+)/gu;
const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;
const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;
const HEADING_RE = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm;

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, "").toLowerCase();
}

/** Obsidian requires at least one non-numeric character in a tag. */
function isValidTag(t: string): boolean {
  return /[^\d\/_-]/u.test(t);
}

export function parseNote(text: string): ParsedNote {
  let frontmatter: Record<string, unknown> = {};
  let frontmatterRaw = "";
  let frontmatterError: string | undefined;
  const fm = FM_RE.exec(text);
  if (fm) {
    frontmatterRaw = fm[0];
    try {
      const parsed = parseYaml(fm[1] ?? "");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch (e) {
      frontmatterError = e instanceof Error ? e.message.split("\n")[0] : String(e);
    }
  }
  const bodyOffset = frontmatterRaw.length;
  const body = text.slice(bodyOffset);
  const bodyStartLine = frontmatterRaw ? frontmatterRaw.split("\n").length - (frontmatterRaw.endsWith("\n") ? 1 : 0) : 0;

  // Mask the full text but keep the frontmatter region blank so offsets are file-relative.
  const masked = blank(frontmatterRaw) + maskNonContent(body);
  const lineAt = lineIndexer(text);

  const tags = new Set<string>();
  for (const t of toStringList(frontmatter.tags ?? frontmatter.tag)) {
    const n = normalizeTag(t);
    if (n && isValidTag(n)) tags.add(n);
  }
  for (const m of masked.matchAll(TAG_RE)) {
    const n = normalizeTag(m[1]!);
    if (isValidTag(n)) tags.add(n.replace(/\/+$/, ""));
  }

  const aliases = toStringList(
    Array.isArray(frontmatter.aliases) || typeof frontmatter.aliases !== "string"
      ? frontmatter.aliases ?? frontmatter.alias
      : [frontmatter.aliases],
  );

  const links: WikiLink[] = [];
  for (const m of masked.matchAll(WIKI_RE)) {
    const start = m.index!;
    const inner = text.slice(start + m[1]!.length + 2, start + m[0].length - 2);
    const [targetPart, ...aliasParts] = inner.split("|");
    const hash = targetPart!.indexOf("#");
    const target = (hash >= 0 ? targetPart!.slice(0, hash) : targetPart!).trim();
    const subpath = hash >= 0 ? targetPart!.slice(hash + 1).trim() : undefined;
    links.push({
      target,
      subpath: subpath || undefined,
      alias: aliasParts.length ? aliasParts.join("|").trim() : undefined,
      embed: m[1] === "!",
      kind: "wiki",
      line: lineAt(start),
      start,
      end: start + m[0].length,
    });
  }
  for (const m of masked.matchAll(MD_LINK_RE)) {
    const start = m.index!;
    // Re-read from the original text: the URL may contain chars that masking touched.
    const href = m[3]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue; // external URL or same-note anchor
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {}
    const hash = decoded.indexOf("#");
    links.push({
      target: (hash >= 0 ? decoded.slice(0, hash) : decoded).replace(/\.md$/i, ""),
      subpath: hash >= 0 ? decoded.slice(hash + 1) || undefined : undefined,
      alias: m[2] || undefined,
      embed: m[1] === "!",
      kind: "markdown",
      line: lineAt(start),
      start,
      end: start + m[0].length,
    });
  }
  links.sort((a, b) => a.start - b.start);

  const headings: Heading[] = [];
  for (const m of masked.matchAll(HEADING_RE)) {
    headings.push({
      level: m[1]!.length,
      text: text.slice(m.index! + m[1]!.length, m.index! + m[0].length).replace(/[ \t#]*$/, "").trim(),
      line: lineAt(m.index!),
    });
  }

  return {
    frontmatter,
    frontmatterRaw,
    frontmatterError,
    body,
    bodyStartLine,
    tags: [...tags].sort(),
    aliases,
    links,
    headings,
  };
}

/** Returns a function mapping a char offset to a 0-based line number (binary search). */
export function lineIndexer(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}
