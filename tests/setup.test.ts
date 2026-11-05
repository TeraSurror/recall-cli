import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Prompter } from "../src/util/prompt.ts";
import { runSetup } from "../src/cli/setup.ts";
import { loadConfig } from "../src/config/load.ts";
import { credentialStatus, listProviderModels, unconfiguredProfiles, type CatalogModel } from "../src/llm/catalog.ts";
import { parseConfigText } from "../src/config/load.ts";
import { DEFAULT_CONFIG_TEXT } from "../src/config/schema.ts";

let dir: string;
const savedKey = process.env.ANTHROPIC_API_KEY;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-setup-"));
  process.env.RECALL_CONFIG_DIR = join(dir, "config");
  process.env.RECALL_DATA_DIR = join(dir, "data");
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey;
});

/** Run the wizard with scripted answers; returns everything it printed. */
async function script(answers: string[], deps: Parameters<typeof runSetup>[1], start?: "add" | "embeddings") {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (d) => (printed += d.toString()));
  const p = new Prompter(input, output);
  input.write(answers.join("\n") + "\n");
  try {
    await runSetup(p, deps, start);
  } finally {
    p.close();
  }
  return printed;
}

const fakeCatalog: CatalogModel[] = [
  ...Array.from({ length: 25 }, (_, i) => ({ id: `vendor/model-${i}`, tools: i % 2 === 0 })),
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", tools: true, contextLength: 200_000 },
  { id: "meta/llama-small", tools: false },
  { id: "openai/text-embedding-3-small", embedding: true },
];

test("template's unusable profile is flagged", async () => {
  const config = parseConfigText(DEFAULT_CONFIG_TEXT);
  expect(await unconfiguredProfiles(config)).toEqual([{ profile: "sonnet", reason: "$ANTHROPIC_API_KEY is not set" }]);
});

test("wizard: remove template profile, add OpenRouter with keychain key, pick model by search, set default", async () => {
  const stored: Record<string, string> = {};
  const listed: { key?: string }[] = [];
  const out = await script(
    [
      "y", // remove unusable 'sonnet'
      "2", // provider: OpenRouter (1 = existing 'ollama')
      "1", // key: paste now
      "sk-or-test",
      "sonnet", // search
      "1", // first match
      "", // profile name (default)
      "y", // make default
      "y", // test now
      "6", // menu: Done
    ],
    {
      storeKey: async (n, v) => void (stored[n] = v),
      listModels: async (_p, key) => (listed.push({ key }), fakeCatalog),
      testProfile: async (_c, name) => `ok from ${name}`,
    },
    "add",
  );

  expect(stored).toEqual({ openrouter: "sk-or-test" });
  expect(listed[0]!.key).toBe("sk-or-test");
  expect(out).toContain("ok from claude-sonnet-4-5");
  expect(out).not.toContain("sk-or-test"); // secret never echoed

  const { config } = loadConfig();
  expect(config.providers.openrouter).toEqual({ type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", apiKey: "keychain:openrouter" });
  expect(config.profiles["claude-sonnet-4-5"]).toMatchObject({ provider: "openrouter", model: "anthropic/claude-sonnet-4.5", tools: true });
  expect(config.defaultProfile).toBe("claude-sonnet-4-5");
  expect(config.profiles.sonnet).toBeUndefined();
  expect(config.providers.anthropic).toBeUndefined(); // unused + needs a key → pruned
  expect(config.providers.ollama).toBeDefined(); // local provider kept
  // Hand-written comments in the config survive.
  expect(readFileSync(join(process.env.RECALL_CONFIG_DIR!, "config.jsonc"), "utf8")).toContain("// Recall configuration");
});

test("wizard: custom provider with env key, manual model id when listing fails", async () => {
  process.env.MYAPI_API_KEY = "abc";
  const answers = [
    "n", // keep template profiles
    "1", // menu: Add a chat model
    // providers: 1 anthropic, 2 ollama (existing), 3 OpenRouter, 4 Anthropic, 5 OpenAI, 6 Google, 7 Ollama, 8 LM Studio, 9 Groq, 10 custom
    "10",
    "https://api.example.com/v1",
    "myapi",
    "y", // needs a key
    "2", // read env var
    "MYAPI_API_KEY",
    "my-model-7b", // manual id (listing failed)
    "n", // can't call tools
    "mine",
    "n", // not default
    "n", // no test
    "6",
  ];
  const out = await script(answers, {
    listModels: async () => {
      throw new Error("HTTP 401 from api.example.com");
    },
  });
  expect(out).toContain("Couldn't list models: HTTP 401");
  const { config } = loadConfig();
  expect(config.providers.myapi).toEqual({ type: "openai-compatible", baseURL: "https://api.example.com/v1", apiKey: "env:MYAPI_API_KEY" });
  expect(config.profiles.mine).toMatchObject({ provider: "myapi", model: "my-model-7b", tools: false });
  expect(config.defaultProfile).toBe("sonnet");
  expect(await credentialStatus(config.providers.myapi!)).toEqual({ ok: true, source: "$MYAPI_API_KEY" });
  delete process.env.MYAPI_API_KEY;
});

test("wizard: embeddings via existing Ollama, choosing from detected embedding models", async () => {
  await script(
    ["n", "2", "1", "1", "1", "6"], // keep; menu→embeddings; choose model; provider 1 = ollama (anthropic excluded); model 1; done
    {
      listModels: async () => [{ id: "qwen3" }, { id: "nomic-embed-text:latest", embedding: true }],
      testProfile: async () => "ok",
    },
  ).catch(() => {}); // embedding test call hits the network and fails; config is still written
  expect(loadConfig().config.embeddings).toEqual({ provider: "ollama", model: "nomic-embed-text:latest" });
});

// --- real HTTP listing against local mock servers ---
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        if (req.headers.get("authorization") !== "Bearer k") return new Response("unauthorized", { status: 401 });
        return Response.json({
          data: [
            { id: "z/model-b", name: "Model B", context_length: 128000, supported_parameters: ["tools", "temperature"] },
            { id: "a/model-a", supported_parameters: ["temperature"] },
          ],
        });
      }
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "qwen3:8b" }, { name: "nomic-embed-text:latest" }] });
      return new Response("nope", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));

test("listProviderModels: OpenRouter-style catalog with tool support; auth errors surface", async () => {
  const base = `http://localhost:${server.port}/v1`;
  const models = await listProviderModels({ type: "openai-compatible", baseURL: base }, "k");
  expect(models).toEqual([
    { id: "a/model-a", name: undefined, tools: false, contextLength: undefined, embedding: undefined },
    { id: "z/model-b", name: "Model B", tools: true, contextLength: 128000, embedding: undefined },
  ]);
  expect(listProviderModels({ type: "openai-compatible", baseURL: base }, "wrong")).rejects.toThrow(/HTTP 401/);
});

test("listProviderModels: Ollama tags, embedding models detected", async () => {
  const models = await listProviderModels({ type: "ollama", baseURL: `http://localhost:${server.port}/api` });
  expect(models.map((m) => [m.id, !!m.embedding])).toEqual([
    ["qwen3:8b", false],
    ["nomic-embed-text:latest", true],
  ]);
});
