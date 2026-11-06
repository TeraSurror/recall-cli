import type { Workspace } from "../workspace.ts";
import type { Agent } from "../agent/agent.ts";
import { loadConfig } from "../config/load.ts";
import { PermissionMode } from "../config/schema.ts";
import { addVault, removeVault } from "../vault/registry.ts";
import { undoLast, listJournal } from "../changes/apply.ts";
import { listSessions, loadSession } from "../agent/sessions.ts";
import { getRecipe, listRecipes, renderRecipe } from "../recipes/load.ts";
import { effectiveMode } from "../agent/approval.ts";
import { errorMessage } from "../util/errors.ts";
import { relTime } from "../util/term.ts";
import { parsePathAndName, splitArgs } from "../util/args.ts";
import type { ModelMessage } from "ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Notice = { kind: "info" | "error" | "success"; text: string };

export interface CommandEnv {
  ws: Workspace;
  agent: Agent;
  sessionId: string;
  activeVaults: string[] | undefined;
  setActiveVaults(v: string[] | undefined): void;
  setModeOverride(m: PermissionMode | undefined): void;
  modeOverride: PermissionMode | undefined;
  notify(n: Notice): void;
  clearTranscript(): void;
  /** Send a prompt to the agent as if the user typed it. */
  submitPrompt(text: string, display?: string): void;
  resume(id: string, messages: ModelMessage[]): void;
  reindex(): Promise<void>;
  exit(): void;
}

export const HELP = `Commands
  /vault                    list vaults (★ = active in this session)
  /vault use <a> [b…]|all   limit the session to some vaults
  /vault add <path> [name]  register a vault (indexes it); quote paths with spaces
  /vault remove <name>      unregister (notes untouched)
  /model [profile]          show or switch the model profile
  /mode [read-only|ask|auto|default]  write permission for this session
  /undo                     revert the last change Recall made
  /history                  recent changes
  /run <recipe> [args]      run a saved recipe prompt  (/run alone lists them)
  /sessions · /resume <id>  past conversations
  /reindex                  rescan vaults and embed new chunks
  /clear                    new conversation
  /exit                     quit (or Ctrl-C twice)

Tips
  @[[Note]]   attach a note to your message (Tab completes after @)
  Esc         interrupt the agent
  \\ at the end of a line continues on a new line
  ↑ / ↓       previous prompts`;

export async function handleSlash(line: string, env: CommandEnv): Promise<void> {
  const [cmd, ...args] = splitArgs(line.trim().slice(1));
  const rest = line.trim().slice(1 + (cmd?.length ?? 0)).trim();
  const info = (text: string) => env.notify({ kind: "info", text });
  const ok = (text: string) => env.notify({ kind: "success", text });
  const fail = (text: string) => env.notify({ kind: "error", text });

  try {
    switch (cmd) {
      case "help":
      case "?":
        return info(HELP);

      case "vault":
      case "vaults": {
        const sub = args[0];
        if (!sub || sub === "list") {
          const names = env.ws.vaultNames();
          if (!names.length) return info("No vaults yet. Add one: /vault add ~/path/to/vault");
          const lines = names.map((n) => {
            const { vault, db } = env.ws.get(n);
            const { c } = db.query("SELECT count(*) AS c FROM notes").get() as { c: number };
            const active = !env.activeVaults || env.activeVaults.includes(n);
            const mode = effectiveMode(vault.config, "tui", { override: env.modeOverride });
            return `${active ? "★" : " "} ${n.padEnd(14)} ${String(c).padStart(6)} notes  ${mode.padEnd(9)} ${vault.root}`;
          });
          return info(lines.join("\n"));
        }
        if (sub === "use") {
          const wanted = args.slice(1);
          if (!wanted.length || wanted[0] === "all") {
            env.setActiveVaults(undefined);
            return ok("Using all vaults.");
          }
          const unknown = wanted.filter((w) => !env.ws.vaultNames().includes(w));
          if (unknown.length) return fail(`Unknown vault(s): ${unknown.join(", ")}`);
          env.setActiveVaults(wanted);
          return ok(`Session limited to: ${wanted.join(", ")}`);
        }
        if (sub === "add") {
          const words = args.slice(1);
          const force = words.some((w) => w === "--force" || w === "-f");
          const { path, name } = parsePathAndName(words.filter((w) => w !== "--force" && w !== "-f"));
          if (!path) return fail('Usage: /vault add <path> [name]   (quote paths with spaces: /vault add "~/My Vault")');
          const { vault, warnings } = addVault(loadConfig().config, path, { name, force });
          env.ws.reload();
          for (const w of warnings) info(w);
          ok(`Added ${vault.name} → ${vault.root}. Indexing…`);
          await env.reindex();
          return;
        }
        if (sub === "remove" || sub === "rm") {
          const name = args[1];
          if (!name) return fail("Usage: /vault remove <name>");
          removeVault(loadConfig().config, name);
          env.ws.reload();
          if (env.activeVaults?.includes(name)) env.setActiveVaults(env.activeVaults.filter((v) => v !== name));
          return ok(`Removed ${name} (notes untouched; delete its index with: recall vault remove ${name}).`);
        }
        return fail(`Unknown: /vault ${sub}. Try /help`);
      }

      case "model":
      case "models": {
        const cfg = env.ws.config;
        if (!args[0]) {
          const cur = env.agent.profileName ?? cfg.defaultProfile;
          return info(
            Object.entries(cfg.profiles)
              .map(([n, p]) => `${n === cur ? "●" : " "} ${n.padEnd(12)} ${p.provider}/${p.model}${p.tools ? "" : "  (retrieval mode)"}`)
              .join("\n") || "No profiles. Add one with: recall model add <name> --provider … --model …",
          );
        }
        if (!cfg.profiles[args[0]]) return fail(`Unknown profile "${args[0]}". /model to list.`);
        env.agent.setProfile(args[0]);
        await env.agent.profile();
        return ok(`Model: ${args[0]}`);
      }

      case "mode": {
        if (!args[0]) {
          return info(`Session mode: ${env.modeOverride ?? "default (per-vault setting)"}. Options: read-only | ask | auto | default`);
        }
        if (args[0] === "default") {
          env.setModeOverride(undefined);
          return ok("Using each vault's configured mode.");
        }
        const m = PermissionMode.safeParse(args[0]);
        if (!m.success) return fail("Mode must be read-only, ask, auto or default.");
        env.setModeOverride(m.data);
        return ok(
          m.data === "auto"
            ? "Auto mode: changes apply without review (still undoable). Vaults configured read-only stay read-only."
            : `Mode: ${m.data}`,
        );
      }

      case "undo": {
        const r = undoLast(env.ws, { force: args.includes("--force") });
        return ok(`Undid: ${r.record.changeset.title}`);
      }

      case "history": {
        const recs = listJournal().reverse().slice(0, 10);
        return info(recs.length ? recs.map((r) => `${relTime(r.appliedAt).padEnd(8)} ${r.changeset.vault}: ${r.changeset.title}`).join("\n") : "No changes yet.");
      }

      case "run": {
        if (!args[0]) {
          const rs = listRecipes(env.ws);
          return info(rs.length ? rs.map((r) => `${r.name.padEnd(18)} ${r.meta.description ?? ""}`).join("\n") : "No recipes. Add markdown files to ~/.config/recall/recipes/");
        }
        const recipe = getRecipe(env.ws, args[0]);
        env.submitPrompt(renderRecipe(recipe, args.slice(1)), `/run ${rest}`);
        return;
      }

      case "sessions": {
        const s = listSessions(10);
        return info(s.length ? s.map((x) => `${x.id}  ${relTime(x.updatedAt).padEnd(8)} ${x.title}`).join("\n") : "No saved sessions.");
      }

      case "resume": {
        const id = args[0] ?? listSessions(2).find((s) => s.id !== env.sessionId)?.id;
        if (!id) return fail("No session to resume.");
        const s = loadSession(id);
        if (!s) return fail(`No session ${id}`);
        env.resume(s.info.id, s.messages);
        return ok(`Resumed "${s.info.title}"`);
      }

      case "reindex":
        await env.reindex();
        return;

      case "clear":
      case "new":
        env.clearTranscript();
        return;

      case "exit":
      case "quit":
      case "q":
        return env.exit();

      default:
        return fail(`Unknown command /${cmd}. Try /help`);
    }
  } catch (e) {
    fail(errorMessage(e));
  }
}

/** Expand @[[Note]] mentions into attached note content. */
export function expandMentions(text: string, ws: Workspace, vaults: string[]): { prompt: string; attached: string[] } {
  const attached: string[] = [];
  const blocks: string[] = [];
  for (const m of text.matchAll(/@\[\[([^\]]+)\]\]/g)) {
    const ref = m[1]!;
    const [maybeVault, ...restParts] = ref.split(":");
    const explicit = restParts.length && vaults.includes(maybeVault!) ? maybeVault : undefined;
    const noteRef = explicit ? restParts.join(":") : ref;
    for (const v of explicit ? [explicit] : vaults) {
      const { db, vault } = ws.get(v);
      const row = db.query("SELECT path FROM notes WHERE name = ? COLLATE NOCASE OR path = ? LIMIT 1").get(noteRef, noteRef) as { path: string } | null;
      if (row) {
        const content = readFileSync(join(vault.root, row.path), "utf8");
        blocks.push(`<attached_note vault="${v}" path="${row.path}">\n${content.slice(0, 20_000)}\n</attached_note>`);
        attached.push(`${v}:${row.path}`);
        break;
      }
    }
  }
  return { prompt: blocks.length ? `${text}\n\n${blocks.join("\n\n")}` : text, attached };
}
