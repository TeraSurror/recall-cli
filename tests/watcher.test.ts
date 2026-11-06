import { afterEach, expect, test } from "bun:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { VaultWatcher, type WatchEvent } from "../src/index/watcher.ts";
import { keywordSearch } from "../src/search/search.ts";

let env: TestEnv;
let w: VaultWatcher | undefined;
afterEach(async () => {
  await w?.stop();
  env.cleanup();
});

async function waitFor(pred: () => boolean, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

test("watcher indexes new, changed and deleted notes; ignores excluded/non-md", async () => {
  env = makeEnv();
  env.ws.sync("test");
  const events: WatchEvent[] = [];
  w = new VaultWatcher(env.ws, (e) => events.push(e), { debounceMs: 20, embedDelayMs: 10_000 });
  await w.start();
  expect(env.ws.watched.has("test")).toBe(true);

  writeFileSync(join(env.vaultRoot, "Zebra.md"), "zebras are striped");
  writeFileSync(join(env.vaultRoot, "Archive/Ignored.md"), "zebras archived");
  writeFileSync(join(env.vaultRoot, "image.txt"), "zebras");
  await waitFor(() => events.some((e) => e.type === "indexed" && e.path === "Zebra.md"));
  const { db } = env.ws.get("test");
  expect(keywordSearch(db, "zebras").map((h) => h.path)).toEqual(["Zebra.md"]);

  rmSync(join(env.vaultRoot, "Zebra.md"));
  await waitFor(() => events.some((e) => e.type === "indexed" && e.change === "removed"));
  expect(keywordSearch(db, "zebras")).toEqual([]);
});
