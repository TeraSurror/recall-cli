import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { parseNote } from "../parse/note.ts";
import { globalRecipesDir } from "../config/paths.ts";
import type { Workspace } from "../workspace.ts";
import { PermissionMode } from "../config/schema.ts";
import { formatMomentDate } from "../vault/obsidian.ts";
import { RecallError } from "../util/errors.ts";

const RecipeMeta = z.object({
  description: z.string().optional(),
  vault: z.string().optional(),
  profile: z.string().optional(),
  /** Cap the write mode for this recipe (it can only be more restrictive than the vault's). */
  mode: PermissionMode.optional(),
});

export interface Recipe {
  name: string;
  source: string;
  meta: z.infer<typeof RecipeMeta>;
  prompt: string;
}

function loadDir(dir: string, origin: string): Recipe[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const note = parseNote(text);
      const meta = RecipeMeta.safeParse(note.frontmatter);
      if (!meta.success) throw new RecallError(`Invalid recipe frontmatter in ${join(dir, f)}: ${meta.error.issues[0]?.message}`);
      return { name: basename(f, ".md"), source: origin, meta: meta.data, prompt: note.body.trim() };
    });
}

/** Recipes from ~/.config/recall/recipes and every vault's .recall/recipes (vault ones win on name clash). */
export function listRecipes(ws: Workspace): Recipe[] {
  const byName = new Map<string, Recipe>();
  for (const r of loadDir(globalRecipesDir(), "global")) byName.set(r.name, r);
  for (const v of ws.vaults()) {
    for (const r of loadDir(join(v.root, ".recall", "recipes"), `vault:${v.name}`)) {
      byName.set(r.name, { ...r, meta: { vault: v.name, ...r.meta } });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getRecipe(ws: Workspace, name: string): Recipe {
  const r = listRecipes(ws).find((x) => x.name === name);
  if (!r) {
    const names = listRecipes(ws).map((x) => x.name);
    throw new RecallError(`No recipe "${name}".${names.length ? ` Available: ${names.join(", ")}` : ""}`, `Create one in ${globalRecipesDir()}/${name}.md`);
  }
  return r;
}

/** Fill {{date}}, {{date:FORMAT}}, {{args}} and {{1}}, {{2}}… placeholders. */
export function renderRecipe(r: Recipe, args: string[], now = new Date()): string {
  return r.prompt
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/g, (_, f) => formatMomentDate(now, (f ?? "YYYY-MM-DD").trim()))
    .replace(/\{\{\s*args\s*\}\}/g, args.join(" "))
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, i) => args[Number(i) - 1] ?? "");
}
