import { embed, embedMany, type EmbeddingModel } from "ai";
import type { IndexDb } from "./db.ts";

export interface Embedder {
  /** Stable identifier stored next to vectors, e.g. "ollama/nomic-embed-text". */
  id: string;
  model: EmbeddingModel;
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 0;
  for (let i = 0; i < v.length; i++) out[i] = v[i]! * inv;
  return out;
}

export function toBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Uint8Array): Float32Array {
  // Copy so the vector is 4-byte aligned regardless of how SQLite handed us the buffer.
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}

/** Text that gets embedded for a chunk: note name and heading path give the vector context. */
export function chunkEmbeddingText(name: string, heading: string, text: string): string {
  return `${name}${heading ? ` > ${heading}` : ""}\n\n${text}`;
}

export interface EmbedProgress {
  done: number;
  total: number;
}

/**
 * Embed every chunk missing a vector for this embedder (or embedded by a different model).
 * Batched, resumable: progress is committed per batch.
 */
export async function embedPending(
  db: IndexDb,
  embedder: Embedder,
  opts: { batchSize?: number; onProgress?: (p: EmbedProgress) => void; signal?: AbortSignal } = {},
): Promise<number> {
  const batchSize = opts.batchSize ?? 64;
  const { total } = db
    .query("SELECT count(*) AS total FROM chunks WHERE embedding IS NULL OR embed_model IS NOT ?")
    .get(embedder.id) as { total: number };
  if (total === 0) return 0;

  const select = db.query(
    `SELECT c.id, c.heading, c.text, n.name FROM chunks c JOIN notes n ON n.path = c.path
     WHERE c.embedding IS NULL OR c.embed_model IS NOT ? ORDER BY c.id LIMIT ?`,
  );
  const update = db.query("UPDATE chunks SET embedding = ?, embed_model = ? WHERE id = ?");
  let done = 0;
  while (done < total) {
    opts.signal?.throwIfAborted();
    const rows = select.all(embedder.id, batchSize) as { id: number; heading: string; text: string; name: string }[];
    if (rows.length === 0) break;
    const { embeddings } = await embedMany({
      model: embedder.model,
      values: rows.map((r) => chunkEmbeddingText(r.name, r.heading, r.text)),
      abortSignal: opts.signal,
    });
    db.transaction(() => {
      rows.forEach((r, i) => update.run(toBlob(normalize(embeddings[i]!)), embedder.id, r.id));
    })();
    done += rows.length;
    opts.onProgress?.({ done, total });
  }
  return done;
}

export async function embedQuery(embedder: Embedder, text: string, signal?: AbortSignal): Promise<Float32Array> {
  const { embedding } = await embed({ model: embedder.model, value: text, abortSignal: signal });
  return normalize(embedding);
}
