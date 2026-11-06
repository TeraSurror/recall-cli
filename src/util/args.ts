import { existsSync, statSync } from "node:fs";
import { expandHome } from "../config/paths.ts";

/**
 * Split a command line shell-style: "double" or 'single' quotes and backslash escapes keep
 * spaces inside one argument (so `/vault add "~/My Vault"` and `~/My\ Vault` both work).
 * An unterminated quote runs to the end of the line.
 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const isDir = (p: string) => {
  try {
    return existsSync(expandHome(p)) && statSync(expandHome(p)).isDirectory();
  } catch {
    return false;
  }
};

/** Normalize a dragged-in or pasted path: strip file:// and surrounding whitespace. */
function cleanPath(p: string): string {
  let s = p.trim();
  if (s.startsWith("file://")) s = decodeURIComponent(s.slice("file://".length));
  return s;
}

/**
 * Work out `<path> [name]` from already-split words, also accepting an unquoted path with
 * spaces (`/vault add ~/My Vault`) as long as it names an existing folder.
 */
export function parsePathAndName(words: string[]): { path?: string; name?: string } {
  if (!words.length) return {};
  const all = cleanPath(words.join(" "));
  if (words.length > 1 && isDir(all)) return { path: all };
  if (words.length > 2) {
    const head = cleanPath(words.slice(0, -1).join(" "));
    if (isDir(head)) return { path: head, name: words[words.length - 1] };
  }
  return { path: cleanPath(words[0]!), name: words[1] };
}
