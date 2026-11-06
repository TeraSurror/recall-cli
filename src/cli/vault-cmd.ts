import type { Command } from "commander";
import { loadConfig } from "../config/load.ts";
import { PermissionMode } from "../config/schema.ts";
import { addVault, listVaults, removeVault, setDefaultVault, updateVault } from "../vault/registry.ts";
import { discoverObsidianVaults } from "../vault/obsidian.ts";
import { Workspace } from "../workspace.ts";
import { c, table } from "../util/term.ts";
import { RecallError } from "../util/errors.ts";
import { rmSync, existsSync } from "node:fs";
import { indexPath } from "../index/db.ts";
import { confirm } from "../util/prompt.ts";

function parseMode(v: string | undefined, flag: string) {
  if (v === undefined) return undefined;
  const r = PermissionMode.safeParse(v);
  if (!r.success) throw new RecallError(`${flag} must be one of: read-only, ask, auto`);
  return r.data;
}

async function indexNow(name: string) {
  const ws = Workspace.load();
  const s = ws.sync(name);
  console.log(c.dim(`  indexed ${s.added} notes in ${s.ms}ms`));
  if (ws.config.embeddings && ws.get(name).vault.config.embeddings) {
    try {
      const n = await ws.embed(name, {
        onProgress: (p) => process.stdout.isTTY && process.stdout.write(`\r  embedding ${p.done}/${p.total}…`),
      });
      if (n) process.stdout.write(`\r${c.dim(`  embedded ${n} chunks`)}          \n`);
    } catch (e) {
      console.log(c.yellow(`\n  ! semantic index skipped (${(e as Error).message}). Keyword search works; retry with: recall index ${name}`));
    }
  }
  ws.close();
}

export function registerVaultCommands(program: Command) {
  const vault = program.command("vault").description("Register and manage vaults (nothing is indexed until you add it)");

  vault
    .command("add")
    .description("Register a vault")
    .argument("<path...>", "vault folder (spaces are fine, quoted or not)")
    .option("-n, --name <name>", "short id (default: folder name)")
    .option("-m, --mode <mode>", "TUI write mode: read-only | ask | auto (default ask)")
    .option("--mcp-mode <mode>", "MCP/headless write mode (default read-only)")
    .option("-x, --exclude <glob...>", "extra exclude globs, e.g. 'Archive/**'")
    .option("--no-embeddings", "keyword search only for this vault")
    .option("-f, --force", "allow folders without .obsidian/")
    .option("--no-index", "don't index right away")
    .action(async (pathParts: string[], opts) => {
      const { config } = loadConfig();
      const path = pathParts.join(" ");
      const { vault: v, warnings } = addVault(config, path, {
        name: opts.name,
        mode: parseMode(opts.mode, "--mode"),
        mcpMode: parseMode(opts.mcpMode, "--mcp-mode"),
        exclude: opts.exclude,
        embeddings: opts.embeddings,
        force: opts.force,
      });
      for (const w of warnings) console.log(c.yellow(`! ${w}`));
      console.log(`${c.green("✓")} Added vault ${c.bold(v.name)} → ${v.root}`);
      if (opts.index) await indexNow(v.name);
    });

  vault
    .command("list")
    .alias("ls")
    .description("List registered vaults")
    .action(() => {
      const ws = Workspace.load();
      const vaults = listVaults(ws.config);
      if (!vaults.length) {
        console.log("No vaults yet. Add one with: recall vault add <path>   (or: recall vault discover)");
        return;
      }
      const rows = [[c.dim("NAME"), c.dim("NOTES"), c.dim("TUI"), c.dim("MCP"), c.dim("PATH")]];
      for (const v of vaults) {
        let notes = "–";
        if (existsSync(indexPath(v.name))) {
          notes = String((ws.get(v.name).db.query("SELECT count(*) AS n FROM notes").get() as { n: number }).n);
        }
        const star = ws.config.defaultVault === v.name ? c.yellow("*") : " ";
        rows.push([`${star}${c.bold(v.name)}`, notes, v.config.mode, v.config.mcpMode, c.dim(v.root)]);
      }
      console.log(table(rows));
      ws.close();
    });

  vault
    .command("remove")
    .alias("rm")
    .description("Unregister a vault and delete its index (your notes are not touched)")
    .argument("<name>")
    .option("-y, --yes", "don't ask for confirmation")
    .action(async (name: string, opts) => {
      const { config } = loadConfig();
      if (!config.vaults[name]) throw new RecallError(`No vault named "${name}".`);
      if (!opts.yes && !(await confirm(`Unregister "${name}"? Notes stay on disk; only Recall's index is deleted.`))) return;
      removeVault(config, name);
      for (const suffix of ["", "-wal", "-shm"]) rmSync(indexPath(name) + suffix, { force: true });
      console.log(`${c.green("✓")} Removed ${name}`);
    });

  vault
    .command("set")
    .description("Change a vault's settings")
    .argument("<name>")
    .option("-m, --mode <mode>", "TUI write mode")
    .option("--mcp-mode <mode>", "MCP/headless write mode")
    .option("-x, --exclude <glob...>", "replace exclude globs")
    .option("--embeddings <on|off>", "semantic indexing")
    .action((name: string, opts) => {
      const { config } = loadConfig();
      updateVault(config, name, {
        mode: parseMode(opts.mode, "--mode"),
        mcpMode: parseMode(opts.mcpMode, "--mcp-mode"),
        exclude: opts.exclude,
        embeddings: opts.embeddings === undefined ? undefined : ["on", "true", "yes"].includes(opts.embeddings),
      });
      console.log(`${c.green("✓")} Updated ${name}`);
    });

  vault
    .command("default")
    .description("Set the default vault")
    .argument("<name>")
    .action((name: string) => {
      setDefaultVault(loadConfig().config, name);
      console.log(`${c.green("✓")} Default vault: ${name}`);
    });

  vault
    .command("discover")
    .description("Suggest vaults from Obsidian's own list; you choose which to add")
    .action(async () => {
      const { config } = loadConfig();
      const known = new Set(listVaults(config).map((v) => v.root));
      const found = discoverObsidianVaults().filter((p) => !known.has(p));
      if (!found.length) return console.log("No unregistered Obsidian vaults found.");
      console.log("Obsidian knows about these vaults:\n");
      for (const p of found) {
        if (await confirm(`  Add ${c.bold(p)}?`)) {
          const { vault: v } = addVault(loadConfig().config, p);
          console.log(`  ${c.green("✓")} Added ${v.name}`);
          await indexNow(v.name);
        }
      }
    });
}
