import { watch, type FSWatcher } from "chokidar";
import { relative, sep } from "node:path";
import type { Workspace } from "../workspace.ts";
import { makeExcluder } from "./indexer.ts";
import { errorMessage } from "../util/errors.ts";

export type WatchEvent =
  | { type: "indexed"; vault: string; path: string; change: "added" | "updated" | "removed" }
  | { type: "embedded"; vault: string; count: number }
  | { type: "error"; vault: string; message: string };

/**
 * Watch every registered vault and keep its index fresh. Changes are debounced per file,
 * then batched into an embedding pass a little later (so typing in Obsidian doesn't call
 * the embedding model on every keystroke-save).
 */
export class VaultWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private embedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private embedding = new Set<string>();

  constructor(
    private ws: Workspace,
    private onEvent: (e: WatchEvent) => void = () => {},
    private opts: { debounceMs?: number; embedDelayMs?: number } = {},
  ) {}

  async start(vaultNames = this.ws.vaultNames()): Promise<void> {
    for (const name of vaultNames) {
      const { vault } = this.ws.get(name);
      const excluded = makeExcluder(vault);
      const w = watch(vault.root, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: (abs, stats) => {
          const rel = relative(vault.root, abs).split(sep).join("/");
          if (!rel) return false;
          if (excluded(rel)) return true;
          return !!stats?.isFile() && !rel.endsWith(".md");
        },
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      const handle = (abs: string) => this.schedule(name, relative(vault.root, abs).split(sep).join("/"));
      w.on("add", handle).on("change", handle).on("unlink", handle);
      w.on("error", (e) => this.onEvent({ type: "error", vault: name, message: errorMessage(e) }));
      await new Promise<void>((resolve) => w.once("ready", () => resolve()));
      this.watchers.push(w);
      this.ws.watched.add(name);
    }
  }

  private schedule(vault: string, path: string): void {
    const key = `${vault}\u0000${path}`;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        try {
          const change = this.ws.get(vault).indexer.indexFile(path);
          if (change !== "unchanged") {
            this.onEvent({ type: "indexed", vault, path, change });
            this.scheduleEmbed(vault);
          }
        } catch (e) {
          this.onEvent({ type: "error", vault, message: `${path}: ${errorMessage(e)}` });
        }
      }, this.opts.debounceMs ?? 200),
    );
  }

  private scheduleEmbed(vault: string): void {
    clearTimeout(this.embedTimers.get(vault));
    this.embedTimers.set(
      vault,
      setTimeout(() => void this.runEmbed(vault), this.opts.embedDelayMs ?? 5000),
    );
  }

  private async runEmbed(vault: string): Promise<void> {
    if (this.embedding.has(vault)) return this.scheduleEmbed(vault);
    this.embedding.add(vault);
    try {
      const count = await this.ws.embed(vault);
      if (count) this.onEvent({ type: "embedded", vault, count });
    } catch (e) {
      this.onEvent({ type: "error", vault, message: `embedding: ${errorMessage(e)}` });
    } finally {
      this.embedding.delete(vault);
    }
  }

  async stop(): Promise<void> {
    for (const t of [...this.timers.values(), ...this.embedTimers.values()]) clearTimeout(t);
    this.timers.clear();
    this.embedTimers.clear();
    await Promise.all(this.watchers.map((w) => w.close()));
    this.watchers = [];
    this.ws.watched.clear();
  }
}
