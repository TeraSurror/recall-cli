import type { IndexDb } from "../index/db.ts";
import { isAttachmentTarget } from "../index/resolve.ts";

export interface LinkRef {
  path: string;
  line: number;
  target: string;
  subpath: string | null;
  embed: boolean;
}

export function backlinks(db: IndexDb, path: string): LinkRef[] {
  return (
    db
      .query("SELECT src AS path, line, target, subpath, embed FROM links WHERE resolved = ? AND src != ? ORDER BY src, line")
      .all(path, path) as (Omit<LinkRef, "embed"> & { embed: number })[]
  ).map((r) => ({ ...r, embed: !!r.embed }));
}

export interface OutLink {
  target: string;
  resolved: string | null;
  subpath: string | null;
  line: number;
  embed: boolean;
}

export function outlinks(db: IndexDb, path: string): OutLink[] {
  return (
    db
      .query("SELECT target, resolved, subpath, line, embed FROM links WHERE src = ? ORDER BY line")
      .all(path) as (Omit<OutLink, "embed"> & { embed: number })[]
  ).map((r) => ({ ...r, embed: !!r.embed }));
}

/** Notes with no incoming links from other notes (and, optionally, no outgoing links either). */
export function orphans(db: IndexDb, opts: { strict?: boolean; folder?: string } = {}): string[] {
  const rows = db
    .query(
      `SELECT n.path FROM notes n
       WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.resolved = n.path AND l.src != n.path)
       ${opts.strict ? "AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src = n.path AND l.resolved IS NOT NULL)" : ""}
       ${opts.folder ? "AND n.path LIKE ?" : ""}
       ORDER BY n.path`,
    )
    .all(...(opts.folder ? [opts.folder.replace(/\/?$/, "/") + "%"] : [])) as { path: string }[];
  return rows.map((r) => r.path);
}

/** Links pointing at notes that don't exist (excluding attachments). */
export function unresolvedLinks(db: IndexDb): { src: string; target: string; line: number }[] {
  return (
    db.query("SELECT src, target, line FROM links WHERE resolved IS NULL AND target != '' ORDER BY target, src").all() as {
      src: string;
      target: string;
      line: number;
    }[]
  ).filter((r) => !isAttachmentTarget(r.target));
}

export function tagCounts(db: IndexDb, prefix?: string): { tag: string; count: number }[] {
  return db
    .query(
      `SELECT tag, count(*) AS count FROM tags ${prefix ? "WHERE tag = ? OR tag LIKE ?" : ""} GROUP BY tag ORDER BY count DESC, tag`,
    )
    .all(...(prefix ? [prefix, `${prefix}/%`] : [])) as { tag: string; count: number }[];
}
