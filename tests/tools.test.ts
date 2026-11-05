import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { getTool, invokeTool } from "../src/tools/registry.ts";
import type { ToolContext } from "../src/tools/context.ts";
import type { Approver } from "../src/agent/approval.ts";
import { undoLast } from "../src/changes/apply.ts";
import { backlinks, unresolvedLinks } from "../src/search/graph.ts";
import { appendToSection, setFrontmatterText } from "../src/tools/write.ts";
import { cleanVaultPath } from "../src/vault/paths.ts";

let env: TestEnv;
afterEach(() => env?.cleanup());

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { ws: env.ws, surface: "tui", policy: {}, sessionId: "s1", ...over };
}

async function call(name: string, input: unknown, c = ctx()) {
  return invokeTool(getTool(name)!, input, c);
}

const read = (p: string) => readFileSync(join(env.vaultRoot, p), "utf8");

describe("read tools", () => {
  beforeEach(() => (env = makeEnv()));

  test("list_vaults & search", async () => {
    const lv = await call("list_vaults", {});
    expect(lv).toMatchObject({ ok: true, value: [{ name: "test", notes: 5, writeMode: "auto" }] });
    const s = (await call("search", { query: "passkeys" })) as { ok: true; value: { results: { path: string }[] } };
    expect(s.value.results.map((r) => r.path)).toContain("Areas/Auth Redesign.md");
  });

  test("read_note by name, alias, section; not found suggests", async () => {
    const r = (await call("read_note", { note: "Alpha Plan" })) as any;
    expect(r.value.path).toBe("Projects/Alpha/Alpha Plan.md");
    expect((await call("read_note", { note: "Alpha" }) as any).value.path).toBe("Projects/Alpha/Alpha Plan.md");
    const sec = (await call("read_note", { note: "Meeting Notes", heading: "decisions" })) as any;
    expect(sec.value.content).toStartWith("## Decisions");
    expect(sec.value.content).not.toContain("Attendees");
    const nf = (await call("read_note", { note: "Alpah Plann" })) as any;
    expect(nf.ok).toBe(false);
  });

  test("path traversal and internal folders are rejected", async () => {
    for (const note of ["../../etc/passwd", "/etc/passwd", ".obsidian/app.json", "a/../../x"]) {
      const r = (await call("read_note", { note })) as any;
      expect(r.ok).toBe(false);
    }
    expect(() => cleanVaultPath("Projects/../Orphan.md")).not.toThrow();
  });

  test("query_frontmatter, list_notes, get_links, vault_health, daily note", async () => {
    const q = (await call("query_frontmatter", { key: "status", value: "active" })) as any;
    expect(q.value.notes.map((n: any) => n.path)).toEqual(["Projects/Alpha/Alpha Plan.md"]);
    const ln = (await call("list_notes", { tag: "project" })) as any;
    expect(ln.value.notes.map((n: any) => n.path)).toEqual(["Projects/Alpha/Alpha Plan.md"]);
    const gl = (await call("get_links", { note: "Meeting Notes" })) as any;
    expect(gl.value.outlinks).toEqual([{ target: "Missing Note", missing: true }]);
    const vh = (await call("vault_health", {})) as any;
    expect(vh.value.brokenLinks.count).toBe(1);
    const dn = (await call("get_daily_note", { date: "2026-11-03" })) as any;
    expect(dn.value).toMatchObject({ path: "Daily/2026-11-03.md", exists: true });
  });

  test("invalid args produce a readable error", async () => {
    const r = (await call("search", {})) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("query");
  });
});

describe("write tools + permissions", () => {
  test("auto mode applies; undo restores", async () => {
    env = makeEnv({ mode: "auto" });
    const r = (await call("edit_note", { note: "Orphan", edits: [{ find: "gardening", replace: "beekeeping" }] })) as any;
    expect(r.value.status).toBe("applied");
    expect(read("Orphan.md")).toContain("beekeeping");
    undoLast(env.ws, { sessionId: "s1" });
    expect(read("Orphan.md")).toContain("gardening");
  });

  test("read-only rejects without touching disk; can't be overridden", async () => {
    env = makeEnv({ mode: "read-only" });
    const before = read("Orphan.md");
    const r = (await call("edit_note", { note: "Orphan", edits: [{ find: "gardening", replace: "x" }] }, ctx({ policy: { override: "auto", allowWrites: true } }))) as any;
    expect(r.value.status).toBe("rejected");
    expect(read("Orphan.md")).toBe(before);
  });

  test("ask mode calls the approver; rejection feedback reaches the model", async () => {
    env = makeEnv({ mode: "ask" });
    const seen: string[] = [];
    const reject: Approver = async (cs) => (seen.push(cs.title), { approved: false, feedback: "use bullet points" });
    const r = (await call("append_to_note", { note: "Orphan", content: "more" }, ctx({ approve: reject }))) as any;
    expect(seen).toEqual(["Append to Orphan.md"]);
    expect(r.value).toMatchObject({ status: "rejected", feedback: "use bullet points" });

    const ok: Approver = async () => ({ approved: true });
    const r2 = (await call("append_to_note", { note: "Orphan", content: "more" }, ctx({ approve: ok }))) as any;
    expect(r2.value.status).toBe("applied");

    // No approver (MCP/headless) → rejected unless --allow-writes
    const r3 = (await call("append_to_note", { note: "Orphan", content: "x" }, ctx({ surface: "mcp" }))) as any;
    expect(r3.value.status).toBe("rejected");
    const r4 = (await call("append_to_note", { note: "Orphan", content: "x" }, ctx({ surface: "mcp", policy: { allowWrites: true } }))) as any;
    expect(r4.value.status).toBe("applied");
  });

  test("edit_note requires unique exact matches", async () => {
    env = makeEnv();
    const r = (await call("edit_note", { note: "Alpha Plan", edits: [{ find: "passkey", replace: "x" }] })) as any;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("appears");
    const r2 = (await call("edit_note", { note: "Alpha Plan", edits: [{ find: "does not exist", replace: "x" }] })) as any;
    expect(r2.error).toContain("not found");
  });

  test("stale edits are refused (file changed after proposal)", async () => {
    env = makeEnv({ mode: "ask" });
    const approve: Approver = async () => {
      writeFileSync(join(env.vaultRoot, "Orphan.md"), "user edited this meanwhile");
      return { approved: true };
    };
    const r = (await call("append_to_note", { note: "Orphan", content: "more" }, ctx({ approve }))) as any;
    expect(r.value.status).toBe("rejected");
    expect(r.value.reason).toContain("changed on disk");
    expect(read("Orphan.md")).toBe("user edited this meanwhile");
  });

  test("create_note with frontmatter; refuses to overwrite", async () => {
    env = makeEnv();
    const r = (await call("create_note", { path: "Ideas/Bees", content: "# Bees\n", frontmatter: { tags: ["idea"] } })) as any;
    expect(r.value.status).toBe("applied");
    expect(read("Ideas/Bees.md")).toBe("---\ntags:\n  - idea\n---\n# Bees\n");
    const again = (await call("create_note", { path: "Ideas/Bees.md", content: "x" })) as any;
    expect(again.ok).toBe(false);
    // Index updated immediately.
    const s = (await call("list_notes", { tag: "idea" })) as any;
    expect(s.value.notes.map((n: any) => n.path)).toEqual(["Ideas/Bees.md"]);
  });

  test("move_note rewrites wikilinks (keeping subpath/alias), markdown links, and own relative links", async () => {
    env = makeEnv();
    const r = (await call("move_note", { note: "Meeting Notes", newPath: "Meetings/2026 Sync.md" })) as any;
    expect(r.value.status).toBe("applied");
    expect(existsSync(join(env.vaultRoot, "Meeting Notes.md"))).toBe(false);
    expect(read("Projects/Alpha/Alpha Plan.md")).toContain("[[2026 Sync#Decisions|the decisions]]");
    expect(read("Areas/Auth Redesign.md")).toContain("[Meeting notes](../Meetings/2026%20Sync.md)");
    const { db } = env.ws.get("test");
    expect(backlinks(db, "Meetings/2026 Sync.md").map((b) => b.path).sort()).toEqual([
      "Areas/Auth Redesign.md",
      "Projects/Alpha/Alpha Plan.md",
    ]);
    expect(unresolvedLinks(db).map((u) => u.target)).toEqual(["Missing Note"]);

    // Moving Auth Redesign rebases its own relative markdown link.
    await call("move_note", { note: "Auth Redesign", newPath: "Areas/Security/" });
    expect(read("Areas/Security/Auth Redesign.md")).toContain("(../../Meetings/2026%20Sync.md)");
    expect(unresolvedLinks(db).map((u) => u.target)).toEqual(["Missing Note"]);

    // Undo the last move restores both the file and its links.
    undoLast(env.ws);
    expect(read("Areas/Auth Redesign.md")).toContain("(../Meetings/2026%20Sync.md)");
  });

  test("move_note keeps folder-qualified links qualified; ambiguous names get full paths", async () => {
    env = makeEnv();
    writeFileSync(join(env.vaultRoot, "Plan.md"), "another note named Plan");
    await call("move_note", { note: "Alpha Plan", newPath: "Projects/Plan.md" });
    const auth = read("Areas/Auth Redesign.md");
    expect(auth).toContain("[[Projects/Plan]]"); // was bare [[Alpha Plan]] but "Plan" is now ambiguous
    expect(auth).toContain("[[Projects/Plan|plan]]");
  });

  test("delete_note moves to .trash and reports broken links; undo restores", async () => {
    env = makeEnv();
    const r = (await call("delete_note", { note: "Meeting Notes" })) as any;
    expect(r.value.status).toBe("applied");
    expect(r.value.nowBrokenLinksFrom.sort()).toEqual(["Areas/Auth Redesign.md", "Projects/Alpha/Alpha Plan.md"]);
    expect(existsSync(join(env.vaultRoot, ".trash/Meeting Notes.md"))).toBe(true);
    undoLast(env.ws);
    expect(existsSync(join(env.vaultRoot, "Meeting Notes.md"))).toBe(true);
  });

  test("undo refuses if the file changed since", async () => {
    env = makeEnv();
    await call("append_to_note", { note: "Orphan", content: "x" });
    writeFileSync(join(env.vaultRoot, "Orphan.md"), "changed");
    expect(() => undoLast(env.ws)).toThrow(/changed afterwards/);
  });

  test("append_to_note daily creates from template", async () => {
    env = makeEnv();
    writeFileSync(join(env.vaultRoot, "Templates.md"), ""); // noise
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(env.vaultRoot, "Templates"), { recursive: true });
    writeFileSync(join(env.vaultRoot, "Templates/Daily.md"), "# {{title}}\n\n## Log\n");
    const r = (await call("append_to_note", { daily: true, date: "2026-11-04", heading: "Log", content: "- shipped recall v2" })) as any;
    expect(r.value.status).toBe("applied");
    expect(read("Daily/2026-11-04.md")).toBe("# 2026-11-04\n\n## Log\n- shipped recall v2\n");
  });
});

describe("text helpers", () => {
  test("appendToSection", () => {
    const t = "# A\n\n## Log\n- one\n\n## Next\ntext\n";
    expect(appendToSection(t, "Log", "- two")).toBe("# A\n\n## Log\n- one\n- two\n\n## Next\ntext\n");
    expect(appendToSection(t, "Missing", "new")).toBe("# A\n\n## Log\n- one\n\n## Next\ntext\n\n## Missing\n\nnew\n");
    expect(appendToSection("", undefined, "hi")).toBe("hi\n");
    expect(appendToSection("body", undefined, "hi")).toBe("body\n\nhi\n");
  });

  test("setFrontmatterText preserves comments and order; null deletes", () => {
    const t = "---\n# keep me\ntitle: X\nstatus: draft\n---\nbody\n";
    expect(setFrontmatterText(t, { status: "done", due: "2026-12-01" })).toBe(
      "---\n# keep me\ntitle: X\nstatus: done\ndue: 2026-12-01\n---\nbody\n",
    );
    expect(setFrontmatterText("---\na: 1\n---\nbody\n", { a: null })).toBe("body\n");
    expect(setFrontmatterText("body\n", { a: 1 })).toBe("---\na: 1\n---\nbody\n");
  });
});
