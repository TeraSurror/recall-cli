import type { Config, ProviderConfig, ProviderType } from "../config/schema.ts";
import { errorMessage } from "../util/errors.ts";

export interface ProviderPreset {
  id: string;
  label: string;
  type: ProviderType;
  baseURL?: string;
  /** Conventional env var for the key; undefined = no key needed (local servers). */
  envVar?: string;
  keyUrl?: string;
  /** Suggested embedding model, if the provider offers embeddings. */
  embeddingModel?: string;
  local?: boolean;
}

export const PRESETS: ProviderPreset[] = [
  { id: "openrouter", label: "OpenRouter", type: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys" },
  { id: "anthropic", label: "Anthropic", type: "anthropic", envVar: "ANTHROPIC_API_KEY", keyUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", label: "OpenAI", type: "openai", envVar: "OPENAI_API_KEY", keyUrl: "https://platform.openai.com/api-keys", embeddingModel: "text-embedding-3-small" },
  { id: "google", label: "Google Gemini", type: "google", envVar: "GOOGLE_GENERATIVE_AI_API_KEY", keyUrl: "https://aistudio.google.com/apikey", embeddingModel: "text-embedding-004" },
  { id: "ollama", label: "Ollama (local)", type: "ollama", baseURL: "http://localhost:11434/api", local: true, embeddingModel: "nomic-embed-text" },
  { id: "lmstudio", label: "LM Studio (local)", type: "openai-compatible", baseURL: "http://localhost:1234/v1", local: true },
  { id: "groq", label: "Groq", type: "openai-compatible", baseURL: "https://api.groq.com/openai/v1", envVar: "GROQ_API_KEY", keyUrl: "https://console.groq.com/keys" },
  { id: "custom", label: "Other OpenAI-compatible API", type: "openai-compatible" },
];

/** Env var the provider SDK reads when no apiKey is configured. */
export function defaultEnvVar(type: ProviderType): string | undefined {
  return { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_GENERATIVE_AI_API_KEY", ollama: undefined, "openai-compatible": undefined }[type];
}

export type CredentialStatus = { ok: true; source: string } | { ok: false; reason: string };

/** Can this provider authenticate right now? (Doesn't make network calls.) */
export async function credentialStatus(p: ProviderConfig): Promise<CredentialStatus> {
  const key = p.apiKey;
  if (key?.startsWith("env:")) {
    const name = key.slice(4);
    return process.env[name] ? { ok: true, source: `$${name}` } : { ok: false, reason: `$${name} is not set` };
  }
  if (key?.startsWith("keychain:")) {
    const name = key.slice(9);
    try {
      const v = await Bun.secrets.get({ service: "recall-cli", name });
      return v ? { ok: true, source: `keychain:${name}` } : { ok: false, reason: `no keychain entry "${name}"` };
    } catch (e) {
      return { ok: false, reason: `keychain unavailable (${errorMessage(e)})` };
    }
  }
  if (key) return { ok: true, source: "literal key in config" };
  // Hosted OpenAI-compatible APIs we know require a key (OpenRouter, Groq, …).
  const hosted = p.baseURL ? PRESETS.find((x) => x.envVar && x.baseURL && p.baseURL!.replace(/\/+$/, "") === x.baseURL) : undefined;
  if (hosted) return { ok: false, reason: `no API key configured for ${hosted.label}` };
  const env = defaultEnvVar(p.type);
  if (!env) return { ok: true, source: "no key needed" };
  return process.env[env] ? { ok: true, source: `$${env}` } : { ok: false, reason: `$${env} is not set` };
}

/** Profiles whose provider is missing or can't authenticate. */
export async function unconfiguredProfiles(config: Config): Promise<{ profile: string; reason: string }[]> {
  const out: { profile: string; reason: string }[] = [];
  for (const [name, prof] of Object.entries(config.profiles)) {
    const p = config.providers[prof.provider];
    if (!p) {
      out.push({ profile: name, reason: `provider "${prof.provider}" doesn't exist` });
      continue;
    }
    const s = await credentialStatus(p);
    if (!s.ok) out.push({ profile: name, reason: s.reason });
  }
  return out;
}

export interface CatalogModel {
  id: string;
  name?: string;
  /** Known to support tool calling (undefined = unknown). */
  tools?: boolean;
  contextLength?: number;
  embedding?: boolean;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}${body ? `: ${body}` : ""}`);
  }
  return res.json();
}

/** Ask the provider which models it offers. Throws on network/auth errors. */
export async function listProviderModels(p: ProviderConfig, apiKey?: string): Promise<CatalogModel[]> {
  const base = p.baseURL?.replace(/\/+$/, "");
  switch (p.type) {
    case "openai":
    case "openai-compatible": {
      const url = `${base ?? "https://api.openai.com/v1"}/models`;
      const data = await getJson(url, { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...p.headers });
      return ((data.data ?? data.models ?? []) as any[])
        .map((m) => ({
          id: String(m.id ?? m.name),
          name: m.name && m.name !== m.id ? String(m.name) : undefined,
          // OpenRouter lists supported request parameters per model.
          tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : undefined,
          contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
          embedding: /embed/i.test(String(m.id)) || undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    case "ollama": {
      const data = await getJson(`${base ?? "http://localhost:11434/api"}/tags`, { ...p.headers });
      return ((data.models ?? []) as any[]).map((m) => ({
        id: String(m.name ?? m.model),
        embedding: /embed|bge|minilm|e5/i.test(String(m.name)) || undefined,
      }));
    }
    case "anthropic": {
      const data = await getJson(`${base ?? "https://api.anthropic.com/v1"}/models?limit=100`, {
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        "anthropic-version": "2023-06-01",
        ...p.headers,
      });
      return ((data.data ?? []) as any[]).map((m) => ({ id: String(m.id), name: m.display_name, tools: true }));
    }
    case "google": {
      const url = `${base ?? "https://generativelanguage.googleapis.com/v1beta"}/models?pageSize=200${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ""}`;
      const data = await getJson(url, { ...p.headers });
      return ((data.models ?? []) as any[]).map((m) => {
        const methods: string[] = m.supportedGenerationMethods ?? [];
        return {
          id: String(m.name).replace(/^models\//, ""),
          name: m.displayName,
          contextLength: m.inputTokenLimit,
          tools: methods.includes("generateContent") || undefined,
          embedding: methods.includes("embedContent") || undefined,
        };
      });
    }
  }
}

export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  return models.filter((m) => terms.every((t) => `${m.id} ${m.name ?? ""}`.toLowerCase().includes(t)));
}

/** A short, valid profile name derived from a model id: "anthropic/claude-sonnet-4.5" → "claude-sonnet-4-5". */
export function profileNameFor(modelId: string): string {
  const last = modelId.split("/").pop() ?? modelId;
  return last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "model";
}
