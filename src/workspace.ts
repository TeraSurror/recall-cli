import type { Config } from "./config/schema.ts";
import { loadConfig } from "./config/load.ts";
import { listVaults, type Vault } from "./vault/registry.ts";
import { openIndex, type IndexDb } from "./index/db.ts";
import { Indexer, type IndexStats } from "./index/indexer.ts";
import { embedPending, type Embedder, type EmbedProgress } from "./index/embed.ts";
import { resolveEmbeddingModel } from "./llm/providers.ts";
import { RecallError } from "./util/errors.ts";

export interface OpenVault {
  vault: Vault;
  db: IndexDb;
  indexer: Indexer;
}

/**
 * Runtime handle over all registered vaults: config, index DBs and the embedder.
 * Shared by the CLI, TUI, agent tools and MCP server.
 */
export class Workspace {
  private open = new Map<string, OpenVault>();
  private embedderPromise: Promise<Embedder | null> | null = null;

  constructor(public config: Config) {}

  static load(): Workspace {
    return new Workspace(loadConfig().config);
  }

  /** Re-read config from disk (after vault/model edits). Keeps open DBs for vaults that still exist. */
  reload(config = loadConfig().config): void {
    this.config = config;
    const names = new Set(Object.keys(config.vaults));
    for (const [name, ov] of this.open) {
      if (!names.has(name)) {
        ov.db.close();
        this.open.delete(name);
      } else {
        ov.vault.config = config.vaults[name]!;
      }
    }
    this.embedderPromise = null;
  }

  vaults(): Vault[] {
    return listVaults(this.config);
  }

  vaultNames(): string[] {
    return Object.keys(this.config.vaults);
  }

  get(name: string): OpenVault {
    let ov = this.open.get(name);
    if (ov) return ov;
    const vault = this.vaults().find((v) => v.name === name);
    if (!vault) {
      throw new RecallError(`Unknown vault "${name}". Known: ${this.vaultNames().join(", ") || "(none)"}`);
    }
    const db = openIndex(name);
    ov = { vault, db, indexer: new Indexer(vault, db) };
    this.open.set(name, ov);
    return ov;
  }

  /** Resolve an optional vault argument (falls back to default / only vault). */
  resolveName(name?: string): string {
    if (name) {
      this.get(name);
      return name;
    }
    const names = this.vaultNames();
    if (names.length === 0) throw new RecallError("No vaults registered.", "Add one with: recall vault add <path>");
    if (this.config.defaultVault && names.includes(this.config.defaultVault)) return this.config.defaultVault;
    if (names.length === 1) return names[0]!;
    throw new RecallError(`Several vaults are registered; specify one of: ${names.join(", ")}`);
  }

  embedder(): Promise<Embedder | null> {
    if (!this.embedderPromise) {
      this.embedderPromise = resolveEmbeddingModel(this.config).catch(() => null);
    }
    return this.embedderPromise;
  }

  private lastSync = new Map<string, number>();
  /** Vaults kept fresh by a file watcher don't need rescans. */
  readonly watched = new Set<string>();

  /** Keyword-index sync (fast, local). */
  sync(name: string, opts: { force?: boolean } = {}): IndexStats {
    const stats = this.get(name).indexer.sync(opts);
    this.lastSync.set(name, Date.now());
    return stats;
  }

  /** Rescan if the vault isn't watched and the last scan is older than `maxAgeMs`. */
  ensureFresh(name: string, maxAgeMs = 3000): void {
    if (this.watched.has(name)) return;
    const last = this.lastSync.get(name) ?? 0;
    if (Date.now() - last > maxAgeMs) this.sync(name);
  }

  syncAll(): Map<string, IndexStats> {
    const out = new Map<string, IndexStats>();
    for (const name of this.vaultNames()) out.set(name, this.sync(name));
    return out;
  }

  /** Embed chunks lacking vectors (network/local model). No-op if embeddings are disabled. */
  async embed(name: string, opts: { onProgress?: (p: EmbedProgress) => void; signal?: AbortSignal } = {}): Promise<number> {
    const ov = this.get(name);
    if (!ov.vault.config.embeddings) return 0;
    const embedder = await this.embedder();
    if (!embedder) return 0;
    return embedPending(ov.db, embedder, opts);
  }

  close(): void {
    for (const ov of this.open.values()) ov.db.close();
    this.open.clear();
  }
}
