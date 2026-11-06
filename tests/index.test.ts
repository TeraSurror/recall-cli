import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { backlinks, orphans, outlinks, tagCounts, unresolvedLinks } from "../src/search/graph.ts";
import { hybridSearch, keywordSearch, rrf, vectorSearchWith } from "../src/search/search.ts";
import { embedPending, normalize } from "../src/index/embed.ts";
import { MockEmbeddingModelV4 } from "ai/test";

let env: TestEnv;
beforeEach(() => (env = makeEnv()));
afterEach(() => env.cleanup());

describe("indexer", () => {
  test("initial sync indexes markdown, honours excludes", () => {
    const s = env.ws.sync("test");
    expect(s.added).toBe(5); // Archive/** excluded
    const { db } = env.ws.get("test");
    const paths = (db.query("SELECT path FROM notes ORDER BY path").all() as { path: string }[]).map((r) => r.path);
    expect(paths).toEqual([
      "Areas/Auth Redesign.md",
      "Daily/2026-11-03.md",
      "Meeting Notes.md",
      "Orphan.md",
      "Projects/Alpha/Alpha Plan.md",
    ]);
  });

  test("incremental: unchanged, updated, added, removed", () => {
    env.ws.sync("test");
    expect(env.ws.sync("test")).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 5 });

    writeFileSync(join(env.vaultRoot, "Orphan.md"), "Now links to [[Alpha Plan]].");
    writeFileSync(join(env.vaultRoot, "New.md"), "# New\nbrand new #fresh");
    rmSync(join(env.vaultRoot, "Daily/2026-11-03.md"));
    expect(env.ws.sync("test")).toMatchObject({ added: 1, updated: 1, removed: 1, unchanged: 3 });
  });

  test("link resolution: by name, by path, relative markdown links, unresolved", () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    const bl = backlinks(db, "Projects/Alpha/Alpha Plan.md").map((b) => b.path);
    expect([...new Set(bl)]).toEqual(["Areas/Auth Redesign.md", "Daily/2026-11-03.md"]);
    const out = outlinks(db, "Areas/Auth Redesign.md").map((o) => o.resolved);
    expect(out).toEqual(["Projects/Alpha/Alpha Plan.md", "Meeting Notes.md", "Projects/Alpha/Alpha Plan.md"]);
    expect(unresolvedLinks(db).map((u) => u.target)).toEqual(["Missing Note"]); // diagram.png is an attachment
  });

  test("links re-resolve when the target note appears or moves", () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    writeFileSync(join(env.vaultRoot, "Missing Note.md"), "exists now");
    env.ws.sync("test");
    expect(unresolvedLinks(db)).toEqual([]);
    mkdirSync(join(env.vaultRoot, "Elsewhere"));
    renameSync(join(env.vaultRoot, "Missing Note.md"), join(env.vaultRoot, "Elsewhere/Missing Note.md"));
    env.ws.sync("test");
    expect(backlinks(db, "Elsewhere/Missing Note.md").map((b) => b.path)).toEqual(["Meeting Notes.md"]);
  });

  test("orphans and tags", () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    expect(orphans(db)).toEqual(["Daily/2026-11-03.md", "Orphan.md"]);
    expect(orphans(db, { strict: true })).toEqual(["Orphan.md"]);
    const tags = Object.fromEntries(tagCounts(db).map((t) => [t.tag, t.count]));
    expect(tags).toMatchObject({ project: 1, "project/alpha": 1, security: 1, decision: 1, "reading/books": 1 });
    expect(tagCounts(db, "project").map((t) => t.tag)).toEqual(["project", "project/alpha"]);
  });

  test("indexFile handles single-file updates and deletions", () => {
    env.ws.sync("test");
    const { indexer, db } = env.ws.get("test");
    writeFileSync(join(env.vaultRoot, "Orphan.md"), "compost [[Meeting Notes]]");
    expect(indexer.indexFile("Orphan.md")).toBe("updated");
    expect(backlinks(db, "Meeting Notes.md").map((b) => b.path)).toContain("Orphan.md");
    rmSync(join(env.vaultRoot, "Orphan.md"));
    expect(indexer.indexFile("Orphan.md")).toBe("removed");
  });
});

describe("search", () => {
  test("keyword search ranks title/heading matches and supports stemming", () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    const hits = keywordSearch(db, "passkey");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.map((h) => h.path)).toContain("Areas/Auth Redesign.md");
    expect(keywordSearch(db, "decided").map((h) => h.path)).toContain("Areas/Auth Redesign.md");
  });

  test("filters: tags (nested), folder", () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    expect(new Set(keywordSearch(db, "passkeys", { tags: ["project"] }).map((h) => h.path))).toEqual(
      new Set(["Projects/Alpha/Alpha Plan.md"]),
    );
    expect(keywordSearch(db, "passkeys", { folder: "Areas" }).every((h) => h.path.startsWith("Areas/"))).toBe(true);
  });

  test("hybrid search with a mock embedder fuses keyword and semantic hits", async () => {
    env.ws.sync("test");
    const { db } = env.ws.get("test");
    // Deterministic toy embedding: bag of a few concept words.
    const vocab = ["garden", "compost", "passkey", "auth", "meeting"];
    const vec = (t: string) => vocab.map((w) => (t.toLowerCase().includes(w) ? 1 : 0.01));
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }: { values: string[] }) => ({ embeddings: values.map(vec), warnings: [] }),
    });
    const embedder = { id: "mock/toy", model };
    const n = await embedPending(db, embedder);
    expect(n).toBeGreaterThan(0);
    expect(await embedPending(db, embedder)).toBe(0); // idempotent

    const sem = vectorSearchWith(db, "mock/toy", normalize(vec("gardening")), {}, 3);
    expect(sem[0]!.path).toBe("Orphan.md");

    const res = await hybridSearch(db, "compost garden", { embedder });
    expect(res.mode).toBe("hybrid");
    expect(res.hits[0]!.path).toBe("Orphan.md");
    expect(res.hits[0]!.via.sort()).toEqual(["keyword", "semantic"]);
  });

  test("rrf merges duplicates", () => {
    const h = (path: string) => ({ path, name: path, heading: "", text: "", startLine: 0, endLine: 0, score: 0, via: ["keyword" as const] });
    const merged = rrf([[h("a"), h("b")], [h("b"), h("c")]]);
    expect(merged[0]!.path).toBe("b");
    expect(merged).toHaveLength(3);
  });

  test("editing one chunk keeps embeddings of unchanged chunks", async () => {
    env.ws.sync("test");
    const { db, indexer } = env.ws.get("test");
    const model = new MockEmbeddingModelV4({
      doEmbed: async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, 0]), warnings: [] }),
    });
    await embedPending(db, { id: "m", model });
    const p = join(env.vaultRoot, "Meeting Notes.md");
    writeFileSync(p, (await Bun.file(p).text()).replace("Alice, Bob.", "Alice, Bob, Carol."));
    indexer.indexFile("Meeting Notes.md");
    const pending = db.query("SELECT count(*) AS n FROM chunks WHERE embedding IS NULL").get() as { n: number };
    expect(pending.n).toBe(1);
  });
});
