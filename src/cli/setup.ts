import { embed, generateText } from "ai";
import type { Config, ProviderConfig } from "../config/schema.ts";
import { editConfig, ensureConfigFile, loadConfig } from "../config/load.ts";
import { configFile } from "../config/paths.ts";
import { resolveSecret, storeSecret } from "../config/secrets.ts";
import { resolveEmbeddingModel, resolveProfile } from "../llm/providers.ts";
import {
  PRESETS,
  credentialStatus,
  filterModels,
  listProviderModels,
  profileNameFor,
  unconfiguredProfiles,
  type CatalogModel,
  type ProviderPreset,
} from "../llm/catalog.ts";
import type { Prompter } from "../util/prompt.ts";
import { c } from "../util/term.ts";
import { errorMessage } from "../util/errors.ts";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface SetupDeps {
  /** Override network calls in tests. */
  listModels?: typeof listProviderModels;
  testProfile?: (config: Config, name: string) => Promise<string>;
  storeKey?: (name: string, value: string) => Promise<void>;
}

/** Send a tiny request through a profile. Returns a one-line result; throws on failure. */
export async function testProfile(config: Config, name: string): Promise<string> {
  const r = await resolveProfile(config, name);
  const t0 = performance.now();
  const res = await generateText({ model: r.model, prompt: "Reply with just: ok", maxOutputTokens: 20, maxRetries: 0 });
  return `"${res.text.trim().slice(0, 40)}" in ${Math.round(performance.now() - t0)}ms`;
}

async function testEmbeddings(config: Config): Promise<string> {
  const em = await resolveEmbeddingModel(config);
  if (!em) return "disabled";
  const { embedding } = await embed({ model: em.model, value: "hello", maxRetries: 0 });
  return `${embedding.length} dimensions`;
}

function cfg(): Config {
  return loadConfig().config;
}

async function summary(p: Prompter): Promise<void> {
  const config = cfg();
  p.write(`\n${c.bold("Current setup")}  ${c.dim(configFile())}\n`);
  const profiles = Object.entries(config.profiles);
  if (!profiles.length) p.write(`  ${c.dim("no chat models yet")}\n`);
  for (const [name, prof] of profiles) {
    const prov = config.providers[prof.provider];
    const st = prov ? await credentialStatus(prov) : { ok: false as const, reason: `provider "${prof.provider}" missing` };
    const mark = st.ok ? c.green("✓") : c.yellow("!");
    const def = config.defaultProfile === name ? c.yellow(" (default)") : "";
    p.write(`  ${mark} ${c.bold(name)}${def}  ${prof.provider}/${prof.model}${prof.tools ? "" : c.dim(" [retrieval mode]")}${st.ok ? "" : c.yellow(`  — ${st.reason}`)}\n`);
  }
  p.write(`  ${c.dim("embeddings:")} ${config.embeddings ? `${config.embeddings.provider}/${config.embeddings.model}` : c.dim("off (keyword search only)")}\n\n`);
}

/** Offer to remove profiles that can't work (e.g. the template's Anthropic profile with no key). */
async function offerCleanup(p: Prompter): Promise<void> {
  const config = cfg();
  const broken = await unconfiguredProfiles(config);
  if (!broken.length) return;
  p.write(c.yellow("These model profiles can't be used yet:\n"));
  for (const b of broken) p.write(`  • ${b.profile}: ${b.reason}\n`);
  if (!(await p.confirm("Remove them from your config?", true))) return;
  for (const b of broken) removeProfile(b.profile);
  pruneUnusedProviders();
  p.write(c.green(`✓ Removed ${broken.map((b) => b.profile).join(", ")}\n`));
}

export function removeProfile(name: string): void {
  const config = cfg();
  const edits: Array<{ path: string[]; value: unknown }> = [{ path: ["profiles", name], value: undefined }];
  if (config.defaultProfile === name) {
    const next = Object.keys(config.profiles).find((n) => n !== name);
    edits.push({ path: ["defaultProfile"], value: next });
  }
  editConfig(edits);
}

/** Remove a provider and any profiles using it (and the embeddings setting, if it uses it). */
export function removeProvider(name: string): string[] {
  const config = cfg();
  const dependents = Object.entries(config.profiles).filter(([, pr]) => pr.provider === name).map(([n]) => n);
  for (const d of dependents) removeProfile(d);
  const edits: Array<{ path: string[]; value: unknown }> = [{ path: ["providers", name], value: undefined }];
  if (cfg().embeddings?.provider === name) edits.push({ path: ["embeddings"], value: undefined });
  editConfig(edits);
  return dependents;
}

/** Drop providers that no profile or embeddings setting uses and that have no credentials. */
function pruneUnusedProviders(): void {
  const config = cfg();
  const used = new Set([...Object.values(config.profiles).map((pr) => pr.provider), config.embeddings?.provider]);
  const edits = Object.keys(config.providers)
    .filter((n) => !used.has(n))
    .map((n) => ({ path: ["providers", n], value: undefined }));
  // Keep local providers around (no credentials to lose, handy later) — only prune ones that need keys.
  const prunable = edits.filter((e) => {
    const p = config.providers[e.path[1]!]!;
    return p.type !== "ollama" && !(p.baseURL && /localhost|127\.0\.0\.1/.test(p.baseURL));
  });
  if (prunable.length) editConfig(prunable);
}

function presetFor(p: ProviderConfig): ProviderPreset | undefined {
  return PRESETS.find((x) => x.type === p.type && (x.baseURL ?? undefined) === (p.baseURL ?? undefined));
}

/** Choose or create a provider; returns its name and the resolved key (for listing models). */
async function chooseProvider(p: Prompter, deps: SetupDeps, purpose: "chat" | "embeddings"): Promise<{ name: string; key?: string } | null> {
  const config = cfg();
  type Pick = { kind: "existing"; name: string } | { kind: "preset"; preset: ProviderPreset } | { kind: "back" };
  const existing = Object.entries(config.providers).filter(([, pr]) => purpose === "chat" || pr.type !== "anthropic");
  const presets = PRESETS.filter((x) => purpose === "chat" || x.type !== "anthropic");
  const choice = await p.select<Pick>(purpose === "chat" ? "Which provider?" : "Which provider should create embeddings?", [
    ...existing.map(([n, pr]) => ({ label: `${n}`, value: { kind: "existing" as const, name: n }, hint: `already configured (${pr.type}${pr.baseURL ? ` · ${pr.baseURL}` : ""})` })),
    ...presets.map((x) => ({ label: x.label, value: { kind: "preset" as const, preset: x }, hint: x.local ? "runs on your machine" : x.baseURL ?? undefined })),
    { label: "Back", value: { kind: "back" as const } },
  ]);
  if (choice.kind === "back") return null;
  if (choice.kind === "existing") {
    const pr = config.providers[choice.name]!;
    const st = await credentialStatus(pr);
    if (!st.ok) {
      p.write(c.yellow(`  ${choice.name}: ${st.reason}\n`));
      const key = await askKey(p, deps, choice.name, presetFor(pr));
      return { name: choice.name, key };
    }
    return { name: choice.name, key: await resolveSecret(pr.apiKey).catch(() => undefined) ?? envDefault(pr) };
  }

  const preset = choice.preset;
  let name = preset.id;
  if (config.providers[name]) {
    name = await p.required(`A provider named "${name}" exists. Name for the new one`, `${name}-2`);
  }
  while (!NAME_RE.test(name)) name = await p.required("Provider name (lowercase letters, digits, - _)");
  let baseURL = preset.baseURL;
  if (preset.id === "custom") {
    baseURL = await p.required("Base URL (e.g. https://api.example.com/v1)");
    name = (await p.ask("Short name for this provider", name)) || name;
  } else if (preset.local) {
    baseURL = await p.ask("Server URL", baseURL);
  }
  const provider: Record<string, unknown> = { type: preset.type };
  if (baseURL) provider.baseURL = baseURL;
  editConfig([{ path: ["providers", name], value: provider }]);
  p.write(c.green(`✓ Added provider ${name}\n`));

  let key: string | undefined;
  if (!preset.local && (preset.id !== "custom" || (await p.confirm("Does this API need a key?", true)))) {
    key = await askKey(p, deps, name, preset);
  }
  return { name, key };
}

function envDefault(pr: ProviderConfig): string | undefined {
  const env = presetFor(pr)?.envVar;
  return env ? process.env[env] : undefined;
}

/** Ask how to provide the API key; writes `apiKey` to the provider. Returns the key value if known. */
async function askKey(p: Prompter, deps: SetupDeps, providerName: string, preset?: ProviderPreset): Promise<string | undefined> {
  const envVar = preset?.envVar ?? `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
  const envSet = !!process.env[envVar];
  type K = "keychain" | "env" | "skip";
  const how = await p.select<K>(
    `How should Recall get the ${preset?.label ?? providerName} API key?${preset?.keyUrl ? c.dim(`  (create one at ${preset.keyUrl})`) : ""}`,
    [
      { label: "Paste it now", value: "keychain", hint: "stored in your OS keychain, not in the config file" },
      { label: `Read $${envVar}`, value: "env", hint: envSet ? "currently set" : "not set in this shell" },
      { label: "Skip for now", value: "skip" },
    ],
    envSet ? 1 : 0,
  );
  if (how === "skip") return undefined;
  if (how === "env") {
    const name = await p.ask("Environment variable", envVar);
    editConfig([{ path: ["providers", providerName, "apiKey"], value: `env:${name}` }]);
    if (!process.env[name]) p.write(c.yellow(`  $${name} isn't set in this shell — add it to your shell profile.\n`));
    return process.env[name];
  }
  const value = await p.secret("API key");
  if (!value) {
    p.write(c.yellow("  Empty key — skipped.\n"));
    return undefined;
  }
  await (deps.storeKey ?? storeSecret)(providerName, value);
  editConfig([{ path: ["providers", providerName, "apiKey"], value: `keychain:${providerName}` }]);
  p.write(c.green(`✓ Key stored in keychain as "${providerName}"\n`));
  return value;
}

/** Let the user pick a model from the provider's catalog, or type an id. */
async function chooseModel(
  p: Prompter,
  deps: SetupDeps,
  providerName: string,
  key: string | undefined,
  purpose: "chat" | "embeddings",
): Promise<CatalogModel> {
  const pr = cfg().providers[providerName]!;
  let models: CatalogModel[] = [];
  p.write(c.dim(`  Fetching models from ${providerName}…\n`));
  try {
    models = await (deps.listModels ?? listProviderModels)(pr, key);
  } catch (e) {
    p.write(c.yellow(`  Couldn't list models: ${errorMessage(e)}\n`));
  }
  const relevant =
    purpose === "embeddings"
      ? models.filter((m) => m.embedding)
      : models.filter((m) => !m.embedding);
  const suggested = purpose === "embeddings" ? presetFor(pr)?.embeddingModel : undefined;
  if (!relevant.length) {
    if (models.length) p.write(c.dim(`  (no ${purpose} models detected in the list)\n`));
    return { id: await p.required("Model id", suggested), tools: undefined };
  }
  p.write(c.dim(`  ${relevant.length} models available.\n`));

  let query = relevant.length > 15 ? await p.ask("Search models (e.g. 'claude', 'llama 70b'; empty = list all)") : "";
  for (;;) {
    const matches = filterModels(relevant, query);
    if (!matches.length) {
      query = await p.ask(`No models match "${query}". Search again (empty = list all)`);
      continue;
    }
    const shown = matches.slice(0, 20);
    type M = { kind: "model"; m: CatalogModel } | { kind: "search" } | { kind: "manual" };
    const pick = await p.select<M>(
      `Models${matches.length > shown.length ? ` (showing 20 of ${matches.length} — search to narrow)` : ""}:`,
      [
        ...shown.map((m) => ({
          label: m.id,
          value: { kind: "model" as const, m },
          hint: [m.name, m.tools === true ? "tools ✓" : m.tools === false ? "no tool calling" : "", m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : ""]
            .filter(Boolean)
            .join(" · ") || undefined,
        })),
        { label: "Search again", value: { kind: "search" as const } },
        { label: "Type a model id", value: { kind: "manual" as const } },
      ],
    );
    if (pick.kind === "model") return pick.m;
    if (pick.kind === "manual") return { id: await p.required("Model id", suggested) };
    query = await p.ask("Search");
  }
}

async function addChatModel(p: Prompter, deps: SetupDeps): Promise<void> {
  const prov = await chooseProvider(p, deps, "chat");
  if (!prov) return;
  const model = await chooseModel(p, deps, prov.name, prov.key, "chat");

  let tools = model.tools;
  if (tools === false) {
    p.write(c.yellow("  This model doesn't support tool calling — Recall will use retrieval mode (it can answer from your notes but not edit them).\n"));
  } else if (tools === undefined) {
    tools = await p.confirm("Can this model call tools (function calling)?", true);
  }

  const config = cfg();
  let name = await p.ask("Profile name", profileNameFor(model.id));
  while (!NAME_RE.test(name)) name = await p.required("Profile name (lowercase letters, digits, - _)");
  if (config.profiles[name] && !(await p.confirm(`Profile "${name}" exists. Replace it?`, false))) return;

  const profile: Record<string, unknown> = { provider: prov.name, model: model.id };
  if (!tools) profile.tools = false;
  const defaultBroken = !config.defaultProfile || (await unconfiguredProfiles(config)).some((b) => b.profile === config.defaultProfile);
  const makeDefault = await p.confirm("Make it the default model?", defaultBroken || Object.keys(config.profiles).length === 0);
  editConfig([
    { path: ["profiles", name], value: profile },
    ...(makeDefault ? [{ path: ["defaultProfile"], value: name }] : []),
  ]);
  p.write(c.green(`✓ Profile ${name} → ${prov.name}/${model.id}${makeDefault ? " (default)" : ""}\n`));

  if (await p.confirm("Send a test request now?", true)) {
    try {
      p.write(`  ${c.green("✓")} ${await (deps.testProfile ?? testProfile)(cfg(), name)}\n`);
    } catch (e) {
      p.write(c.red(`  ✗ ${errorMessage(e)}\n`));
      p.write(c.dim("  The profile is saved; fix the key/model and run: recall model test " + name + "\n"));
    }
  }
}

async function setupEmbeddings(p: Prompter, deps: SetupDeps): Promise<void> {
  const config = cfg();
  p.write(
    c.dim(
      "Embeddings power semantic search (finding notes by meaning). Without them Recall uses keyword search.\n" +
        "A local Ollama model (nomic-embed-text) is free and private.\n",
    ),
  );
  type E = "configure" | "off" | "back";
  const what = await p.select<E>("Embeddings:", [
    { label: "Choose an embedding model", value: "configure" },
    { label: "Turn embeddings off", value: "off", hint: "keyword search only" },
    { label: "Back", value: "back" },
  ]);
  if (what === "back") return;
  if (what === "off") {
    editConfig([{ path: ["embeddings"], value: undefined }]);
    p.write(c.green("✓ Embeddings off\n"));
    return;
  }
  const prov = await chooseProvider(p, deps, "embeddings");
  if (!prov) return;
  const model = await chooseModel(p, deps, prov.name, prov.key, "embeddings");
  const changed = config.embeddings && (config.embeddings.provider !== prov.name || config.embeddings.model !== model.id);
  editConfig([{ path: ["embeddings"], value: { provider: prov.name, model: model.id } }]);
  p.write(c.green(`✓ Embeddings: ${prov.name}/${model.id}\n`));
  try {
    p.write(`  ${c.green("✓")} ${await testEmbeddings(cfg())}\n`);
    p.write(c.dim(`  Run \`recall index\` to ${changed ? "re-embed your vaults with the new model" : "embed your vaults"}.\n`));
  } catch (e) {
    p.write(c.red(`  ✗ ${errorMessage(e)}\n`));
  }
}

async function chooseDefault(p: Prompter): Promise<void> {
  const config = cfg();
  const names = Object.keys(config.profiles);
  if (!names.length) return void p.write("No profiles yet.\n");
  const name = await p.select(
    "Default model:",
    names.map((n) => ({ label: n, value: n, hint: `${config.profiles[n]!.provider}/${config.profiles[n]!.model}` })),
    Math.max(0, names.indexOf(config.defaultProfile ?? "")),
  );
  editConfig([{ path: ["defaultProfile"], value: name }]);
  p.write(c.green(`✓ Default: ${name}\n`));
}

async function removeItems(p: Prompter): Promise<void> {
  for (;;) {
    const config = cfg();
    type R = { kind: "profile" | "provider"; name: string } | { kind: "done" };
    const pick = await p.select<R>("Remove what?", [
      ...Object.entries(config.profiles).map(([n, pr]) => ({ label: `profile ${n}`, value: { kind: "profile" as const, name: n }, hint: `${pr.provider}/${pr.model}` })),
      ...Object.entries(config.providers).map(([n, pr]) => ({ label: `provider ${n}`, value: { kind: "provider" as const, name: n }, hint: pr.type })),
      { label: "Done", value: { kind: "done" as const } },
    ], Object.keys(config.profiles).length + Object.keys(config.providers).length);
    if (pick.kind === "done") return;
    if (pick.kind === "profile") {
      removeProfile(pick.name);
      p.write(c.green(`✓ Removed profile ${pick.name}\n`));
    } else {
      const deps = Object.entries(config.profiles).filter(([, pr]) => pr.provider === pick.name).map(([n]) => n);
      if (deps.length && !(await p.confirm(`Also removes profile(s) ${deps.join(", ")}. Continue?`, false))) continue;
      removeProvider(pick.name);
      p.write(c.green(`✓ Removed provider ${pick.name}${deps.length ? ` and ${deps.join(", ")}` : ""}\n`));
    }
  }
}

async function testAll(p: Prompter, deps: SetupDeps): Promise<void> {
  const config = cfg();
  for (const name of Object.keys(config.profiles)) {
    p.write(`  ${name} … `);
    try {
      p.write(`${c.green("✓")} ${await (deps.testProfile ?? testProfile)(config, name)}\n`);
    } catch (e) {
      p.write(`${c.red("✗")} ${errorMessage(e)}\n`);
    }
  }
  if (config.embeddings) {
    p.write(`  embeddings … `);
    try {
      p.write(`${c.green("✓")} ${await testEmbeddings(config)}\n`);
    } catch (e) {
      p.write(`${c.red("✗")} ${errorMessage(e)}\n`);
    }
  }
}

/** Interactive model/provider setup. `start` jumps straight into one flow. */
export async function runSetup(p: Prompter, deps: SetupDeps = {}, start?: "add" | "embeddings"): Promise<void> {
  ensureConfigFile();
  p.write(c.bold("Recall model setup\n"));
  await offerCleanup(p);
  if (start === "add" || Object.keys(cfg().profiles).length === 0) await addChatModel(p, deps);
  else if (start === "embeddings") await setupEmbeddings(p, deps);

  for (;;) {
    await summary(p);
    type A = "add" | "embeddings" | "default" | "remove" | "test" | "done";
    const action = await p.select<A>("What next?", [
      { label: "Add a chat model", value: "add" },
      { label: "Set up embeddings (semantic search)", value: "embeddings" },
      { label: "Choose the default model", value: "default" },
      { label: "Remove a model or provider", value: "remove" },
      { label: "Test models", value: "test" },
      { label: "Done", value: "done" },
    ], 5);
    if (action === "done") break;
    if (action === "add") await addChatModel(p, deps);
    if (action === "embeddings") await setupEmbeddings(p, deps);
    if (action === "default") await chooseDefault(p);
    if (action === "remove") await removeItems(p);
    if (action === "test") await testAll(p, deps);
  }
  p.write(c.dim("Edit the config any time: recall config edit\n"));
}
