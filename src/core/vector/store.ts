import { Database } from "bun:sqlite";
import { getDbPath } from "../config/manager.ts";
import { VectorStoreError } from "../../utils/errors.ts";

export interface StoredDocument {
  id: number;
  path: string;
  title: string;
  content: string;
  metadata: string;
  indexed_at: string;
  modified_at: string;
}

export interface StoredChunk {
  id: number;
  document_id: number;
  content: string;
  chunk_index: number;
  heading: string | null;
  start_line: number;
  end_line: number;
  embedding: Uint8Array | null;
}

export interface SearchResult {
  documentId: number;
  chunkId: number;
  path: string;
  title: string;
  content: string;
  heading: string | null;
  score: number;
}

export class VectorStore {
  private db: Database;
  private dimensions: number;

  constructor(dimensions: number = 768) {
    this.dimensions = dimensions;
    this.db = new Database(getDbPath());
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT UNIQUE NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modified_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        heading TEXT,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        embedding BLOB,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id);
    `);
  }

  getDocument(path: string): StoredDocument | null {
    const stmt = this.db.prepare("SELECT * FROM documents WHERE path = ?");
    return stmt.get(path) as StoredDocument | null;
  }

  insertDocument(
    path: string,
    title: string,
    content: string,
    metadata: Record<string, unknown>,
    modifiedAt: Date
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO documents (path, title, content, metadata, modified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        title = excluded.title,
        content = excluded.content,
        metadata = excluded.metadata,
        modified_at = excluded.modified_at,
        indexed_at = CURRENT_TIMESTAMP
    `);

    stmt.run(
      path,
      title,
      content,
      JSON.stringify(metadata),
      modifiedAt.toISOString()
    );

    const doc = this.getDocument(path);
    return doc?.id || 0;
  }

  deleteDocumentChunks(documentId: number): void {
    const stmt = this.db.prepare("DELETE FROM chunks WHERE document_id = ?");
    stmt.run(documentId);
  }

  insertChunk(
    documentId: number,
    content: string,
    chunkIndex: number,
    heading: string | null,
    startLine: number,
    endLine: number,
    embedding: number[] | null
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (document_id, content, chunk_index, heading, start_line, end_line, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const embeddingBlob = embedding ? this.vectorToBlob(embedding) : null;
    const result = stmt.run(
      documentId,
      content,
      chunkIndex,
      heading,
      startLine,
      endLine,
      embeddingBlob
    );

    return Number(result.lastInsertRowid);
  }

  searchSimilar(queryEmbedding: number[], topK: number = 5, minScore: number = 0.0): SearchResult[] {
    const chunks = this.db.prepare(`
      SELECT c.*, d.path, d.title
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE c.embedding IS NOT NULL
    `).all() as (StoredChunk & { path: string; title: string })[];

    const results: SearchResult[] = [];

    for (const chunk of chunks) {
      if (!chunk.embedding) continue;

      const embedding = this.blobToVector(chunk.embedding);
      const score = this.cosineSimilarity(queryEmbedding, embedding);

      if (score >= minScore) {
        results.push({
          documentId: chunk.document_id,
          chunkId: chunk.id,
          path: chunk.path,
          title: chunk.title,
          content: chunk.content,
          heading: chunk.heading,
          score,
        });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  getStats(): { documents: number; chunks: number; chunksWithEmbeddings: number } {
    const docs = this.db.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };
    const chunks = this.db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number };
    const withEmb = this.db.prepare(
      "SELECT COUNT(*) as count FROM chunks WHERE embedding IS NOT NULL"
    ).get() as { count: number };

    return {
      documents: docs.count,
      chunks: chunks.count,
      chunksWithEmbeddings: withEmb.count,
    };
  }

  getAllDocuments(): StoredDocument[] {
    return this.db.prepare("SELECT * FROM documents ORDER BY path").all() as StoredDocument[];
  }

  deleteDocument(path: string): void {
    const doc = this.getDocument(path);
    if (doc) {
      this.db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
    }
  }

  clear(): void {
    this.db.exec("DELETE FROM chunks; DELETE FROM documents;");
  }

  close(): void {
    this.db.close();
  }

  private vectorToBlob(vector: number[]): Uint8Array {
    const buffer = new Float32Array(vector);
    return new Uint8Array(buffer.buffer);
  }

  private blobToVector(blob: Uint8Array): number[] {
    const buffer = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
    return Array.from(buffer);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
      throw new VectorStoreError("Vector dimensions must match");
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const valA = a[i] ?? 0;
      const valB = b[i] ?? 0;
      dotProduct += valA * valB;
      normA += valA * valA;
      normB += valB * valB;
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    if (magnitude === 0) return 0;

    return dotProduct / magnitude;
  }
}
