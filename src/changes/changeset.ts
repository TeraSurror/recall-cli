import { createTwoFilesPatch, diffLines } from "diff";

export type FileChange =
  | { kind: "create"; path: string; after: string }
  | { kind: "modify"; path: string; before: string; after: string }
  | { kind: "delete"; path: string; before: string }
  | { kind: "move"; path: string; newPath: string; before: string; after: string };

export interface Changeset {
  id: string;
  vault: string;
  /** One-line human summary, e.g. "Move Alpha Plan.md → Archive/ (rewrites 3 backlinks)". */
  title: string;
  /** Tool that produced it. */
  tool: string;
  changes: FileChange[];
}

let seq = 0;
export function newChangesetId(): string {
  return `${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

export function changePaths(c: FileChange): string[] {
  return c.kind === "move" ? [c.path, c.newPath] : [c.path];
}

/** Unified diff for one file change (for the TUI, MCP previews and logs). */
export function fileDiff(c: FileChange, context = 3): string {
  switch (c.kind) {
    case "create":
      return createTwoFilesPatch("/dev/null", `b/${c.path}`, "", c.after, "", "", { context });
    case "delete":
      return createTwoFilesPatch(`a/${c.path}`, "/dev/null", c.before, "", "", "", { context });
    case "modify":
      return createTwoFilesPatch(`a/${c.path}`, `b/${c.path}`, c.before, c.after, "", "", { context });
    case "move":
      return c.before === c.after
        ? `rename ${c.path} → ${c.newPath}\n`
        : createTwoFilesPatch(`a/${c.path}`, `b/${c.newPath}`, c.before, c.after, "", "", { context });
  }
}

export function changesetDiff(cs: Changeset, context = 3): string {
  return cs.changes.map((c) => fileDiff(c, context)).join("\n");
}

export interface DiffStats {
  files: number;
  added: number;
  removed: number;
}

export function diffStats(cs: Changeset): DiffStats {
  let added = 0;
  let removed = 0;
  for (const c of cs.changes) {
    const before = c.kind === "create" ? "" : c.before;
    const after = c.kind === "delete" ? "" : c.after;
    for (const part of diffLines(before, after)) {
      if (part.added) added += part.count ?? 0;
      else if (part.removed) removed += part.count ?? 0;
    }
  }
  return { files: cs.changes.length, added, removed };
}

/** Short summary line per file: "M Projects/a.md (+3 −1)". */
export function summarizeChanges(cs: Changeset): string[] {
  return cs.changes.map((c) => {
    const tag = { create: "A", modify: "M", delete: "D", move: "R" }[c.kind];
    return c.kind === "move" ? `${tag} ${c.path} → ${c.newPath}` : `${tag} ${c.path}`;
  });
}
