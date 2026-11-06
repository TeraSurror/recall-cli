import type { PermissionMode } from "../config/schema.ts";
import type { Changeset } from "../changes/changeset.ts";

export type Surface = "tui" | "mcp" | "headless";

export type ApprovalDecision = { approved: true } | { approved: false; feedback?: string };

/** Asks a human to approve a changeset. Only the TUI provides one. */
export type Approver = (cs: Changeset) => Promise<ApprovalDecision>;

export interface PermissionPolicy {
  /** Per-session override (TUI `/mode`, CLI `--mode`). Applies to every vault. */
  override?: PermissionMode;
  /**
   * CLI/MCP `--allow-writes`: on surfaces with no human to ask, upgrade "ask" vaults to
   * "auto". A vault configured "read-only" always stays read-only.
   */
  allowWrites?: boolean;
}

/** Effective mode for a vault on a surface. A vault's read-only setting can't be overridden. */
export function effectiveMode(
  vault: { mode: PermissionMode; mcpMode: PermissionMode },
  surface: Surface,
  policy: PermissionPolicy = {},
): PermissionMode {
  const base = surface === "tui" ? vault.mode : vault.mcpMode;
  if (base === "read-only") return "read-only";
  if (policy.override) return policy.override;
  if (surface !== "tui" && base === "ask" && policy.allowWrites) return "auto";
  return base;
}
