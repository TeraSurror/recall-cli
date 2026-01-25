import { Ollama } from "ollama";
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMOptions,
  Message,
  EmbeddingProvider,
} from "../types.ts";
import { LLMError, EmbeddingError } from "../../utils/errors.ts";

export class OllamaLLMProvider implements LLMProvider {
  name = "ollama";
  private client: Ollama;
  private defaultModel: string;

  constructor(model: string = "llama3.2", host?: string) {
    this.client = new Ollama({ host });
    this.defaultModel = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    try {
      const response = await this.client.chat({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
        },
      });

      return {
        content: response.message.content,
        model: response.model,
        usage: {
          promptTokens: response.prompt_eval_count || 0,
          completionTokens: response.eval_count || 0,
          totalTokens:
            (response.prompt_eval_count || 0) + (response.eval_count || 0),
        },
      };
    } catch (error) {
      throw new LLMError(`Ollama chat failed: ${error}`);
    }
  }

  async *stream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<LLMStreamChunk> {
    try {
      const response = await this.client.chat({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
        options: {
          temperature: options?.temperature,
          num_predict: options?.maxTokens,
        },
      });

      for await (const chunk of response) {
        yield {
          content: chunk.message.content,
          done: chunk.done,
        };
      }
    } catch (error) {
      throw new LLMError(`Ollama stream failed: ${error}`);
    }
  }
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  name = "ollama";
  dimensions: number;
  private client: Ollama;
  private model: string;

  constructor(model: string = "nomic-embed-text", dimensions: number = 768, host?: string) {
    this.client = new Ollama({ host });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embed({
        model: this.model,
        input: text,
      });
      return response.embeddings[0] || [];
    } catch (error) {
      throw new EmbeddingError(`Ollama embedding failed: ${error}`);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    try {
      const response = await this.client.embed({
        model: this.model,
        input: texts,
      });
      return response.embeddings;
    } catch (error) {
      throw new EmbeddingError(`Ollama batch embedding failed: ${error}`);
    }
  }
}
