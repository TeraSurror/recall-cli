import OpenAI from "openai";
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMOptions,
  Message,
} from "../types.ts";
import { LLMError } from "../../utils/errors.ts";

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, model: string = "gpt-4o-mini") {
    this.client = new OpenAI({ apiKey });
    this.defaultModel = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    try {
      const response = await this.client.chat.completions.create({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
      });

      const choice = response.choices[0];
      return {
        content: choice?.message?.content || "",
        model: response.model,
        usage: response.usage
          ? {
              promptTokens: response.usage.prompt_tokens,
              completionTokens: response.usage.completion_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined,
      };
    } catch (error) {
      throw new LLMError(`OpenAI chat failed: ${error}`);
    }
  }

  async *stream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<LLMStreamChunk> {
    try {
      const stream = await this.client.chat.completions.create({
        model: options?.model || this.defaultModel,
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
        stream: true,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        yield {
          content: delta?.content || "",
          done: chunk.choices[0]?.finish_reason !== null,
        };
      }
    } catch (error) {
      throw new LLMError(`OpenAI stream failed: ${error}`);
    }
  }
}
