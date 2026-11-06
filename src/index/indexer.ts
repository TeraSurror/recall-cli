import { readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import picomatch from "picomatch";
import type { Vault } from "../vault/registry.ts";
import { BUILTIN_EXCLUDES } from "../vault/registry.ts";
import { parseNote } from "../parse/note.ts";
import { chunkNote } from "../parse/chunk.ts";
import type { IndexDb } from "./db.ts";
import { LinkResolver } from "./resolve.ts";

export interface IndexStats {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  ms: number;
}

export function toVaultPath(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

export function makeExcluder(vault: Vault): (relPath: string) => boolean {
  const isMatch = picomatch([...BUILTIN_EXCLUDES, ...vault.config.exclude], { dot: true });
  return (rel) => isMatch(rel) || rel.split("/").some((seg) => seg.startsWith("."));
}

/** List all indexable markdown files in the vault (vault-relative paths). */
export function scanVault(vault: Vault): string[] {
  const excluded = makeExcluder(vault);
  const out: string[] = [];
  for (const rel of new Bun.Glob("**/*.md").scanSync({ cwd: vault.root, dot: false, followSymlinks: false })) {
    const p = rel.split(sep).join("/");
    if (!excluded(p)) out.push(p);
  }
  return out.sort();
}

function hashText(text: string): string {
  return Bun.hash(text).toString(16);
}

export class Indexer {
  private resolver: LinkResolver | null = null;

  constructor(
    readonly vault: Vault,
    readonly db: IndexDb,
  ) {}

  private getResolver(): LinkResolver {
    if (!this.resolver) {
      const paths = (this.db.query("SELECT path FROM notes").all() as { path: string }[]).map((r) => r.path);
      this.resolver = new LinkResolver(paths);
    }
    return this.resolver;
  }

  /** Incrementally sync the index with the vault on disk. */
  sync(opts: { force?: boolean } = {}): IndexStats {
    const t0 = performance.now();
    const stats: IndexStats = { added: 0, updated: 0, removed: 0, unchanged: 0, ms: 0 };
    const onDisk = scanVault(this.vault);
    const known = new Map(
      (this.db.query("SELECT path, mtime, size, hash FROM notes").all() as {
        path: string;
        mtime: number;
        size: number;
        hash: string;
      }[]).map((r) => [r.path, r]),
    );

    const changed: { path: string; text: string; mtime: number; size: number; hash: string; isNew: boolean }[] = [];
    for (const path of onDisk) {
      let st;
      try {
        st = statSync(join(this.vault.root, path));
      } catch {
        continue; // vanished mid-scan
      }
      const prev = known.get(path);
      known.delete(path);
      if (!opts.force && prev && prev.mtime === st.mtimeMs && prev.size === st.size) {
        stats.unchanged++;
        continue;
      }
      const text = readFileSync(join(this.vault.root, path), "utf8");
      const hash = hashText(text);
      if (!opts.force && prev && prev.hash === hash) {
        this.db.query("UPDATE notes SET mtime = ?, size = ? WHERE path = ?").run(st.mtimeMs, st.size, path);
        stats.unchanged++;
        continue;
      }
      changed.push({ path, text, mtime: st.mtimeMs, size: st.size, hash, isNew: !prev });
    }
    const removed = [...known.keys()];

    const structural = removed.length > 0 || changed.some((c) => c.isNew);
    this.db.transaction(() => {
      for (const path of removed) this.deleteNote(path);
      // Insert note rows first so link resolution sees every new note.
      const resolver = this.getResolver();
      for (const p of removed) resolver.remove(p);
      for (const c of changed) if (c.isNew) resolver.add(c.path);
      for (const c of changed) {
        this.writeNote(c.path, c.text, c.mtime, c.size, c.hash);
        if (c.isNew) stats.added++;
        else stats.updated++;
      }
      if (structural) this.reresolveAll();
    })();
    stats.removed = removed.length;
    stats.ms = Math.round(performance.now() - t0);
    return stats;
  }

  /** Index (or re-index) a single file; used by the watcher and after agent writes. */
  indexFile(path: string): "added" | "updated" | "unchanged" | "removed" {
    const abs = join(this.vault.root, path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return this.removeFile(path) ? "removed" : "unchanged";
    }
    if (makeExcluder(this.vault)(path) || !path.endsWith(".md")) return "unchanged";
    const text = readFileSync(abs, "utf8");
    const hash = hashText(text);
    const prev = this.db.query("SELECT hash FROM notes WHERE path = ?").get(path) as { hash: string } | null;
    if (prev?.hash === hash) {
      this.db.query("UPDATE notes SET mtime = ?, size = ? WHERE path = ?").run(st.mtimeMs, st.size, path);
      return "unchanged";
    }
    this.db.transaction(() => {
      if (!prev) this.getResolver().add(path);
      this.writeNote(path, text, st.mtimeMs, st.size, hash);
      if (!prev) this.reresolveAll();
    })();
    return prev ? "updated" : "added";
  }

  removeFile(path: string): boolean {
    const exists = this.db.query("SELECT 1 FROM notes WHERE path = ?").get(path);
    if (!exists) return false;
    this.db.transaction(() => {
      this.deleteNote(path);
      this.getResolver().remove(path);
      this.reresolveAll();
    })();
    return true;
  }

  private deleteNote(path: string): void {
    const ids = this.db.query("SELECT id FROM chunks WHERE path = ?").all(path) as { id: number }[];
    const del = this.db.query("DELETE FROM chunks_fts WHERE rowid = ?");
    for (const { id } of ids) del.run(id);
    this.db.query("DELETE FROM notes WHERE path = ?").run(path); // cascades tags, links, chunks
  }

  private writeNote(path: string, text: string, mtime: number, size: number, hash: string): void {
    const note = parseNote(text);
    const name = posix.basename(path, ".md");
    const prevEmbeddings = new Map<string, { embedding: Uint8Array; model: string }>();
    // Keep embeddings for chunks whose text didn't change, so edits don't re-embed the whole note.
    for (const r of this.db
      .query("SELECT heading, text, embedding, embed_model FROM chunks WHERE path = ? AND embedding IS NOT NULL")
      .all(path) as { heading: string; text: string; embedding: Uint8Array; embed_model: string }[]) {
      prevEmbeddings.set(`${r.heading}\u0000${r.text}`, { embedding: r.embedding, model: r.embed_model });
    }
    this.deleteNote(path);

    this.db
      .query(
        "INSERT INTO notes (path, name, mtime, size, hash, frontmatter, aliases, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(path, name, mtime, size, hash, JSON.stringify(note.frontmatter ?? {}), JSON.stringify(note.aliases), Date.now());

    const insTag = this.db.query("INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)");
    for (const tag of note.tags) insTag.run(path, tag);

    const resolver = this.getResolver();
    const insLink = this.db.query(
      "INSERT INTO links (src, target, resolved, subpath, embed, line) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const l of note.links) {
      insLink.run(path, l.target, resolver.resolve(l.target, path), l.subpath ?? null, l.embed ? 1 : 0, l.line);
    }

    const insChunk = this.db.query(
      "INSERT INTO chunks (path, idx, heading, text, start_line, end_line, embedding, embed_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    );
    const insFts = this.db.query("INSERT INTO chunks_fts (rowid, name, heading, text) VALUES (?, ?, ?, ?)");
    for (const c of chunkNote(text, note)) {
      const prev = prevEmbeddings.get(`${c.headingPath}\u0000${c.text}`);
      const { id } = insChunk.get(
        path,
        c.index,
        c.headingPath,
        c.text,
        c.startLine,
        c.endLine,
        prev?.embedding ?? null,
        prev?.model ?? null,
      ) as { id: number };
      insFts.run(id, name, c.headingPath, c.text);
    }
  }

  /** Recompute `links.resolved` for all links (needed when notes are added/removed). */
  private reresolveAll(): void {
    const resolver = this.getResolver();
    const rows = this.db.query("SELECT rowid, src, target, resolved FROM links").all() as {
      rowid: number;
      src: string;
      target: string;
      resolved: string | null;
    }[];
    const upd = this.db.query("UPDATE links SET resolved = ? WHERE rowid = ?");
    for (const r of rows) {
      const next = resolver.resolve(r.target, r.src);
      if (next !== r.resolved) upd.run(next, r.rowid);
    }
  }
}
