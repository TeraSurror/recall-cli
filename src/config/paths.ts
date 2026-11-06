import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Expand a leading `~` and resolve to an absolute path. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** Config dir: $RECALL_CONFIG_DIR > $XDG_CONFIG_HOME/recall > ~/.config/recall */
export function configDir(): string {
  if (process.env.RECALL_CONFIG_DIR) return expandHome(process.env.RECALL_CONFIG_DIR);
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg ? expandHome(xdg) : join(homedir(), ".config"), "recall");
}

/** Data dir: $RECALL_DATA_DIR > $XDG_DATA_HOME/recall > ~/.local/share/recall */
export function dataDir(): string {
  if (process.env.RECALL_DATA_DIR) return expandHome(process.env.RECALL_DATA_DIR);
  const xdg = process.env.XDG_DATA_HOME;
  return join(xdg ? expandHome(xdg) : join(homedir(), ".local", "share"), "recall");
}

export const configFile = () => join(configDir(), "config.jsonc");
export const indexDir = () => join(dataDir(), "index");
export const snapshotDir = () => join(dataDir(), "snapshots");
export const sessionsDb = () => join(dataDir(), "sessions.db");
export const globalRecipesDir = () => join(configDir(), "recipes");
