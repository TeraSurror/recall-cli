import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Workspace } from "../workspace.ts";
import type { Approver, PermissionPolicy, Surface } from "../agent/approval.ts";
import { effectiveMode } from "../agent/approval.ts";
import type { AppliedRecord } from "../changes/apply.ts";
import { applyChangeset } from "../changes/apply.ts";
import { changesetDiff, diffStats, newChangesetId, summarizeChanges, type Changeset, type FileChange } from "../changes/changeset.ts";
import { RecallError, errorMessage } from "../util/errors.ts";
import { assertRealInside, cleanVaultPath, safeVaultPath, withMd } from "../vault/paths.ts";
import { LinkResolver } from "../index/resolve.ts";

export interface ToolContext {
  ws: Workspace;
  surface: Surface;
  policy: PermissionPolicy;
  sessionId: string;
  /** Human approval (TUI). Absent on MCP/headless. */
  approve?: Approver;
  /** Restrict which vaults this context may touch (e.g. `recall mcp --vault work`). */
  allowedVaults?: string[];
  onApplied?: (rec: AppliedRecord) => void;
  signal?: AbortSignal;
}

export interface RecallTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  kind: "read" | "write";
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(t: RecallTool<S>): RecallTool<S> {
  return t;
}

export const vaultArg = z
  .string()
  .optional()
  .describe("Vault name. Omit to use the default vault. See list_vaults.");

export function vaultNamesFor(ctx: ToolContext): string[] {
  const all = ctx.ws.vaultNames();
  return ctx.allowedVaults ? all.filter((n) => ctx.allowedVaults!.includes(n)) : all;
}

/** Resolve a vault argument, enforcing `allowedVaults` and keeping the index fresh. */
export function useVault(ctx: ToolContext, name?: string) {
  const allowed = vaultNamesFor(ctx);
  let resolved: string;
  if (name) {
    if (!allowed.includes(name)) {
      throw new RecallError(`Unknown or inaccessible vault "${name}". Available: ${allowed.join(", ")}`);
    }
    resolved = name;
  } else {
    const def = ctx.ws.config.defaultVault;
    if (def && allowed.includes(def)) resolved = def;
    else if (allowed.length === 1) resolved = allowed[0]!;
    else throw new RecallError(`Specify a vault: ${allowed.join(", ")}`);
  }
  ctx.ws.ensureFresh(resolved);
  return { name: resolved, ...ctx.ws.get(resolved) };
}

/**
 * Turn a note reference (path with/without .md, or just a note name like "Alpha Plan")
 * into an existing vault-relative path.
 */
export function resolveNote(ctx: ToolContext, vaultName: string, ref: string): string {
  const { db, vault } = ctx.ws.get(vaultName);
  const cleaned = cleanVaultPath(ref.replace(/^\[\[|\]\]$/g, "").split("|")[0]!.split("#")[0]!);
  for (const candidate of [cleaned, withMd(cleaned)]) {
    if (/\.md$/i.test(candidate) && existsSync(safeVaultPath(vault.root, candidate))) return candidate;
  }
  const paths = (db.query("SELECT path FROM notes").all() as { path: string }[]).map((r) => r.path);
  const hit = new LinkResolver(paths).resolve(cleaned, "");
  if (hit) return hit;
  // Fall back to alias match.
  const rows = db.query("SELECT path, aliases FROM notes WHERE aliases != '[]'").all() as { path: string; aliases: string }[];
  const lower = cleaned.toLowerCase();
  const byAlias = rows.filter((r) => (JSON.parse(r.aliases) as string[]).some((a) => a.toLowerCase() === lower));
  if (byAlias.length === 1) return byAlias[0]!.path;
  const similar = paths.filter((p) => p.toLowerCase().includes(lower.split("/").pop()!)).slice(0, 5);
  throw new RecallError(
    `Note not found: "${ref}" in vault "${vaultName}".${similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""}`,
  );
}

export function readNoteText(ctx: ToolContext, vaultName: string, path: string): string {
  const { vault } = ctx.ws.get(vaultName);
  const abs = safeVaultPath(vault.root, path);
  assertRealInside(vault.root, abs);
  if (!existsSync(abs)) throw new RecallError(`Note not found: ${path}`);
  return readFileSync(abs, "utf8");
}

export function noteExists(ctx: ToolContext, vaultName: string, path: string): boolean {
  return existsSync(safeVaultPath(ctx.ws.get(vaultName).vault.root, path));
}

export type WriteOutcome =
  | { status: "applied"; summary: string; files: string[]; diffStat: string }
  | { status: "rejected"; reason: string; feedback?: string };

/**
 * The single gate every write goes through: permission mode → (approval) → apply.
 * Never throws for policy rejections — returns them so the model can adapt.
 */
export async function proposeChanges(
  ctx: ToolContext,
  tool: string,
  vaultName: string,
  title: string,
  changes: FileChange[],
): Promise<WriteOutcome> {
  if (changes.length === 0) return { status: "rejected", reason: "No changes — the note already has that content." };
  const cs: Changeset = { id: newChangesetId(), vault: vaultName, title, tool, changes };
  const { vault } = ctx.ws.get(vaultName);
  const mode = effectiveMode(vault.config, ctx.surface, ctx.policy);
  if (mode === "read-only") {
    return {
      status: "rejected",
      reason: `Vault "${vaultName}" is read-only here. Tell the user what you would change instead (they can enable writes in the vault's ${ctx.surface === "tui" ? "mode" : "mcpMode"} setting).`,
    };
  }
  if (mode === "ask") {
    if (!ctx.approve) {
      return {
        status: "rejected",
        reason: `Vault "${vaultName}" requires approval for writes and this client can't prompt the user. Describe the change instead, or the user can restart with --allow-writes.`,
      };
    }
    const decision = await ctx.approve(cs);
    if (!decision.approved) {
      return {
        status: "rejected",
        reason: "The user rejected this change.",
        feedback: decision.feedback,
      };
    }
  }
  try {
    const rec = applyChangeset(ctx.ws, cs, ctx.sessionId);
    ctx.onApplied?.(rec);
    const s = diffStats(cs);
    return {
      status: "applied",
      summary: title,
      files: summarizeChanges(cs),
      diffStat: `${s.files} file(s), +${s.added} −${s.removed}`,
    };
  } catch (e) {
    return { status: "rejected", reason: `Failed to apply: ${errorMessage(e)}` };
  }
}

export { changesetDiff };
