import { z } from "zod";
import { statSync } from "node:fs";
import { join } from "node:path";
import { defineTool, readNoteText, resolveNote, useVault, vaultArg, vaultNamesFor, noteExists } from "./context.ts";
import { hybridSearch } from "../search/search.ts";
import { backlinks, orphans, outlinks, tagCounts, unresolvedLinks } from "../search/graph.ts";
import { parseNote } from "../parse/note.ts";
import { formatMomentDate, readObsidianSettings } from "../vault/obsidian.ts";
import { effectiveMode } from "../agent/approval.ts";
import { RecallError } from "../util/errors.ts";

const MAX_READ = 30_000;

export const listVaultsTool = defineTool({
  name: "list_vaults",
  description: "List the Obsidian vaults you can access, with note counts and whether you may write to them.",
  kind: "read",
  input: z.object({}),
  async run(_, ctx) {
    return vaultNamesFor(ctx).map((name) => {
      const { vault, db } = useVault(ctx, name);
      const { n } = db.query("SELECT count(*) AS n FROM notes").get() as { n: number };
      return {
        name,
        notes: n,
        default: ctx.ws.config.defaultVault === name,
        writeMode: effectiveMode(vault.config, ctx.surface, ctx.policy),
      };
    });
  },
});

export const searchTool = defineTool({
  name: "search",
  description:
    "Search notes by meaning and keywords (hybrid). Returns the best-matching passage per note with its path and heading. Use specific phrases; run several searches with different wording for broad questions. Searches every accessible vault unless `vault` is given.",
  kind: "read",
  input: z.object({
    query: z.string().min(1).describe("What to look for, in natural language or keywords."),
    vault: vaultArg.describe("Restrict to one vault. Omit to search all accessible vaults."),
    tags: z.array(z.string()).optional().describe("Only notes having ALL these tags (nested tags match, e.g. 'project' matches 'project/alpha')."),
    folder: z.string().optional().describe("Only notes under this folder, e.g. 'Projects/'."),
    modifiedWithinDays: z.number().positive().optional().describe("Only notes modified in the last N days."),
    limit: z.number().int().min(1).max(30).default(8),
  }),
  async run(input, ctx) {
    const names = input.vault ? [useVault(ctx, input.vault).name] : vaultNamesFor(ctx);
    const embedder = await ctx.ws.embedder();
    const filters = {
      tags: input.tags,
      folder: input.folder,
      modifiedAfter: input.modifiedWithinDays ? Date.now() - input.modifiedWithinDays * 86_400_000 : undefined,
    };
    const all = [];
    const notes: string[] = [];
    for (const name of names) {
      const { db, vault } = useVault(ctx, name);
      const res = await hybridSearch(db, input.query, {
        filters,
        limit: input.limit,
        embedder: vault.config.embeddings ? embedder : null,
        signal: ctx.signal,
      });
      if (res.semanticError) notes.push(`${name}: semantic search unavailable (${res.semanticError}); keyword results only.`);
      // Normalize scores per vault so multi-vault results interleave fairly.
      const max = res.hits[0]?.score || 1;
      all.push(...res.hits.map((h) => ({ vault: name, ...h, score: h.score / max })));
    }
    all.sort((a, b) => b.score - a.score);
    return {
      results: all.slice(0, input.limit).map((h) => ({
        vault: h.vault,
        path: h.path,
        heading: h.heading || undefined,
        lines: `${h.startLine + 1}-${h.endLine + 1}`,
        excerpt: h.text.length > 600 ? `${h.text.slice(0, 600)}…` : h.text,
      })),
      ...(notes.length ? { notes } : {}),
    };
  },
});

export const readNoteTool = defineTool({
  name: "read_note",
  description:
    "Read a note's full markdown (with frontmatter). Accepts a path ('Projects/Plan.md') or a note name ('Plan'). Optionally read only one section by heading. Always read a note before editing it.",
  kind: "read",
  input: z.object({
    note: z.string().describe("Path or note name."),
    vault: vaultArg,
    heading: z.string().optional().describe("Only return the section under this heading (case-insensitive)."),
    offset: z.number().int().min(0).default(0).describe("Character offset for paging through very long notes."),
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = resolveNote(ctx, v.name, input.note);
    let text = readNoteText(ctx, v.name, path);
    if (input.heading) {
      const note = parseNote(text);
      const lines = text.split("\n");
      const idx = note.headings.findIndex((h) => h.text.toLowerCase() === input.heading!.toLowerCase());
      if (idx < 0) {
        throw new RecallError(`No heading "${input.heading}" in ${path}. Headings: ${note.headings.map((h) => h.text).join(", ")}`);
      }
      const h = note.headings[idx]!;
      const next = note.headings.slice(idx + 1).find((n) => n.level <= h.level);
      text = lines.slice(h.line, next ? next.line : lines.length).join("\n");
    }
    const slice = text.slice(input.offset, input.offset + MAX_READ);
    const st = statSync(join(v.vault.root, path));
    return {
      vault: v.name,
      path,
      modified: new Date(st.mtimeMs).toISOString(),
      content: slice,
      ...(input.offset + MAX_READ < text.length
        ? { truncated: true, nextOffset: input.offset + MAX_READ, totalChars: text.length }
        : {}),
    };
  },
});

export const listNotesTool = defineTool({
  name: "list_notes",
  description: "List notes, optionally filtered by folder or tag, sorted by most recently modified or by name.",
  kind: "read",
  input: z.object({
    vault: vaultArg,
    folder: z.string().optional(),
    tag: z.string().optional(),
    sort: z.enum(["modified", "name"]).default("modified"),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async run(input, ctx) {
    const { db, name } = useVault(ctx, input.vault);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (input.folder) {
      where.push("n.path LIKE ?");
      params.push(input.folder.replace(/^\/+/, "").replace(/\/?$/, "/") + "%");
    }
    if (input.tag) {
      const t = input.tag.replace(/^#/, "").toLowerCase();
      where.push("EXISTS (SELECT 1 FROM tags t WHERE t.path = n.path AND (t.tag = ? OR t.tag LIKE ?))");
      params.push(t, `${t}/%`);
    }
    const rows = db
      .query(
        `SELECT n.path, n.mtime, (SELECT group_concat(tag, ',') FROM tags t WHERE t.path = n.path) AS tags
         FROM notes n ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ${input.sort === "modified" ? "n.mtime DESC" : "n.path COLLATE NOCASE"} LIMIT ?`,
      )
      .all(...params, input.limit) as { path: string; mtime: number; tags: string | null }[];
    const { total } = db.query("SELECT count(*) AS total FROM notes").get() as { total: number };
    return {
      vault: name,
      totalNotesInVault: total,
      notes: rows.map((r) => ({
        path: r.path,
        modified: new Date(r.mtime).toISOString().slice(0, 16).replace("T", " "),
        ...(r.tags ? { tags: r.tags.split(",") } : {}),
      })),
    };
  },
});

export const getLinksTool = defineTool({
  name: "get_links",
  description: "Get a note's backlinks (notes linking to it) and outgoing links (with whether each target exists).",
  kind: "read",
  input: z.object({ note: z.string(), vault: vaultArg }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = resolveNote(ctx, v.name, input.note);
    return {
      path,
      backlinks: backlinks(v.db, path).map((b) => ({ from: b.path, line: b.line + 1, ...(b.embed ? { embed: true } : {}) })),
      outlinks: outlinks(v.db, path).map((o) => ({
        target: o.target + (o.subpath ? `#${o.subpath}` : ""),
        resolvesTo: o.resolved ?? undefined,
        ...(o.resolved ? {} : { missing: true }),
      })),
    };
  },
});

export const vaultHealthTool = defineTool({
  name: "vault_health",
  description: "Find orphan notes (no incoming links) and broken links (pointing at notes that don't exist).",
  kind: "read",
  input: z.object({
    vault: vaultArg,
    folder: z.string().optional().describe("Limit orphan search to a folder."),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async run(input, ctx) {
    const { db, name } = useVault(ctx, input.vault);
    const o = orphans(db, { folder: input.folder });
    const broken = unresolvedLinks(db);
    return {
      vault: name,
      orphans: { count: o.length, notes: o.slice(0, input.limit) },
      brokenLinks: {
        count: broken.length,
        links: broken.slice(0, input.limit).map((b) => ({ from: b.src, line: b.line + 1, target: b.target })),
      },
    };
  },
});

export const listTagsTool = defineTool({
  name: "list_tags",
  description: "List tags with usage counts (frontmatter and inline). Optionally only a tag and its nested children.",
  kind: "read",
  input: z.object({ vault: vaultArg, prefix: z.string().optional() }),
  async run(input, ctx) {
    const { db, name } = useVault(ctx, input.vault);
    return { vault: name, tags: tagCounts(db, input.prefix?.replace(/^#/, "").toLowerCase()) };
  },
});

export const queryFrontmatterTool = defineTool({
  name: "query_frontmatter",
  description:
    "Find notes by frontmatter (YAML properties). E.g. key='status' value='active', or key='due' with op='exists'.",
  kind: "read",
  input: z.object({
    vault: vaultArg,
    key: z.string(),
    op: z.enum(["equals", "contains", "exists", "missing"]).default("equals"),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  async run(input, ctx) {
    const { db, name } = useVault(ctx, input.vault);
    const rows = db.query("SELECT path, frontmatter FROM notes ORDER BY path").all() as { path: string; frontmatter: string }[];
    const want = input.value === undefined ? undefined : String(input.value).toLowerCase();
    const matches: { path: string; value: unknown }[] = [];
    for (const r of rows) {
      const fm = JSON.parse(r.frontmatter) as Record<string, unknown>;
      const has = Object.hasOwn(fm, input.key);
      const v = fm[input.key];
      const asList = (Array.isArray(v) ? v : [v]).map((x) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)).toLowerCase());
      const ok =
        input.op === "exists" ? has
        : input.op === "missing" ? !has
        : input.op === "equals" ? has && want !== undefined && asList.includes(want)
        : has && want !== undefined && asList.some((x) => x.includes(want));
      if (ok) matches.push({ path: r.path, value: v });
      if (matches.length >= input.limit) break;
    }
    return { vault: name, count: matches.length, notes: matches };
  },
});

export function parseDateArg(input: string | undefined, now = new Date()): Date {
  if (!input || input === "today") return now;
  const rel: Record<string, number> = { yesterday: -1, tomorrow: 1 };
  if (input in rel) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + rel[input]!);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!m) throw new RecallError(`Invalid date "${input}" — use YYYY-MM-DD, "today", "yesterday" or "tomorrow".`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function dailyNotePath(root: string, date: Date): string {
  const s = readObsidianSettings(root).dailyNotes;
  const file = `${formatMomentDate(date, s.format)}.md`;
  return s.folder ? `${s.folder.replace(/\/+$/, "")}/${file}` : file;
}

export const getDailyNoteTool = defineTool({
  name: "get_daily_note",
  description:
    "Get the daily note for a date (default today), using the vault's Obsidian daily-note folder/format. Returns its path and content if it exists.",
  kind: "read",
  input: z.object({ vault: vaultArg, date: z.string().optional().describe("YYYY-MM-DD, 'today', 'yesterday' or 'tomorrow'.") }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = dailyNotePath(v.vault.root, parseDateArg(input.date));
    const exists = noteExists(ctx, v.name, path);
    return { vault: v.name, path, exists, ...(exists ? { content: readNoteText(ctx, v.name, path).slice(0, MAX_READ) } : {}) };
  },
});

export const readTools = [
  listVaultsTool,
  searchTool,
  readNoteTool,
  listNotesTool,
  getLinksTool,
  vaultHealthTool,
  listTagsTool,
  queryFrontmatterTool,
  getDailyNoteTool,
];
