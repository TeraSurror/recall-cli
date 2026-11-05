import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { Document, parseDocument } from "yaml";
import {
  defineTool,
  noteExists,
  proposeChanges,
  readNoteText,
  resolveNote,
  useVault,
  vaultArg,
  type ToolContext,
} from "./context.ts";
import type { FileChange } from "../changes/changeset.ts";
import { parseNote } from "../parse/note.ts";
import { LinkResolver } from "../index/resolve.ts";
import { rebaseOwnMarkdownLinks, rewriteLinksTo } from "../changes/relink.ts";
import { cleanVaultPath, safeVaultPath, withMd } from "../vault/paths.ts";
import { formatMomentDate, readObsidianSettings } from "../vault/obsidian.ts";
import { dailyNotePath, parseDateArg } from "./read.ts";
import { RecallError } from "../util/errors.ts";

function allPaths(ctx: ToolContext, vault: string): string[] {
  return (ctx.ws.get(vault).db.query("SELECT path FROM notes").all() as { path: string }[]).map((r) => r.path);
}

/** Replace (or add/remove) frontmatter keys while preserving comments, order and formatting. */
export function setFrontmatterText(text: string, patch: Record<string, unknown>): string {
  const note = parseNote(text);
  if (note.frontmatterError) throw new RecallError(`Can't edit frontmatter: it isn't valid YAML (${note.frontmatterError}).`);
  const yamlSrc = note.frontmatterRaw ? note.frontmatterRaw.replace(/^---\r?\n/, "").replace(/\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n)?$/, "") : "";
  const doc = yamlSrc.trim() ? parseDocument(yamlSrc) : new Document({});
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) doc.delete(k);
    else doc.set(k, v);
  }
  let yaml = doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
  if (yaml === "{}") yaml = "";
  const body = text.slice(note.frontmatterRaw.length);
  return yaml ? `---\n${yaml}\n---\n${body}` : body.replace(/^\n/, "");
}

/** Build note text from optional frontmatter + body. */
function composeNote(content: string, frontmatter?: Record<string, unknown>): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return content;
  return setFrontmatterText(content, frontmatter);
}

/** Expand Obsidian core-template variables. */
function expandTemplate(tpl: string, title: string, date: Date): string {
  return tpl
    .replace(/\{\{\s*title\s*\}\}/g, title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_, f) => formatMomentDate(date, (f ?? "YYYY-MM-DD").trim()))
    .replace(/\{\{\s*time(?::([^}]+))?\s*\}\}/g, (_, f) => formatMomentDate(date, (f ?? "HH:mm").trim()));
}

export const createNoteTool = defineTool({
  name: "create_note",
  description:
    "Create a new note. Fails if it already exists (use edit_note/append_to_note instead). Use [[wikilinks]] to connect it to related notes.",
  kind: "write",
  input: z.object({
    path: z.string().describe("Vault-relative path, e.g. 'Projects/New Idea.md'. '.md' is added if missing."),
    content: z.string().describe("Markdown body (without frontmatter)."),
    frontmatter: z.record(z.string(), z.any()).optional().describe("YAML properties, e.g. {tags: ['idea']}."),
    vault: vaultArg,
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = withMd(cleanVaultPath(input.path));
    if (noteExists(ctx, v.name, path)) throw new RecallError(`${path} already exists. Read it and use edit_note or append_to_note.`);
    const after = composeNote(input.content.endsWith("\n") ? input.content : `${input.content}\n`, input.frontmatter);
    return proposeChanges(ctx, "create_note", v.name, `Create ${path}`, [{ kind: "create", path, after }]);
  },
});

export function applyEdits(text: string, edits: { find: string; replace: string; replaceAll?: boolean }[], path: string): string {
  let out = text;
  for (const [i, e] of edits.entries()) {
    if (!e.find) throw new RecallError(`Edit ${i + 1}: "find" must not be empty.`);
    const count = out.split(e.find).length - 1;
    if (count === 0) {
      throw new RecallError(
        `Edit ${i + 1}: text not found in ${path}. Re-read the note and copy the exact text (including whitespace).`,
      );
    }
    if (count > 1 && !e.replaceAll) {
      throw new RecallError(`Edit ${i + 1}: text appears ${count} times in ${path}. Include more surrounding context or set replaceAll.`);
    }
    out = e.replaceAll ? out.split(e.find).join(e.replace) : out.replace(e.find, () => e.replace);
  }
  return out;
}

export const editNoteTool = defineTool({
  name: "edit_note",
  description:
    "Edit an existing note with exact find/replace operations, applied in order. Each `find` must match the current text exactly once (unless replaceAll). Read the note first. Prefer small, targeted edits over rewriting the whole note.",
  kind: "write",
  input: z.object({
    note: z.string().describe("Path or note name."),
    edits: z
      .array(
        z.object({
          find: z.string().describe("Exact existing text to replace."),
          replace: z.string().describe("Replacement text."),
          replaceAll: z.boolean().optional(),
        }),
      )
      .min(1),
    vault: vaultArg,
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = resolveNote(ctx, v.name, input.note);
    const before = readNoteText(ctx, v.name, path);
    const after = applyEdits(before, input.edits, path);
    if (after === before) return { status: "rejected", reason: "Edits produced no change." };
    return proposeChanges(ctx, "edit_note", v.name, `Edit ${path}`, [{ kind: "modify", path, before, after }]);
  },
});

/** Insert `content` at the end of the section under `heading` (before the next heading of same/higher level). */
export function appendToSection(text: string, heading: string | undefined, content: string): string {
  const block = content.replace(/\n+$/, "");
  if (!heading) return `${text.replace(/\n*$/, "")}${text.trim() ? "\n\n" : ""}${block}\n`;
  const note = parseNote(text);
  const lines = text.split("\n");
  const idx = note.headings.findIndex((h) => h.text.toLowerCase() === heading.replace(/^#+\s*/, "").toLowerCase());
  if (idx < 0) {
    // Create the section at the end.
    const level = /^#+/.exec(heading)?.[0] ?? "##";
    return `${text.replace(/\n*$/, "")}\n\n${level} ${heading.replace(/^#+\s*/, "")}\n\n${block}\n`;
  }
  const h = note.headings[idx]!;
  const next = note.headings.slice(idx + 1).find((n) => n.level <= h.level);
  let insertAt = next ? next.line : lines.length;
  while (insertAt > h.line + 1 && !lines[insertAt - 1]!.trim()) insertAt--; // back over trailing blanks
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const isListItem = /^\s*([-*+]|\d+\.)\s/.test(block) && /^\s*([-*+]|\d+\.)\s/.test(before[before.length - 1] ?? "");
  const sep = isListItem || insertAt === h.line + 1 ? [] : [""];
  const tail = after.length && after[0]!.trim() ? [""] : [];
  const result = [...before, ...sep, ...block.split("\n"), ...tail, ...after].join("\n");
  return result.endsWith("\n") ? result : `${result}\n`;
}

export const appendToNoteTool = defineTool({
  name: "append_to_note",
  description:
    "Append content to a note — at the end, or at the end of a given section (created if missing). Set `daily: true` to target the daily note for `date` (created from the vault's daily template if needed).",
  kind: "write",
  input: z.object({
    note: z.string().optional().describe("Path or note name. Omit when daily=true."),
    daily: z.boolean().optional(),
    date: z.string().optional().describe("For daily notes: YYYY-MM-DD, 'today' (default) or 'yesterday'."),
    content: z.string(),
    heading: z.string().optional().describe("Append under this heading, e.g. 'Log' or '## Log'."),
    createIfMissing: z.boolean().default(false).describe("Create the note if it doesn't exist."),
    vault: vaultArg,
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    let path: string;
    let create = input.createIfMissing;
    let seed = "";
    if (input.daily) {
      const date = parseDateArg(input.date);
      path = dailyNotePath(v.vault.root, date);
      create = true;
      const tplName = readObsidianSettings(v.vault.root).dailyNotes.template;
      if (tplName) {
        const tplAbs = safeVaultPath(v.vault.root, withMd(tplName));
        if (existsSync(tplAbs)) seed = expandTemplate(readFileSync(tplAbs, "utf8"), posix.basename(path, ".md"), date);
      }
    } else {
      if (!input.note) throw new RecallError("Provide `note`, or set daily=true.");
      try {
        path = resolveNote(ctx, v.name, input.note);
      } catch (e) {
        if (!create) throw e;
        path = withMd(cleanVaultPath(input.note));
      }
    }
    if (noteExists(ctx, v.name, path)) {
      const before = readNoteText(ctx, v.name, path);
      const after = appendToSection(before, input.heading, input.content);
      return proposeChanges(ctx, "append_to_note", v.name, `Append to ${path}`, [{ kind: "modify", path, before, after }]);
    }
    if (!create) throw new RecallError(`Note not found: ${path}`);
    const after = appendToSection(seed, input.heading, input.content);
    return proposeChanges(ctx, "append_to_note", v.name, `Create ${path}`, [{ kind: "create", path, after }]);
  },
});

export const setFrontmatterTool = defineTool({
  name: "set_frontmatter",
  description:
    "Set, change or remove YAML frontmatter properties on a note, preserving other properties. Use null to remove a key. Example: {status: 'done', tags: ['project', 'archived']}.",
  kind: "write",
  input: z.object({
    note: z.string(),
    properties: z.record(z.string(), z.any()),
    vault: vaultArg,
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = resolveNote(ctx, v.name, input.note);
    const before = readNoteText(ctx, v.name, path);
    const after = setFrontmatterText(before, input.properties);
    return proposeChanges(ctx, "set_frontmatter", v.name, `Update properties of ${path}`, [
      { kind: "modify", path, before, after },
    ]);
  },
});

export const moveNoteTool = defineTool({
  name: "move_note",
  description:
    "Rename or move a note and update every link to it across the vault (wikilinks and markdown links), like Obsidian does.",
  kind: "write",
  input: z.object({
    note: z.string().describe("Current path or note name."),
    newPath: z.string().describe("New vault-relative path, e.g. 'Archive/Old Plan.md'. A trailing '/' moves into that folder keeping the name."),
    vault: vaultArg,
  }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const oldPath = resolveNote(ctx, v.name, input.note);
    const newPath = input.newPath.endsWith("/")
      ? cleanVaultPath(`${input.newPath}${posix.basename(oldPath)}`)
      : withMd(cleanVaultPath(input.newPath));
    if (newPath === oldPath) throw new RecallError("New path is the same as the current one.");
    if (noteExists(ctx, v.name, newPath) && newPath.toLowerCase() !== oldPath.toLowerCase()) {
      throw new RecallError(`${newPath} already exists.`);
    }

    const before = allPaths(ctx, v.name);
    const resolverBefore = new LinkResolver(before);
    const after = before.map((p) => (p === oldPath ? newPath : p));
    const resolverAfter = new LinkResolver(after);

    const changes: FileChange[] = [];
    const srcText = readNoteText(ctx, v.name, oldPath);
    // The moved note may link to itself and has its own relative links to rebase.
    let moved = rewriteLinksTo(srcText, oldPath, oldPath, newPath, resolverBefore, after, newPath);
    moved = rebaseOwnMarkdownLinks(moved, oldPath, newPath, resolverAfter);
    changes.push({ kind: "move", path: oldPath, newPath, before: srcText, after: moved });

    const sources = [
      ...new Set(
        (v.db.query("SELECT DISTINCT src FROM links WHERE resolved = ? AND src != ?").all(oldPath, oldPath) as { src: string }[]).map(
          (r) => r.src,
        ),
      ),
    ];
    for (const src of sources) {
      const text = readNoteText(ctx, v.name, src);
      const next = rewriteLinksTo(text, src, oldPath, newPath, resolverBefore, after);
      if (next !== text) changes.push({ kind: "modify", path: src, before: text, after: next });
    }
    const n = changes.length - 1;
    return proposeChanges(
      ctx,
      "move_note",
      v.name,
      `Move ${oldPath} → ${newPath}${n ? ` (update links in ${n} note${n > 1 ? "s" : ""})` : ""}`,
      changes,
    );
  },
});

export const deleteNoteTool = defineTool({
  name: "delete_note",
  description: "Delete a note by moving it to the vault's .trash folder (recoverable). Reports notes that linked to it.",
  kind: "write",
  input: z.object({ note: z.string(), vault: vaultArg }),
  async run(input, ctx) {
    const v = useVault(ctx, input.vault);
    const path = resolveNote(ctx, v.name, input.note);
    const before = readNoteText(ctx, v.name, path);
    const linkedFrom = (v.db.query("SELECT DISTINCT src FROM links WHERE resolved = ? AND src != ?").all(path, path) as { src: string }[]).map(
      (r) => r.src,
    );
    const res = await proposeChanges(ctx, "delete_note", v.name, `Delete ${path} (to .trash)`, [{ kind: "delete", path, before }]);
    return linkedFrom.length ? { ...res, nowBrokenLinksFrom: linkedFrom } : res;
  },
});

export const writeTools = [createNoteTool, editNoteTool, appendToNoteTool, setFrontmatterTool, moveNoteTool, deleteNoteTool];
