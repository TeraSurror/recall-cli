import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { VaultSchema } from "../src/config/schema.ts";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { createMcpServer } from "../src/mcp/server.ts";

let env: TestEnv;
afterEach(() => env.cleanup());

async function connect(opts: Parameters<typeof createMcpServer>[1] = {}) {
  const server = createMcpServer(env.ws, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

const text = (r: any) => r.content[0].text as string;

test("read-only vault exposes only read tools; search works", async () => {
  env = makeEnv({ mode: "read-only" });
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name);
  expect(names).toContain("search");
  expect(names).not.toContain("edit_note");
  const r = await c.callTool({ name: "search", arguments: { query: "passkeys" } });
  expect(text(r)).toContain("Auth Redesign");
  const bad = await c.callTool({ name: "read_note", arguments: { note: "../../../etc/hosts" } });
  expect(bad.isError).toBe(true);
});

test("ask vault: writes rejected without --allow-writes, applied with it", async () => {
  env = makeEnv({ mode: "ask" });
  let c = await connect();
  expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("append_to_note");
  c = await connect({ allowWrites: true });
  const r = await c.callTool({ name: "append_to_note", arguments: { note: "Orphan", content: "via mcp" } });
  expect(text(r)).toContain("applied");
  expect(readFileSync(join(env.vaultRoot, "Orphan.md"), "utf8")).toContain("via mcp");
});

test("--vault restricts access; unknown vault fails fast", async () => {
  env = makeEnv();
  expect(() => createMcpServer(env.ws, { vaults: ["nope"] })).toThrow(/no such vault/);
  const other = join(env.dir, "other");
  mkdirSync(join(other, ".obsidian"), { recursive: true });
  writeFileSync(join(other, "Secret.md"), "top secret");
  env.ws.config.vaults.other = VaultSchema.parse({ path: other });
  const c = await connect({ vaults: ["other"] });
  const denied = await c.callTool({ name: "read_note", arguments: { note: "Orphan", vault: "test" } });
  expect(denied.isError).toBe(true);
  const ok = await c.callTool({ name: "read_note", arguments: { note: "Secret" } });
  expect(text(ok)).toContain("top secret");
  const lv = await c.callTool({ name: "list_vaults", arguments: {} });
  expect(text(lv)).not.toContain('"test"');
});
