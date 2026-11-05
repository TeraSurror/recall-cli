import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { indexDir } from "../config/paths.ts";

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE notes (
    path TEXT PRIMARY KEY,           -- vault-relative, forward slashes, with .md
    name TEXT NOT NULL,              -- basename without extension (Obsidian's link name)
    mtime REAL NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    frontmatter TEXT NOT NULL DEFAULT '{}',
    aliases TEXT NOT NULL DEFAULT '[]',
    indexed_at REAL NOT NULL
  );
  CREATE INDEX notes_name ON notes(name COLLATE NOCASE);

  CREATE TABLE tags (
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (path, tag)
  );
  CREATE INDEX tags_tag ON tags(tag);

  CREATE TABLE links (
    src TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    target TEXT NOT NULL,           -- as written
    resolved TEXT,                  -- vault-relative path of the target note, NULL if unresolved
    subpath TEXT,
    embed INTEGER NOT NULL DEFAULT 0,
    line INTEGER NOT NULL
  );
  CREATE INDEX links_src ON links(src);
  CREATE INDEX links_resolved ON links(resolved);
  CREATE INDEX links_target ON links(target COLLATE NOCASE);

  CREATE TABLE chunks (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL REFERENCES notes(path) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    embedding BLOB,                 -- Float32Array, L2-normalized
    embed_model TEXT
  );
  CREATE INDEX chunks_path ON chunks(path);

  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    name, heading, text,
    tokenize = "porter unicode61 remove_diacritics 2"
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export type IndexDb = Database;

export function indexPath(vaultName: string): string {
  return join(indexDir(), `${vaultName}.db`);
}

export function openIndex(vaultName: string, path = indexPath(vaultName)): IndexDb {
  if (path !== ":memory:") mkdirSync(indexDir(), { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Index was created by a newer version of recall (schema v${current}). Run: recall index --rebuild`);
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.run(MIGRATIONS[v]!);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

export function getMeta(db: IndexDb, key: string): string | undefined {
  return (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
}

export function setMeta(db: IndexDb, key: string, value: string): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
