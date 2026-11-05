import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { Config, PermissionMode, VaultConfig } from "../config/schema.ts";
import { VAULT_NAME_RE } from "../config/schema.ts";
import { editConfig } from "../config/load.ts";
import { expandHome } from "../config/paths.ts";
import { RecallError } from "../util/errors.ts";
import { isObsidianVault } from "./obsidian.ts";

export interface Vault {
  name: string;
  /** Absolute path to the vault root. */
  root: string;
  config: VaultConfig;
}

/** Always-excluded paths, in addition to the vault's own `exclude`. */
export const BUILTIN_EXCLUDES = [".obsidian/**", ".trash/**", ".git/**", ".recall/**", "node_modules/**"];

export function listVaults(config: Config): Vault[] {
  return Object.entries(config.vaults).map(([name, v]) => ({
    name,
    root: expandHome(v.path),
    config: v,
  }));
}

export function getVault(config: Config, name?: string): Vault {
  const vaults = listVaults(config);
  if (vaults.length === 0) {
    throw new RecallError("No vaults registered.", "Add one with: recall vault add <path>");
  }
  const wanted = name ?? config.defaultVault ?? (vaults.length === 1 ? vaults[0]!.name : undefined);
  if (!wanted) {
    throw new RecallError(
      `Multiple vaults registered; specify one (${vaults.map((v) => v.name).join(", ")}).`,
      "Or set a default with: recall vault default <name>",
    );
  }
  const vault = vaults.find((v) => v.name === wanted);
  if (!vault) throw new RecallError(`Unknown vault "${wanted}". Known: ${vaults.map((v) => v.name).join(", ")}`);
  return vault;
}

/** Resolve a list of vault names (or all vaults when empty). */
export function selectVaults(config: Config, names?: string[]): Vault[] {
  const all = listVaults(config);
  if (!names || names.length === 0) return all;
  return names.map((n) => getVault(config, n));
}

export function slugifyVaultName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "vault";
}

export interface AddVaultOptions {
  name?: string;
  mode?: PermissionMode;
  mcpMode?: PermissionMode;
  exclude?: string[];
  embeddings?: boolean;
  force?: boolean;
}

export interface AddVaultResult {
  vault: Vault;
  warnings: string[];
}

export function addVault(config: Config, path: string, opts: AddVaultOptions = {}): AddVaultResult {
  const root = expandHome(path);
  const warnings: string[] = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new RecallError(`Not a directory: ${root}`);
  }
  if (!isObsidianVault(root)) {
    if (!opts.force) {
      throw new RecallError(
        `${root} has no .obsidian/ folder, so it doesn't look like an Obsidian vault.`,
        "Pass --force to register a plain markdown folder anyway.",
      );
    }
    warnings.push("No .obsidian/ folder — registering as a plain markdown folder.");
  }
  const name = opts.name ?? slugifyVaultName(basename(root));
  if (!VAULT_NAME_RE.test(name)) {
    throw new RecallError(`Invalid vault name "${name}": use lowercase letters, digits, - and _ (max 32).`);
  }
  if (config.vaults[name]) throw new RecallError(`A vault named "${name}" already exists.`);
  const dupe = listVaults(config).find((v) => v.root === root);
  if (dupe) throw new RecallError(`That folder is already registered as "${dupe.name}".`);

  const entry: Record<string, unknown> = { path: path.startsWith("~") ? path : root };
  if (opts.mode) entry.mode = opts.mode;
  if (opts.mcpMode) entry.mcpMode = opts.mcpMode;
  if (opts.exclude?.length) entry.exclude = opts.exclude;
  if (opts.embeddings === false) entry.embeddings = false;

  const edits: Array<{ path: string[]; value: unknown }> = [{ path: ["vaults", name], value: entry }];
  if (Object.keys(config.vaults).length === 0) edits.push({ path: ["defaultVault"], value: name });
  const next = editConfig(edits);
  return { vault: getVault(next, name), warnings };
}

export function removeVault(config: Config, name: string): Config {
  getVault(config, name);
  const edits: Array<{ path: string[]; value: unknown }> = [{ path: ["vaults", name], value: undefined }];
  if (config.defaultVault === name) edits.push({ path: ["defaultVault"], value: undefined });
  return editConfig(edits);
}

export function updateVault(
  config: Config,
  name: string,
  patch: Partial<Pick<VaultConfig, "mode" | "mcpMode" | "exclude" | "embeddings">>,
): Config {
  getVault(config, name);
  const edits = Object.entries(patch)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ({ path: ["vaults", name, k], value: v }));
  if (edits.length === 0) throw new RecallError("Nothing to change.");
  return editConfig(edits);
}

export function setDefaultVault(config: Config, name: string): Config {
  getVault(config, name);
  return editConfig([{ path: ["defaultVault"], value: name }]);
}
