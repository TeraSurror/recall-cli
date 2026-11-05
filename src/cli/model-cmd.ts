import type { Command } from "commander";
import { generateText } from "ai";
import { editConfig, loadConfig } from "../config/load.ts";
import { ProviderType } from "../config/schema.ts";
import { deleteSecret, storeSecret } from "../config/secrets.ts";
import { resolveEmbeddingModel, resolveProfile } from "../llm/providers.ts";
import { c, table } from "../util/term.ts";
import { RecallError, errorMessage } from "../util/errors.ts";
import { embed } from "ai";

async function readSecretFromTty(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  let value = "";
  for await (const chunk of process.stdin) {
    const s = chunk.toString("utf8");
    if (s === "\r" || s === "\n") break;
    if (s === "\u0003") process.exit(130);
    if (s === "\u007f") value = value.slice(0, -1);
    else value += s;
  }
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\n");
  return value.trim();
}

export function registerModelCommands(program: Command) {
  const model = program.command("model").description("Configure LLM providers and model profiles");

  model
    .command("list")
    .alias("ls")
    .description("List providers and profiles")
    .action(() => {
      const { config } = loadConfig();
      console.log(c.bold("Providers"));
      console.log(
        table(
          Object.entries(config.providers).map(([n, p]) => [
            `  ${n}`,
            c.dim(p.type),
            c.dim(p.baseURL ?? ""),
            p.apiKey ? c.dim(p.apiKey.includes(":") ? p.apiKey : "(literal key)") : c.dim("(default env var)"),
          ]),
        ) || "  (none)",
      );
      console.log(`\n${c.bold("Profiles")}`);
      console.log(
        table(
          Object.entries(config.profiles).map(([n, p]) => [
            `${config.defaultProfile === n ? c.yellow("*") : " "} ${n}`,
            `${p.provider}/${p.model}`,
            p.tools ? "" : c.dim("(no tools: retrieval mode)"),
          ]),
        ) || "  (none)",
      );
      console.log(`\n${c.bold("Embeddings")}  ${config.embeddings ? `${config.embeddings.provider}/${config.embeddings.model}` : c.dim("disabled (keyword search only)")}`);
    });

  model
    .command("add")
    .description("Add or replace a model profile")
    .argument("<name>", "profile name, e.g. 'sonnet' or 'local'")
    .requiredOption("--provider <provider>", "provider name from config")
    .requiredOption("--model <id>", "model id, e.g. claude-sonnet-5-5, gpt-5, qwen3")
    .option("--no-tools", "model can't call tools (use retrieval mode)")
    .option("--temperature <t>", "sampling temperature")
    .option("--default", "make it the default profile")
    .action((name: string, opts) => {
      const { config } = loadConfig();
      if (!config.providers[opts.provider]) {
        throw new RecallError(`Unknown provider "${opts.provider}".`, "Add it with: recall model provider <name> --type <type> [--base-url …]");
      }
      const profile: Record<string, unknown> = { provider: opts.provider, model: opts.model };
      if (!opts.tools) profile.tools = false;
      if (opts.temperature) profile.temperature = Number(opts.temperature);
      editConfig([
        { path: ["profiles", name], value: profile },
        ...(opts.default ? [{ path: ["defaultProfile"], value: name }] : []),
      ]);
      console.log(`${c.green("✓")} Profile ${name} → ${opts.provider}/${opts.model}`);
    });

  model
    .command("provider")
    .description("Add or replace a provider")
    .argument("<name>")
    .requiredOption("--type <type>", `one of: ${ProviderType.options.join(", ")}`)
    .option("--base-url <url>", "API base URL (required for openai-compatible)")
    .option("--api-key <ref>", "env:VAR or keychain:NAME (avoid literal keys)")
    .action((name: string, opts) => {
      const type = ProviderType.safeParse(opts.type);
      if (!type.success) throw new RecallError(`--type must be one of: ${ProviderType.options.join(", ")}`);
      const p: Record<string, unknown> = { type: type.data };
      if (opts.baseUrl) p.baseURL = opts.baseUrl;
      if (opts.apiKey) p.apiKey = opts.apiKey;
      editConfig([{ path: ["providers", name], value: p }]);
      console.log(`${c.green("✓")} Provider ${name} (${type.data})`);
    });

  model
    .command("setup")
    .description("Interactive setup (same as `recall setup`)")
    .action(async () => {
      const { runSetup } = await import("./setup.ts");
      const { Prompter } = await import("../util/prompt.ts");
      const p = new Prompter();
      try {
        await runSetup(p, {}, "add");
      } finally {
        p.close();
      }
    });

  model
    .command("remove")
    .alias("rm")
    .description("Remove a model profile")
    .argument("<profile>")
    .action(async (name: string) => {
      const { removeProfile } = await import("./setup.ts");
      if (!loadConfig().config.profiles[name]) throw new RecallError(`Unknown profile "${name}".`);
      removeProfile(name);
      console.log(`${c.green("✓")} Removed profile ${name}`);
    });

  model
    .command("remove-provider")
    .description("Remove a provider (and the profiles that use it)")
    .argument("<provider>")
    .action(async (name: string) => {
      const { removeProvider } = await import("./setup.ts");
      if (!loadConfig().config.providers[name]) throw new RecallError(`Unknown provider "${name}".`);
      const removed = removeProvider(name);
      console.log(`${c.green("✓")} Removed provider ${name}${removed.length ? ` and profile(s) ${removed.join(", ")}` : ""}`);
    });

  model
    .command("default")
    .description("Set the default profile")
    .argument("<name>")
    .action((name: string) => {
      const { config } = loadConfig();
      if (!config.profiles[name]) throw new RecallError(`Unknown profile "${name}".`);
      editConfig([{ path: ["defaultProfile"], value: name }]);
      console.log(`${c.green("✓")} Default profile: ${name}`);
    });

  model
    .command("embeddings")
    .description("Set (or disable) the embedding model used for semantic search")
    .argument("[provider]", "provider name, e.g. ollama")
    .argument("[model]", "model id, e.g. nomic-embed-text")
    .option("--off", "disable embeddings")
    .action((provider: string | undefined, modelId: string | undefined, opts) => {
      if (opts.off) {
        editConfig([{ path: ["embeddings"], value: undefined }]);
        return console.log(`${c.green("✓")} Embeddings disabled (keyword search only)`);
      }
      if (!provider || !modelId) throw new RecallError("Usage: recall model embeddings <provider> <model>  (or --off)");
      editConfig([{ path: ["embeddings"], value: { provider, model: modelId } }]);
      console.log(`${c.green("✓")} Embeddings: ${provider}/${modelId}. Run \`recall index\` to (re)embed.`);
    });

  model
    .command("test")
    .description("Send a tiny request to check a profile (and embeddings) work")
    .argument("[profile]")
    .action(async (name?: string) => {
      const { config } = loadConfig();
      const r = await resolveProfile(config, name);
      process.stdout.write(`${r.name} (${r.profile.provider}/${r.profile.model}) … `);
      const t0 = performance.now();
      try {
        const res = await generateText({ model: r.model, prompt: "Reply with just: ok", maxOutputTokens: 20 });
        console.log(`${c.green("✓")} "${res.text.trim().slice(0, 40)}" in ${Math.round(performance.now() - t0)}ms`);
      } catch (e) {
        console.log(c.red(`✗ ${errorMessage(e)}`));
        process.exitCode = 1;
      }
      const em = await resolveEmbeddingModel(config).catch((e) => {
        console.log(c.red(`embeddings ✗ ${errorMessage(e)}`));
        return null;
      });
      if (em) {
        process.stdout.write(`embeddings (${em.id}) … `);
        try {
          const { embedding } = await embed({ model: em.model, value: "hello" });
          console.log(`${c.green("✓")} ${embedding.length} dims`);
        } catch (e) {
          console.log(c.red(`✗ ${errorMessage(e)}`));
          process.exitCode = 1;
        }
      }
    });

  const key = model.command("key").description("Store API keys in the OS keychain");
  key
    .command("set")
    .argument("<name>", "key name, referenced as keychain:<name> in config")
    .option("--provider <provider>", "also point this provider's apiKey at the key")
    .action(async (name: string, opts) => {
      const value = await readSecretFromTty(`API key for ${name}: `);
      if (!value) throw new RecallError("Empty key.");
      await storeSecret(name, value);
      if (opts.provider) editConfig([{ path: ["providers", opts.provider, "apiKey"], value: `keychain:${name}` }]);
      console.log(`${c.green("✓")} Stored in keychain as ${name}${opts.provider ? ` and linked to provider ${opts.provider}` : ` — reference it as "keychain:${name}"`}`);
    });
  key
    .command("delete")
    .argument("<name>")
    .action(async (name: string) => {
      console.log((await deleteSecret(name)) ? `${c.green("✓")} Deleted ${name}` : `No key named ${name}`);
    });
}
