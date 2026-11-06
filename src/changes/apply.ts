import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Workspace } from "../workspace.ts";
import { snapshotDir } from "../config/paths.ts";
import { RecallError } from "../util/errors.ts";
import { changePaths, type Changeset, type FileChange } from "./changeset.ts";
import { safeVaultPath } from "../vault/paths.ts";

export interface AppliedRecord {
  changeset: Changeset;
  sessionId: string;
  appliedAt: number;
  /** Where deleted notes went (vault-relative), keyed by original path. */
  trashed: Record<string, string>;
}

function atomicWrite(abs: string, text: string): void {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.recall-tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, abs);
}

function readIfExists(abs: string): string | null {
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
}

/** Verify the files on disk still match what the changeset was computed from. */
function checkPreconditions(root: string, c: FileChange): void {
  const cur = readIfExists(safeVaultPath(root, c.path));
  if (c.kind === "create") {
    if (cur !== null) throw new RecallError(`${c.path} already exists.`);
    return;
  }
  // A case-only rename (a.md → A.md) is the same file on case-insensitive filesystems.
  if (c.kind === "move" && c.newPath.toLowerCase() !== c.path.toLowerCase()) {
    if (readIfExists(safeVaultPath(root, c.newPath)) !== null) throw new RecallError(`${c.newPath} already exists.`);
  }
  if (cur === null) throw new RecallError(`${c.path} no longer exists.`);
  if (cur !== c.before) {
    throw new RecallError(`${c.path} changed on disk since the edit was proposed; re-read it and try again.`);
  }
}

/** Move a deleted note into the vault's .trash/ (Obsidian's convention), avoiding name clashes. */
function trash(root: string, path: string): string {
  let rel = posix.join(".trash", path);
  for (let i = 1; existsSync(join(root, rel)); i++) {
    rel = posix.join(".trash", path.replace(/(\.md)?$/, ` ${i}$1`));
  }
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  renameSync(safeVaultPath(root, path), join(root, rel));
  return rel;
}

function journalDir(): string {
  return join(snapshotDir(), "journal");
}

function writeJournal(rec: AppliedRecord): void {
  mkdirSync(journalDir(), { recursive: true });
  const file = join(journalDir(), `${String(rec.appliedAt).padStart(15, "0")}-${rec.changeset.id}.json`);
  writeFileSync(file, JSON.stringify(rec));
}

/**
 * Apply an approved changeset: check preconditions for every file first (all-or-nothing
 * up front), journal it for undo, write atomically, then re-index the touched notes.
 */
export function applyChangeset(ws: Workspace, cs: Changeset, sessionId: string): AppliedRecord {
  const { vault, indexer } = ws.get(cs.vault);
  const root = vault.root;
  for (const c of cs.changes) checkPreconditions(root, c);

  const rec: AppliedRecord = { changeset: cs, sessionId, appliedAt: Date.now(), trashed: {} };
  const done: FileChange[] = [];
  try {
    for (const c of cs.changes) {
      switch (c.kind) {
        case "create":
        case "modify":
          atomicWrite(safeVaultPath(root, c.path), c.after);
          break;
        case "delete":
          rec.trashed[c.path] = trash(root, c.path);
          break;
        case "move": {
          const dest = safeVaultPath(root, c.newPath);
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(safeVaultPath(root, c.path), dest);
          if (c.after !== c.before) atomicWrite(dest, c.after);
          break;
        }
      }
      done.push(c);
    }
  } catch (e) {
    // Best-effort rollback of what we already wrote.
    revert(root, done, rec.trashed);
    throw e;
  }
  writeJournal(rec);
  for (const c of cs.changes) for (const p of changePaths(c)) indexer.indexFile(p);
  return rec;
}

function revert(root: string, changes: FileChange[], trashed: Record<string, string>): void {
  for (const c of [...changes].reverse()) {
    try {
      switch (c.kind) {
        case "create":
          rmSync(safeVaultPath(root, c.path), { force: true });
          break;
        case "modify":
          atomicWrite(safeVaultPath(root, c.path), c.before);
          break;
        case "delete": {
          const t = trashed[c.path];
          if (t) renameSync(join(root, t), safeVaultPath(root, c.path));
          break;
        }
        case "move":
          renameSync(safeVaultPath(root, c.newPath), safeVaultPath(root, c.path));
          atomicWrite(safeVaultPath(root, c.path), c.before);
          break;
      }
    } catch {
      // keep going; report via the original error
    }
  }
}

export function listJournal(): AppliedRecord[] {
  if (!existsSync(journalDir())) return [];
  return readdirSync(journalDir())
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(journalDir(), f), "utf8")) as AppliedRecord);
}

export interface UndoResult {
  record: AppliedRecord;
  restored: string[];
}

/**
 * Undo the most recent applied changeset (optionally limited to a session). Refuses if
 * any touched file was modified afterwards, unless `force`.
 */
export function undoLast(ws: Workspace, opts: { sessionId?: string; force?: boolean } = {}): UndoResult {
  const files = existsSync(journalDir()) ? readdirSync(journalDir()).filter((f) => f.endsWith(".json")).sort() : [];
  for (let i = files.length - 1; i >= 0; i--) {
    const file = join(journalDir(), files[i]!);
    const rec = JSON.parse(readFileSync(file, "utf8")) as AppliedRecord;
    if (opts.sessionId && rec.sessionId !== opts.sessionId) continue;
    const { vault, indexer } = ws.get(rec.changeset.vault);
    const root = vault.root;
    if (!opts.force) {
      for (const c of rec.changeset.changes) {
        const where = c.kind === "move" ? c.newPath : c.path;
        const cur = readIfExists(safeVaultPath(root, where));
        const expected = c.kind === "delete" ? null : c.after;
        if (cur !== expected) {
          throw new RecallError(
            `Can't undo "${rec.changeset.title}": ${where} was changed afterwards.`,
            "Use --force to restore anyway (later edits to that file will be lost).",
          );
        }
      }
    }
    revert(root, rec.changeset.changes, rec.trashed);
    rmSync(file);
    const restored = rec.changeset.changes.flatMap(changePaths);
    for (const p of restored) indexer.indexFile(p);
    return { record: rec, restored };
  }
  throw new RecallError(opts.sessionId ? "Nothing to undo in this session." : "Nothing to undo.");
}
