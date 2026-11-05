import type { Command } from "commander";
import { rmSync } from "node:fs";
import { Workspace } from "../workspace.ts";
import { hybridSearch } from "../search/search.ts";
import { listJournal, undoLast } from "../changes/apply.ts";
import { changesetDiff, summarizeChanges } from "../changes/changeset.ts";
import { indexPath } from "../index/db.ts";
import { c, colorDiff, relTime, table } from "../util/term.ts";
import { errorMessage } from "../util/errors.ts";

export function registerIndexCommands(program: Command) {
  program
    .command("index")
    .description("Sync the search index with your vaults (incremental)")
    .argument("[vaults...]", "vault names (default: all)")
    .option("--rebuild", "delete and rebuild the index from scratch")
    .option("--no-embed", "skip the semantic (embedding) pass")
    .action(async (names: string[], opts) => {
      let ws = Workspace.load();
      const targets = names.length ? names : ws.vaultNames();
      if (!targets.length) return console.log("No vaults registered. Add one with: recall vault add <path>");
      if (opts.rebuild) {
        ws.close();
        for (const n of targets) for (const s of ["", "-wal", "-shm"]) rmSync(indexPath(n) + s, { force: true });
        ws = Workspace.load();
      }
      for (const name of targets) {
        const s = ws.sync(name);
        console.log(
          `${c.bold(name)}  ${s.added} added, ${s.updated} updated, ${s.removed} removed, ${s.unchanged} unchanged  ${c.dim(`${s.ms}ms`)}`,
        );
        if (opts.embed) {
          try {
            const n = await ws.embed(name, {
              onProgress: (p) => process.stdout.isTTY && process.stdout.write(`\r  embedding ${p.done}/${p.total}…`),
            });
            if (n) process.stdout.write(`\r  ${c.dim(`embedded ${n} chunks`)}            \n`);
          } catch (e) {
            console.log(c.yellow(`\n  ! embeddings failed: ${errorMessage(e)} (keyword search still works)`));
          }
        }
      }
      ws.close();
    });

  program
    .command("search")
    .description("Search notes without an LLM (hybrid keyword + semantic)")
    .argument("<query...>")
    .option("--vault <name...>", "vaults to search (default: all)")
    .option("-t, --tag <tag...>", "require tags")
    .option("-f, --folder <folder>", "only under this folder")
    .option("-n, --limit <n>", "max results", "10")
    .option("--json", "JSON output")
    .action(async (words: string[], opts) => {
      const ws = Workspace.load();
      const query = words.join(" ");
      const embedder = await ws.embedder();
      const out: { vault: string; path: string; heading: string; line: number; text: string; via: string[] }[] = [];
      let mode = "keyword";
      for (const name of opts.vault ?? ws.vaultNames()) {
        ws.sync(name);
        const { db, vault } = ws.get(name);
        const r = await hybridSearch(db, query, {
          limit: Number(opts.limit),
          filters: { tags: opts.tag, folder: opts.folder },
          embedder: vault.config.embeddings ? embedder : null,
        });
        if (r.mode === "hybrid") mode = "hybrid";
        if (r.semanticError) console.error(c.yellow(`! ${name}: semantic search unavailable (${r.semanticError})`, process.stderr));
        out.push(...r.hits.map((h) => ({ vault: name, path: h.path, heading: h.heading, line: h.startLine + 1, text: h.text, via: h.via })));
      }
      if (opts.json) return console.log(JSON.stringify(out, null, 2));
      if (!out.length) return console.log("No matches.");
      const multi = (opts.vault ?? ws.vaultNames()).length > 1;
      for (const h of out) {
        const loc = `${multi ? c.magenta(`${h.vault}:`) : ""}${c.bold(h.path)}${c.dim(`:${h.line}`)}${h.heading ? c.dim(`  § ${h.heading}`) : ""}`;
        const snippet = h.text.replace(/\s+/g, " ").slice(0, 160);
        console.log(`${loc}\n  ${snippet}${h.text.length > 160 ? "…" : ""}\n`);
      }
      console.log(c.dim(`(${mode} search)`));
      ws.close();
    });

  program
    .command("undo")
    .description("Revert the most recent change made by Recall")
    .option("--force", "restore even if the file changed afterwards")
    .action((opts) => {
      const ws = Workspace.load();
      const r = undoLast(ws, { force: opts.force });
      console.log(`${c.green("✓")} Undid: ${r.record.changeset.title}`);
      for (const p of r.restored) console.log(c.dim(`  ${p}`));
      ws.close();
    });

  program
    .command("history")
    .description("Show changes Recall has applied (most recent first)")
    .option("-n, --limit <n>", "how many", "20")
    .option("-d, --diff", "show diffs")
    .action((opts) => {
      const recs = listJournal().reverse().slice(0, Number(opts.limit));
      if (!recs.length) return console.log("No changes recorded.");
      for (const r of recs) {
        console.log(`${c.dim(relTime(r.appliedAt))}  ${c.magenta(r.changeset.vault)}  ${c.bold(r.changeset.title)}  ${c.dim(r.changeset.tool)}`);
        if (opts.diff) console.log(colorDiff(changesetDiff(r.changeset)));
        else for (const s of summarizeChanges(r.changeset)) console.log(c.dim(`    ${s}`));
      }
    });

  program
    .command("daemon")
    .description("Watch all vaults and keep the index (incl. embeddings) fresh")
    .action(async () => {
      const ws = Workspace.load();
      const { VaultWatcher } = await import("../index/watcher.ts");
      for (const name of ws.vaultNames()) {
        const s = ws.sync(name);
        console.log(`${name}: ${s.added + s.updated} changed, ${s.removed} removed`);
        ws.embed(name).catch((e) => console.error(`${name}: embeddings: ${errorMessage(e)}`));
      }
      const w = new VaultWatcher(ws, (e) => {
        const ts = new Date().toLocaleTimeString();
        if (e.type === "indexed") console.log(`${c.dim(ts)} ${e.vault} ${e.change} ${e.path}`);
        else if (e.type === "embedded") console.log(`${c.dim(ts)} ${e.vault} embedded ${e.count} chunks`);
        else console.error(`${c.dim(ts)} ${c.red(`${e.vault}: ${e.message}`)}`);
      });
      await w.start();
      console.log(c.dim(`Watching ${ws.vaultNames().join(", ")} — Ctrl-C to stop.`));
      process.on("SIGINT", async () => {
        await w.stop();
        ws.close();
        process.exit(0);
      });
    });
}
