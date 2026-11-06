import { cpSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.ts";
import { parseConfigText } from "../src/config/load.ts";
import { closeSessions } from "../src/agent/sessions.ts";

export const FIXTURE_VAULT = join(import.meta.dir, "fixtures", "vault");

export interface TestEnv {
  dir: string;
  vaultRoot: string;
  ws: Workspace;
  cleanup(): void;
}

/**
 * Isolated environment: a copy of the fixture vault plus private config/data dirs,
 * so tests never touch the real ~/.config/recall or the checked-in fixture.
 */
export function makeEnv(opts: { mode?: "read-only" | "ask" | "auto"; extraConfig?: string } = {}): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
  const vaultRoot = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vaultRoot, { recursive: true });
  process.env.RECALL_CONFIG_DIR = join(dir, "config");
  process.env.RECALL_DATA_DIR = join(dir, "data");
  mkdirSync(process.env.RECALL_CONFIG_DIR, { recursive: true });
  const text = `{
    "vaults": { "test": { "path": ${JSON.stringify(vaultRoot)}, "mode": "${opts.mode ?? "auto"}", "mcpMode": "${opts.mode ?? "auto"}", "exclude": ["Archive/**"] } },
    "defaultVault": "test",
    "providers": {}, "profiles": {}
    ${opts.extraConfig ?? ""}
  }`;
  writeFileSync(join(process.env.RECALL_CONFIG_DIR, "config.jsonc"), text);
  const ws = new Workspace(parseConfigText(text));
  return {
    dir,
    vaultRoot,
    ws,
    cleanup() {
      ws.close();
      closeSessions();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
