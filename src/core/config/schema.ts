export interface VaultConfig {
  path: string;
  excludePatterns: string[];
}

export interface LLMConfig {
  provider: "ollama" | "openai" | "anthropic";
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface EmbeddingsConfig {
  provider: "ollama";
  model: string;
  dimensions: number;
}

export interface SearchConfig {
  topK: number;
  minScore: number;
}

export interface RecallConfig {
  vault: VaultConfig;
  llm: LLMConfig;
  embeddings: EmbeddingsConfig;
  search: SearchConfig;
}

export const defaultConfig: RecallConfig = {
  vault: {
    path: "",
    excludePatterns: [".obsidian/**", ".trash/**", ".git/**"],
  },
  llm: {
    provider: "ollama",
    model: "llama3.2",
    temperature: 0.7,
    maxTokens: 2048,
  },
  embeddings: {
    provider: "ollama",
    model: "nomic-embed-text",
    dimensions: 768,
  },
  search: {
    topK: 5,
    minScore: 0.7,
  },
};
