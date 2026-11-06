import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOllama } from "ollama-ai-provider-v2";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { Config, ProfileConfig, ProviderConfig } from "../config/schema.ts";
import { resolveSecret } from "../config/secrets.ts";
import { RecallError } from "../util/errors.ts";

interface ProviderInstance {
  languageModel(id: string): LanguageModel;
  embeddingModel(id: string): EmbeddingModel;
}

async function instantiate(name: string, p: ProviderConfig): Promise<ProviderInstance> {
  const apiKey = await resolveSecret(p.apiKey);
  const common = { ...(apiKey ? { apiKey } : {}), ...(p.baseURL ? { baseURL: p.baseURL } : {}), headers: p.headers };
  switch (p.type) {
    case "anthropic": {
      const a = createAnthropic(common);
      return {
        languageModel: (id) => a.languageModel(id),
        embeddingModel: () => {
          throw new RecallError(`Provider "${name}" (anthropic) has no embedding models.`, "Use ollama, openai or google for embeddings.");
        },
      };
    }
    case "openai": {
      const o = createOpenAI(common);
      return { languageModel: (id) => o.languageModel(id), embeddingModel: (id) => o.textEmbeddingModel(id) };
    }
    case "google": {
      const g = createGoogleGenerativeAI(common);
      return { languageModel: (id) => g.languageModel(id), embeddingModel: (id) => g.textEmbeddingModel(id) };
    }
    case "ollama": {
      const o = createOllama({ ...(p.baseURL ? { baseURL: p.baseURL } : {}), headers: p.headers });
      return { languageModel: (id) => o.languageModel(id), embeddingModel: (id) => o.textEmbeddingModel(id) };
    }
    case "openai-compatible": {
      if (!p.baseURL) throw new RecallError(`Provider "${name}" (openai-compatible) needs a baseURL.`);
      const o = createOpenAICompatible({ name, baseURL: p.baseURL, apiKey, headers: p.headers });
      return { languageModel: (id) => o.languageModel(id), embeddingModel: (id) => o.textEmbeddingModel(id) };
    }
  }
}

const cache = new Map<string, Promise<ProviderInstance>>();

function getProvider(config: Config, name: string): Promise<ProviderInstance> {
  const p = config.providers[name];
  if (!p) {
    throw new RecallError(
      `Unknown provider "${name}". Configured: ${Object.keys(config.providers).join(", ") || "(none)"}`,
    );
  }
  const key = `${name}:${JSON.stringify(p)}`;
  let inst = cache.get(key);
  if (!inst) {
    inst = instantiate(name, p);
    cache.set(key, inst);
    inst.catch(() => cache.delete(key));
  }
  return inst;
}

export interface ResolvedProfile {
  name: string;
  profile: ProfileConfig;
  model: LanguageModel;
}

export function getProfileConfig(config: Config, name?: string): { name: string; profile: ProfileConfig } {
  const profileName = name ?? config.defaultProfile ?? Object.keys(config.profiles)[0];
  if (!profileName) throw new RecallError("No model profiles configured.", "Add one with: recall model add <name> ...");
  const profile = config.profiles[profileName];
  if (!profile) {
    throw new RecallError(
      `Unknown model profile "${profileName}". Configured: ${Object.keys(config.profiles).join(", ")}`,
    );
  }
  return { name: profileName, profile };
}

export async function resolveProfile(config: Config, name?: string): Promise<ResolvedProfile> {
  const { name: profileName, profile } = getProfileConfig(config, name);
  const provider = await getProvider(config, profile.provider);
  return { name: profileName, profile, model: provider.languageModel(profile.model) };
}

export async function resolveEmbeddingModel(config: Config): Promise<{ id: string; model: EmbeddingModel } | null> {
  if (!config.embeddings) return null;
  const provider = await getProvider(config, config.embeddings.provider);
  return {
    id: `${config.embeddings.provider}/${config.embeddings.model}`,
    model: provider.embeddingModel(config.embeddings.model),
  };
}
