import { realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { RecallError } from "../util/errors.ts";

/** Folders an agent must never read or write. */
const FORBIDDEN_TOP = new Set([".obsidian", ".git", ".trash", ".recall-internal"]);

/**
 * Normalize a vault-relative path from untrusted input (LLM / MCP client) and make sure it
 * stays inside the vault and out of internal folders. Returns a forward-slash relative path.
 */
export function cleanVaultPath(input: string): string {
  let p = input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
  if (!p || isAbsolute(p) || /^[a-zA-Z]:/.test(p)) throw new RecallError(`Invalid note path: "${input}"`);
  p = normalize(p).split(sep).join("/");
  if (p === ".." || p.startsWith("../")) throw new RecallError(`Path escapes the vault: "${input}"`);
  const top = p.split("/")[0]!;
  if (FORBIDDEN_TOP.has(top)) throw new RecallError(`Access to ${top}/ is not allowed.`);
  if (p.includes("\0")) throw new RecallError("Invalid path.");
  return p;
}

/** Absolute path for a vault-relative path, guaranteed to be inside `root`. */
export function safeVaultPath(root: string, rel: string): string {
  const clean = cleanVaultPath(rel);
  const abs = join(root, clean);
  const back = relative(root, abs);
  if (back.startsWith("..") || isAbsolute(back)) throw new RecallError(`Path escapes the vault: "${rel}"`);
  return abs;
}

/**
 * Reject paths that resolve (through symlinks) outside the vault. Call before reading
 * existing files on behalf of an agent.
 */
export function assertRealInside(root: string, abs: string): void {
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = realpathSync(root);
    realAbs = realpathSync(abs);
  } catch {
    return; // doesn't exist (yet) — nothing to follow
  }
  const back = relative(realRoot, realAbs);
  if (back.startsWith("..") || isAbsolute(back)) {
    throw new RecallError("Path resolves outside the vault (symlink).");
  }
}

/** Ensure a note path ends in .md. */
export function withMd(p: string): string {
  return /\.md$/i.test(p) ? p : `${p}.md`;
}
