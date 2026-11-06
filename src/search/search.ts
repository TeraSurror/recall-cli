import type { IndexDb } from "../index/db.ts";
import { fromBlob, type Embedder, embedQuery } from "../index/embed.ts";

export interface SearchFilters {
  /** Notes must have ALL of these tags (nested tags match: "project" matches "project/alpha"). */
  tags?: string[];
  /** Vault-relative folder prefix, e.g. "Projects/". */
  folder?: string;
  /** Only notes modified at or after this time (ms epoch). */
  modifiedAfter?: number;
}

export interface SearchHit {
  path: string;
  name: string;
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
  score: number;
  /** Which retrievers found this chunk. */
  via: ("keyword" | "semantic")[];
}

interface ChunkRow {
  id: number;
  path: string;
  name: string;
  heading: string;
  text: string;
  start_line: number;
  end_line: number;
}

/** Build a WHERE fragment over `n` (notes) for the filters. */
function filterSql(f: SearchFilters): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.folder) {
    const prefix = f.folder.replace(/^\/+/, "").replace(/\/?$/, "/");
    parts.push("n.path LIKE ? ESCAPE '\\'");
    params.push(prefix.replace(/[\\%_]/g, (c) => `\\${c}`) + "%");
  }
  for (const tag of f.tags ?? []) {
    const t = tag.replace(/^#/, "").toLowerCase();
    parts.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND (t.tag = ? OR t.tag LIKE ? ESCAPE '\\'))");
    params.push(t, t.replace(/[\\%_]/g, (c) => `\\${c}`) + "/%");
  }
  if (f.modifiedAfter) {
    parts.push("n.mtime >= ?");
    params.push(f.modifiedAfter);
  }
  return { sql: parts.length ? `AND ${parts.join(" AND ")}` : "", params };
}

/** Turn free text into a forgiving FTS5 query: each term prefix-matched, OR'ed, ranked by bm25. */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .toLowerCase()
    .match(/[\p{L}\p{N}_]+/gu)
    ?.filter((t) => t.length > 1 || /\p{N}/u.test(t));
  if (!terms?.length) return null;
  return [...new Set(terms)].map((t) => `"${t}"*`).join(" OR ");
}

export function keywordSearch(db: IndexDb, query: string, filters: SearchFilters = {}, limit = 50): SearchHit[] {
  const fts = toFtsQuery(query);
  if (!fts) return [];
  const f = filterSql(filters);
  const rows = db
    .query(
      `SELECT c.id, c.path, n.name, c.heading, c.text, c.start_line, c.end_line,
              bm25(chunks_fts, 5.0, 2.0, 1.0) AS rank
       FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.path = c.path
       WHERE chunks_fts MATCH ? ${f.sql}
       ORDER BY rank LIMIT ?`,
    )
    .all(fts, ...f.params, limit) as (ChunkRow & { rank: number })[];
  return rows.map((r) => toHit(r, -r.rank, "keyword"));
}

/** In-memory vector cache per DB; refreshed when the embedded-chunk set changes. */
const vectorCache = new WeakMap<IndexDb, { key: string; ids: Int32Array; vecs: Float32Array[] }>();

function loadVectors(db: IndexDb, model: string) {
  const sig = db
    .query("SELECT count(*) AS n, coalesce(max(id), 0) AS m FROM chunks WHERE embed_model = ?")
    .get(model) as { n: number; m: number };
  const key = `${model}:${sig.n}:${sig.m}`;
  const cached = vectorCache.get(db);
  if (cached?.key === key) return cached;
  const rows = db.query("SELECT id, embedding FROM chunks WHERE embed_model = ?").all(model) as {
    id: number;
    embedding: Uint8Array;
  }[];
  const entry = { key, ids: Int32Array.from(rows.map((r) => r.id)), vecs: rows.map((r) => fromBlob(r.embedding)) };
  vectorCache.set(db, entry);
  return entry;
}

export function vectorSearchWith(
  db: IndexDb,
  model: string,
  q: Float32Array,
  filters: SearchFilters = {},
  limit = 50,
): SearchHit[] {
  const { ids, vecs } = loadVectors(db, model);
  if (ids.length === 0) return [];
  const scored: { id: number; s: number }[] = [];
  for (let i = 0; i < vecs.length; i++) {
    const v = vecs[i]!;
    if (v.length !== q.length) continue;
    let s = 0;
    for (let j = 0; j < v.length; j++) s += v[j]! * q[j]!;
    scored.push({ id: ids[i]!, s });
  }
  scored.sort((a, b) => b.s - a.s);
  // Over-fetch then filter by note-level constraints in SQL.
  const f = filterSql(filters);
  const pick = db.query(
    `SELECT c.id, c.path, n.name, c.heading, c.text, c.start_line, c.end_line
     FROM chunks c JOIN notes n ON n.path = c.path WHERE c.id = ? ${f.sql}`,
  );
  const out: SearchHit[] = [];
  for (const { id, s } of scored) {
    if (out.length >= limit) break;
    const row = pick.get(id, ...f.params) as ChunkRow | null;
    if (row) out.push(toHit(row, s, "semantic"));
  }
  return out;
}

function toHit(r: ChunkRow, score: number, via: "keyword" | "semantic"): SearchHit {
  return {
    path: r.path,
    name: r.name,
    heading: r.heading,
    text: r.text,
    startLine: r.start_line,
    endLine: r.end_line,
    score,
    via: [via],
  };
}

/** Reciprocal-rank fusion of several ranked lists (k=60). Dedupe by chunk identity. */
export function rrf(lists: SearchHit[][], k = 60): SearchHit[] {
  const merged = new Map<string, SearchHit>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const key = `${hit.path}:${hit.startLine}`;
      const add = 1 / (k + rank + 1);
      const prev = merged.get(key);
      if (prev) {
        prev.score += add;
        for (const v of hit.via) if (!prev.via.includes(v)) prev.via.push(v);
      } else {
        merged.set(key, { ...hit, via: [...hit.via], score: add });
      }
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

export interface HybridOptions {
  filters?: SearchFilters;
  limit?: number;
  embedder?: Embedder | null;
  signal?: AbortSignal;
  /** Collapse to the best chunk per note. Default true. */
  perNote?: boolean;
}

export interface HybridResult {
  hits: SearchHit[];
  mode: "hybrid" | "keyword";
  /** Set when semantic search was attempted but failed (e.g. Ollama not running). */
  semanticError?: string;
}

export async function hybridSearch(db: IndexDb, query: string, opts: HybridOptions = {}): Promise<HybridResult> {
  const limit = opts.limit ?? 10;
  const kw = keywordSearch(db, query, opts.filters, 50);
  let sem: SearchHit[] = [];
  let semanticError: string | undefined;
  let mode: HybridResult["mode"] = "keyword";
  if (opts.embedder) {
    const hasVectors = db.query("SELECT 1 FROM chunks WHERE embed_model = ? LIMIT 1").get(opts.embedder.id);
    if (hasVectors) {
      try {
        const q = await embedQuery(opts.embedder, query, opts.signal);
        sem = vectorSearchWith(db, opts.embedder.id, q, opts.filters, 50);
        mode = "hybrid";
      } catch (e) {
        semanticError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  let hits = mode === "hybrid" ? rrf([kw, sem]) : kw;
  if (opts.perNote !== false) {
    const seen = new Set<string>();
    hits = hits.filter((h) => (seen.has(h.path) ? false : (seen.add(h.path), true)));
  }
  return { hits: hits.slice(0, limit), mode, semanticError };
}
