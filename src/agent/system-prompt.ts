import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolContext } from "../tools/context.ts";
import { vaultNamesFor } from "../tools/context.ts";
import { effectiveMode } from "./approval.ts";
import { readObsidianSettings, formatMomentDate } from "../vault/obsidian.ts";

const MAX_INSTRUCTIONS = 6000;

/** Per-vault agent instructions, like a CLAUDE.md for your notes. */
export function vaultInstructions(root: string): string | null {
  for (const rel of [".recall/instructions.md", "RECALL.md"]) {
    const p = join(root, rel);
    if (existsSync(p)) {
      const text = readFileSync(p, "utf8").trim();
      return text.length > MAX_INSTRUCTIONS ? `${text.slice(0, MAX_INSTRUCTIONS)}\n…(truncated)` : text;
    }
  }
  return null;
}

export function buildSystemPrompt(ctx: ToolContext, opts: { toolsEnabled: boolean; now?: Date } = { toolsEnabled: true }): string {
  const now = opts.now ?? new Date();
  const names = vaultNamesFor(ctx);
  const multi = names.length > 1;
  const vaultLines: string[] = [];
  const instructionBlocks: string[] = [];
  for (const name of names) {
    ctx.ws.ensureFresh(name);
    const { vault, db } = ctx.ws.get(name);
    const { n } = db.query("SELECT count(*) AS n FROM notes").get() as { n: number };
    const mode = effectiveMode(vault.config, ctx.surface, ctx.policy);
    const daily = readObsidianSettings(vault.root).dailyNotes;
    const isDefault = ctx.ws.config.defaultVault === name || names.length === 1;
    vaultLines.push(
      `- ${name}${isDefault ? " (default)" : ""}: ${n} notes; writes: ${mode}; daily notes: ${daily.folder || "(vault root)"}/${daily.format}.md`,
    );
    const ins = vaultInstructions(vault.root);
    if (ins) instructionBlocks.push(`<vault_instructions vault="${name}">\n${ins}\n</vault_instructions>`);
  }

  const toolGuidance = opts.toolsEnabled
    ? `
How to work:
- Ground every answer in the user's notes. Search first (try 2–3 phrasings for broad questions), then read the most relevant notes before answering. Don't guess what a note says.
- Cite sources as wikilinks, e.g. [[Note Name]]${multi ? " prefixed with the vault when ambiguous, e.g. work:[[Note Name]]" : ""}. If the notes don't cover something, say so plainly.
- Before editing, read the note. Make small, targeted edits (edit_note with exact find/replace) instead of rewriting whole notes. Preserve the user's voice, formatting and existing frontmatter.
- Follow Obsidian conventions: [[wikilinks]] to connect notes, #tags or frontmatter tags, YAML properties. Match the conventions already used in the vault.
- Use move_note for renames so backlinks stay intact; delete_note moves to .trash.
- When a write is rejected, read the reason and any feedback, then adapt — never retry the identical change. If a vault is read-only, describe the change you would make instead.
- For multi-note changes (e.g. retagging), state your plan briefly, then make the changes one note at a time.
- Be concise. Use markdown. Don't paste whole notes back unless asked.`
    : `
You don't have tools in this mode. Relevant excerpts from the user's notes are provided with each question. Answer only from them, cite note names as [[wikilinks]], and say when the excerpts don't contain the answer.`;

  return `You are Recall, an assistant that helps the user think with and maintain their Obsidian vaults.

Today is ${formatMomentDate(now, "dddd, YYYY-MM-DD")} (${formatMomentDate(now, "HH:mm")} local time).

Vaults:
${vaultLines.join("\n") || "- (none registered)"}
${toolGuidance}
${instructionBlocks.length ? `\nThe user's own instructions for their vaults (follow these):\n${instructionBlocks.join("\n\n")}` : ""}`.trim();
}
