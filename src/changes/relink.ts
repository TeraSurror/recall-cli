import { posix } from "node:path";
import { parseNote, type WikiLink } from "../parse/note.ts";
import { LinkResolver } from "../index/resolve.ts";

/**
 * How a wikilink to `newPath` should be written. Mirrors Obsidian's "shortest path when
 * possible" setting: bare name if unique in the vault, otherwise the full path.
 * Links that were written with a folder keep a folder.
 */
export function wikiTargetFor(newPath: string, allPaths: string[], hadFolder: boolean): string {
  const noExt = newPath.replace(/\.md$/i, "");
  if (hadFolder) return noExt;
  const name = posix.basename(noExt).toLowerCase();
  const clash = allPaths.some((p) => p !== newPath && posix.basename(p, ".md").toLowerCase() === name);
  return clash ? noExt : posix.basename(noExt);
}

function encodeMdHref(p: string): string {
  return p.split("/").map((s) => encodeURIComponent(s).replace(/%2F/g, "/")).join("/");
}

function rewriteLink(text: string, l: WikiLink, newTarget: string, isMarkdown: boolean): string {
  const original = text.slice(l.start, l.end);
  if (!isMarkdown) {
    const bang = l.embed ? "!" : "";
    const sub = l.subpath ? `#${l.subpath}` : "";
    const alias = l.alias !== undefined ? `|${l.alias}` : "";
    return `${bang}[[${newTarget}${sub}${alias}]]`;
  }
  // [label](href "title") — swap just the href, keep the rest.
  const m = /^(!?\[[^\]]*\]\()(<?)([^)\s>]+)(>?)([^)]*\))$/.exec(original);
  if (!m) return original;
  const sub = l.subpath ? `#${encodeURIComponent(l.subpath)}` : "";
  return `${m[1]}${m[2]}${encodeMdHref(newTarget)}${sub}${m[4]}${m[5]}`;
}

/**
 * Rewrite every link in `text` (a note at `srcPath`) that resolves to `oldPath` so it
 * points at `newPath`. `resolverBefore` reflects the vault before the move.
 */
export function rewriteLinksTo(
  text: string,
  srcPath: string,
  oldPath: string,
  newPath: string,
  resolverBefore: LinkResolver,
  pathsAfter: string[],
  newSrcPath = srcPath,
): string {
  const note = parseNote(text);
  let out = "";
  let cursor = 0;
  for (const l of note.links) {
    if (l.target === "") continue; // same-note anchor
    if (resolverBefore.resolve(l.target, srcPath) !== oldPath) continue;
    let target: string;
    if (l.kind === "markdown") {
      target = posix.relative(posix.dirname(newSrcPath), newPath);
    } else {
      target = wikiTargetFor(newPath, pathsAfter, l.target.includes("/"));
    }
    out += text.slice(cursor, l.start) + rewriteLink(text, l, target, l.kind === "markdown");
    cursor = l.end;
  }
  return out + text.slice(cursor);
}

/**
 * When a note moves folders, its own relative markdown links need recomputing
 * (wikilinks are vault-absolute or name-based, so they're unaffected).
 */
export function rebaseOwnMarkdownLinks(text: string, oldPath: string, newPath: string, resolver: LinkResolver): string {
  if (posix.dirname(oldPath) === posix.dirname(newPath)) return text;
  const note = parseNote(text);
  let out = "";
  let cursor = 0;
  for (const l of note.links) {
    if (l.kind !== "markdown" || !(l.target.startsWith("./") || l.target.startsWith("../"))) continue;
    const resolved = resolver.resolve(l.target, oldPath);
    if (!resolved) continue;
    const target = posix.relative(posix.dirname(newPath), resolved);
    out += text.slice(cursor, l.start) + rewriteLink(text, l, target, true);
    cursor = l.end;
  }
  return out + text.slice(cursor);
}
