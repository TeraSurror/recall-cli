import Anthropic from "@anthropic-ai/sdk";
import type {
  LLMProvider,
  LLMResponse,
  LLMStreamChunk,
  LLMOptions,
  Message,
} from "../types.ts";
import { LLMError } from "../../utils/errors.ts";

export class AnthropicProvider implements LLMProvider {
  name = "anthropic";
  private client: Anthropic;
  private defaultModel: string;

  constructor(apiKey: string, model: string = "claude-sonnet-4-20250514") {
    this.client = new Anthropic({ apiKey });
    this.defaultModel = model;
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    try {
      const systemMessage = messages.find((m) => m.role === "system");
      const chatMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const response = await this.client.messages.create({
        model: options?.model || this.defaultModel,
        max_tokens: options?.maxTokens || 2048,
        system: systemMessage?.content,
        messages: chatMessages,
      });

      const textBlock = response.content.find((c) => c.type === "text");
      return {
        content: textBlock?.type === "text" ? textBlock.text : "",
        model: response.model,
        usage: {
          promptTokens: response.usage.input_tokens,
          completionTokens: response.usage.output_tokens,
          totalTokens:
            response.usage.input_tokens + response.usage.output_tokens,
        },
      };
    } catch (error) {
      throw new LLMError(`Anthropic chat failed: ${error}`);
    }
  }

  async *stream(
    messages: Message[],
    options?: LLMOptions
  ): AsyncIterable<LLMStreamChunk> {
    try {
      const systemMessage = messages.find((m) => m.role === "system");
      const chatMessages = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

      const stream = this.client.messages.stream({
        model: options?.model || this.defaultModel,
        max_tokens: options?.maxTokens || 2048,
        system: systemMessage?.content,
        messages: chatMessages,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield {
            content: event.delta.text,
            done: false,
          };
        } else if (event.type === "message_stop") {
          yield {
            content: "",
            done: true,
          };
        }
      }
    } catch (error) {
      throw new LLMError(`Anthropic stream failed: ${error}`);
    }
  }
}
