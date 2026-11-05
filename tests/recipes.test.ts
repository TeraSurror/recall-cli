import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { getRecipe, listRecipes, renderRecipe } from "../src/recipes/load.ts";
import { globalRecipesDir } from "../src/config/paths.ts";
import { effectiveMode } from "../src/agent/approval.ts";

let env: TestEnv;
afterEach(() => env.cleanup());

test("recipes load from global and vault dirs, vault wins, placeholders render", () => {
  env = makeEnv();
  mkdirSync(globalRecipesDir(), { recursive: true });
  writeFileSync(join(globalRecipesDir(), "weekly.md"), "---\ndescription: global\n---\nGlobal weekly");
  writeFileSync(join(globalRecipesDir(), "tag.md"), "---\nmode: read-only\n---\nFind notes tagged {{1}} as of {{date:YYYY}} ({{args}})");
  mkdirSync(join(env.vaultRoot, ".recall/recipes"), { recursive: true });
  writeFileSync(join(env.vaultRoot, ".recall/recipes/weekly.md"), "---\ndescription: vault\n---\nVault weekly");

  expect(listRecipes(env.ws).map((r) => [r.name, r.source])).toEqual([
    ["tag", "global"],
    ["weekly", "vault:test"],
  ]);
  expect(getRecipe(env.ws, "weekly").meta.vault).toBe("test");
  const tag = getRecipe(env.ws, "tag");
  expect(renderRecipe(tag, ["#project", "x"], new Date(2026, 0, 1))).toBe("Find notes tagged #project as of 2026 (#project x)");
  expect(() => getRecipe(env.ws, "nope")).toThrow(/No recipe/);
});

test("permission matrix", () => {
  const v = (mode: any, mcpMode: any) => ({ mode, mcpMode });
  expect(effectiveMode(v("ask", "read-only"), "tui")).toBe("ask");
  expect(effectiveMode(v("ask", "read-only"), "mcp", { allowWrites: true })).toBe("read-only");
  expect(effectiveMode(v("ask", "ask"), "mcp")).toBe("ask");
  expect(effectiveMode(v("ask", "ask"), "headless", { allowWrites: true })).toBe("auto");
  expect(effectiveMode(v("read-only", "auto"), "tui", { override: "auto" })).toBe("read-only");
  expect(effectiveMode(v("auto", "auto"), "headless", { override: "read-only" })).toBe("read-only");
  expect(effectiveMode(v("ask", "ask"), "tui", { override: "auto" })).toBe("auto");
});
