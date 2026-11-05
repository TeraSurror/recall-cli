#!/usr/bin/env bun
import { Command } from "commander";
import { existsSync, fstatSync } from "node:fs";
import pkg from "../../package.json" with { type: "json" };
import { RecallError, errorMessage } from "../util/errors.ts";
import { c } from "../util/term.ts";
import { Workspace } from "../workspace.ts";
import { registerVaultCommands } from "./vault-cmd.ts";
import { registerModelCommands } from "./model-cmd.ts";
import { registerIndexCommands } from "./index-cmd.ts";
import { runHeadless } from "./headless.ts";
import { getRecipe, listRecipes, renderRecipe } from "../recipes/load.ts";
import { configFile, globalRecipesDir } from "../config/paths.ts";
import { ensureConfigFile } from "../config/load.ts";
import { ConfigSchema } from "../config/schema.ts";
import { z } from "zod";
import { listSessions } from "../agent/sessions.ts";
import { relTime, table } from "../util/term.ts";

/**
 * Read piped input. Only for pipes and redirected files — a TTY, socket or other
 * inherited handle (IDEs, agents, some schedulers) may never send EOF and would hang.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    const st = fstatSync(0);
    if (!st.isFIFO() && !st.isFile()) return "";
  } catch {
    return "";
  }
  return (await Bun.stdin.text()).trim();
}

export function buildProgram(): Command {
  const program = new Command()
    .name("recall")
    .description("Agentic hub for your Obsidian vaults — chat with, search and maintain notes using any LLM.")
    .version(pkg.version)
    .showHelpAfterError()
    .option("-p, --profile <name>", "model profile to use")
    .option("--vault <name...>", "limit to these vaults")
    .option("--resume [session]", "resume the last (or a given) chat session")
    .action(async (opts) => {
      const { startTui } = await import("../tui/start.tsx");
      await startTui({ profile: opts.profile, vaults: opts.vault, resume: opts.resume });
    });

  program
    .command("ask")
    .description("Ask a one-off question (headless). Piped stdin is attached as context.")
    .argument("<question...>")
    .option("-p, --profile <name>", "model profile")
    .option("--vault <name...>", "limit to these vaults")
    .option("--allow-writes", "let the agent write to vaults whose mcpMode is \"ask\"")
    .option("--json", "print a JSON result instead of streaming text")
    .option("-q, --quiet", "don't print tool activity to stderr")
    .action(async (words: string[], opts) => {
      const ws = Workspace.load();
      const stdin = await readStdin();
      const question = words.join(" ");
      const prompt = stdin ? `${question}\n\n<stdin>\n${stdin}\n</stdin>` : question;
      process.exitCode = await runHeadless(ws, prompt, {
        vaults: opts.vault,
        profile: opts.profile,
        allowWrites: opts.allowWrites,
        json: opts.json,
        quiet: opts.quiet,
      });
      ws.close();
    });

  program
    .command("run")
    .description("Run a saved recipe (a markdown prompt file) headlessly")
    .argument("[recipe]", "recipe name")
    .argument("[args...]", "values for {{args}} / {{1}}…")
    .option("-l, --list", "list recipes")
    .option("-p, --profile <name>", "override the recipe's model profile")
    .option("--allow-writes", "let the agent write to vaults whose mcpMode is \"ask\"")
    .option("--json", "print a JSON result")
    .option("-q, --quiet", "don't print tool activity")
    .action(async (name: string | undefined, args: string[], opts) => {
      const ws = Workspace.load();
      if (opts.list || !name) {
        const rs = listRecipes(ws);
        if (!rs.length) {
          console.log(`No recipes yet. Create markdown files in ${globalRecipesDir()} or <vault>/.recall/recipes/.`);
        } else {
          console.log(table(rs.map((r) => [c.bold(r.name), c.dim(r.source), r.meta.description ?? ""])));
        }
        return;
      }
      const recipe = getRecipe(ws, name);
      const stdin = await readStdin();
      const prompt = renderRecipe(recipe, args) + (stdin ? `\n\n<stdin>\n${stdin}\n</stdin>` : "");
      process.exitCode = await runHeadless(ws, prompt, {
        vaults: recipe.meta.vault ? [recipe.meta.vault] : undefined,
        profile: opts.profile ?? recipe.meta.profile,
        allowWrites: opts.allowWrites,
        modeCap: recipe.meta.mode,
        json: opts.json,
        quiet: opts.quiet,
      });
      ws.close();
    });

  program
    .command("mcp")
    .description("Serve your vaults over MCP (stdio) for Claude Code, Claude Desktop, Cursor, …")
    .option("--vault <name...>", "only expose these vaults")
    .option("--allow-writes", "allow writes to vaults whose mcpMode is \"ask\"")
    .option("--no-watch", "don't watch files (rescan before each call instead)")
    .action(async (opts) => {
      const ws = Workspace.load();
      const { serveMcp } = await import("../mcp/server.ts");
      for (const name of opts.vault ?? ws.vaultNames()) ws.sync(name);
      if (opts.watch) {
        const { VaultWatcher } = await import("../index/watcher.ts");
        await new VaultWatcher(ws, (e) => {
          if (e.type === "error") process.stderr.write(`recall: ${e.vault}: ${e.message}\n`);
        }).start(opts.vault ?? ws.vaultNames());
      }
      await serveMcp(ws, { vaults: opts.vault, allowWrites: opts.allowWrites });
    });

  registerVaultCommands(program);
  program
    .command("setup")
    .description("Interactive setup: pick providers (OpenRouter, Anthropic, Ollama, …), keys and models")
    .option("--add", "jump straight to adding a chat model")
    .option("--embeddings", "jump straight to embedding setup")
    .action(async (opts) => {
      const { runSetup } = await import("./setup.ts");
      const { Prompter } = await import("../util/prompt.ts");
      const p = new Prompter();
      try {
        await runSetup(p, {}, opts.add ? "add" : opts.embeddings ? "embeddings" : undefined);
      } finally {
        p.close();
      }
    });

  registerModelCommands(program);
  registerIndexCommands(program);

  program
    .command("sessions")
    .description("List recent chat sessions (resume with: recall --resume <id>)")
    .option("-n, --limit <n>", "how many", "20")
    .action((opts) => {
      const rows = listSessions(Number(opts.limit));
      if (!rows.length) return console.log("No sessions yet.");
      console.log(table(rows.map((s) => [c.cyan(s.id), c.dim(relTime(s.updatedAt)), `${s.turns}↩`, s.title])));
    });

  const config = program.command("config").description("Config file helpers");
  config
    .command("path")
    .description("Print the config file path")
    .action(() => console.log(configFile()));
  config
    .command("init")
    .description("Create the config file with commented defaults")
    .action(() => {
      const existed = existsSync(configFile());
      ensureConfigFile();
      console.log(existed ? `Already exists: ${configFile()}` : `Created ${configFile()}`);
    });
  config
    .command("edit")
    .description("Open the config file in $EDITOR")
    .action(() => {
      ensureConfigFile();
      const editor = process.env.VISUAL || process.env.EDITOR || "vi";
      Bun.spawnSync([...editor.split(" "), configFile()], { stdio: ["inherit", "inherit", "inherit"] });
      try {
        Workspace.load();
        console.log(c.green("✓ Config is valid."));
      } catch (e) {
        console.error(c.red(errorMessage(e)));
        process.exitCode = 1;
      }
    });
  config
    .command("schema")
    .description("Print the JSON Schema for the config file (for editor autocomplete)")
    .action(() => console.log(JSON.stringify(z.toJSONSchema(ConfigSchema, { io: "input" }), null, 2)));

  return program;
}

if (import.meta.main) {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (e) {
    if (e instanceof RecallError) {
      console.error(c.red(`✗ ${e.message}`, process.stderr));
      if (e.hint) console.error(c.dim(`  ${e.hint}`, process.stderr));
    } else {
      console.error(e);
    }
    process.exit(1);
  }
}

