import { z } from "zod";

export const PermissionMode = z.enum(["read-only", "ask", "auto"]);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const VaultSchema = z.object({
  path: z.string().min(1),
  /** Permission for the TUI / interactive agent. */
  mode: PermissionMode.default("ask"),
  /** Permission when accessed via `recall mcp` or headless `recall ask`. */
  mcpMode: PermissionMode.default("read-only"),
  exclude: z.array(z.string()).default([]),
  embeddings: z.boolean().default(true),
});
export type VaultConfig = z.infer<typeof VaultSchema>;

export const ProviderType = z.enum(["anthropic", "openai", "google", "ollama", "openai-compatible"]);
export type ProviderType = z.infer<typeof ProviderType>;

export const ProviderSchema = z.object({
  type: ProviderType,
  /**
   * API key. Either a literal (discouraged), `env:VAR_NAME`, or `keychain:<name>`
   * (stored with `recall model key set <name>`). Omit to use the provider's
   * default env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...).
   */
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const ProfileSchema = z.object({
  provider: z.string(),
  model: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Whether the model supports tool calling. If false, Recall pre-retrieves context instead. */
  tools: z.boolean().default(true),
  maxSteps: z.number().int().positive().default(25),
});
export type ProfileConfig = z.infer<typeof ProfileSchema>;

export const EmbeddingsSchema = z.object({
  provider: z.string(),
  model: z.string(),
});
export type EmbeddingsConfig = z.infer<typeof EmbeddingsSchema>;

export const ConfigSchema = z.object({
  $schema: z.string().optional(),
  defaultVault: z.string().optional(),
  defaultProfile: z.string().optional(),
  vaults: z.record(z.string(), VaultSchema).default({}),
  providers: z.record(z.string(), ProviderSchema).default({}),
  profiles: z.record(z.string(), ProfileSchema).default({}),
  /** Omit to disable embeddings (keyword search only). */
  embeddings: EmbeddingsSchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export const VAULT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const DEFAULT_CONFIG_TEXT = `// Recall configuration — https://github.com/TeraSurror/recall-cli
// Edit by hand or via \`recall vault ...\` / \`recall model ...\`; comments are preserved.
{
  "$schema": "https://raw.githubusercontent.com/TeraSurror/recall-cli/main/config.schema.json",

  // Vaults are only ever added explicitly. Mode: "read-only" | "ask" | "auto"
  "vaults": {},

  "providers": {
    // API keys default to ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY.
    "anthropic": { "type": "anthropic" },
    "ollama": { "type": "ollama", "baseURL": "http://localhost:11434/api" }
    // "lmstudio": { "type": "openai-compatible", "baseURL": "http://localhost:1234/v1" },
    // "openrouter": { "type": "openai-compatible", "baseURL": "https://openrouter.ai/api/v1", "apiKey": "env:OPENROUTER_API_KEY" }
  },

  "profiles": {
    "sonnet": { "provider": "anthropic", "model": "claude-sonnet-5-5" },
    "local": { "provider": "ollama", "model": "qwen3" }
  },
  "defaultProfile": "sonnet",

  // Remove this block to use keyword-only search.
  "embeddings": { "provider": "ollama", "model": "nomic-embed-text" }
}
`;
