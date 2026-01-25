import type { LLMProvider, EmbeddingProvider } from "./types.ts";
import { OllamaLLMProvider, OllamaEmbeddingProvider } from "./providers/ollama.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import type { RecallConfig } from "../core/config/schema.ts";
import { LLMError, EmbeddingError } from "../utils/errors.ts";

export function createLLMProvider(config: RecallConfig): LLMProvider {
  const { provider, model } = config.llm;

  switch (provider) {
    case "ollama":
      return new OllamaLLMProvider(model);

    case "openai": {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new LLMError("OPENAI_API_KEY environment variable is required");
      }
      return new OpenAIProvider(apiKey, model);
    }

    case "anthropic": {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new LLMError("ANTHROPIC_API_KEY environment variable is required");
      }
      return new AnthropicProvider(apiKey, model);
    }

    default:
      throw new LLMError(`Unknown LLM provider: ${provider}`);
  }
}

export function createEmbeddingProvider(config: RecallConfig): EmbeddingProvider {
  const { provider, model, dimensions } = config.embeddings;

  switch (provider) {
    case "ollama":
      return new OllamaEmbeddingProvider(model, dimensions);

    default:
      throw new EmbeddingError(`Unknown embedding provider: ${provider}`);
  }
}
