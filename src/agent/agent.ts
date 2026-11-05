import { isStepCount, streamText, tool, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import type { ToolContext } from "../tools/context.ts";
import { vaultNamesFor } from "../tools/context.ts";
import { ALL_TOOLS, invokeTool } from "../tools/registry.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { resolveProfile, type ResolvedProfile } from "../llm/providers.ts";
import { hybridSearch } from "../search/search.ts";
import { errorMessage } from "../util/errors.ts";

export interface AgentCallbacks {
  onTextDelta?(text: string): void;
  onToolCall?(call: { id: string; name: string; input: unknown }): void;
  onToolResult?(res: { id: string; name: string; output: unknown; error?: string }): void;
  onStepFinish?(): void;
}

export interface TurnResult {
  text: string;
  usage: { input: number; output: number };
  finishReason: string;
  aborted: boolean;
  error?: string;
}

/** Build AI SDK tools from the shared registry, bound to a context. */
export function buildToolSet(ctx: ToolContext, opts: { readOnly?: boolean } = {}): ToolSet {
  const set: ToolSet = {};
  for (const t of ALL_TOOLS) {
    if (opts.readOnly && t.kind === "write") continue;
    set[t.name] = tool({
      description: t.description,
      inputSchema: t.input,
      execute: async (input: unknown) => {
        const r = await invokeTool(t, input, ctx);
        return r.ok ? r.value : { error: r.error };
      },
    });
  }
  return set;
}

function addUsage(acc: { input: number; output: number }, u: LanguageModelUsage | undefined) {
  acc.input += u?.inputTokens ?? 0;
  acc.output += u?.outputTokens ?? 0;
}

/**
 * A conversation with an LLM over the user's vaults. Keeps message history across turns.
 * The same class powers the TUI, `recall ask` and `recall run`.
 */
export class Agent {
  messages: ModelMessage[] = [];
  totalUsage = { input: 0, output: 0 };
  private resolved: ResolvedProfile | null = null;

  constructor(
    readonly ctx: ToolContext,
    public profileName?: string,
  ) {}

  async profile(): Promise<ResolvedProfile> {
    if (!this.resolved || (this.profileName && this.resolved.name !== this.profileName)) {
      this.resolved = await resolveProfile(this.ctx.ws.config, this.profileName);
      this.profileName = this.resolved.name;
    }
    return this.resolved;
  }

  /** Use an already-constructed model (tests, embedding custom providers). */
  useResolved(r: ResolvedProfile): void {
    this.resolved = r;
    this.profileName = r.name;
  }

  setProfile(name: string): void {
    this.profileName = name;
    this.resolved = null;
  }

  clear(): void {
    this.messages = [];
  }

  /** For models without tool calling: retrieve excerpts up front and attach them. */
  private async retrievalContext(question: string): Promise<string> {
    const embedder = await this.ctx.ws.embedder();
    const parts: string[] = [];
    for (const name of vaultNamesFor(this.ctx)) {
      this.ctx.ws.ensureFresh(name);
      const { db, vault } = this.ctx.ws.get(name);
      const res = await hybridSearch(db, question, { limit: 6, embedder: vault.config.embeddings ? embedder : null });
      for (const h of res.hits) {
        parts.push(`<excerpt vault="${name}" note="${h.path}"${h.heading ? ` heading="${h.heading}"` : ""}>\n${h.text}\n</excerpt>`);
      }
    }
    return parts.length ? parts.join("\n\n") : "(no matching notes found)";
  }

  async send(userText: string, cb: AgentCallbacks = {}, signal?: AbortSignal): Promise<TurnResult> {
    const { model, profile } = await this.profile();
    const toolsEnabled = profile.tools;
    const system = buildSystemPrompt(this.ctx, { toolsEnabled });
    const content = toolsEnabled
      ? userText
      : `${userText}\n\n<notes>\n${await this.retrievalContext(userText)}\n</notes>`;
    const pending: ModelMessage[] = [...this.messages, { role: "user", content }];

    const usage = { input: 0, output: 0 };
    let text = "";
    let finishReason = "unknown";
    let streamError: string | undefined;
    const result = streamText({
      model,
      system,
      messages: pending,
      ...(toolsEnabled ? { tools: buildToolSet({ ...this.ctx, signal }), stopWhen: isStepCount(profile.maxSteps) } : {}),
      temperature: profile.temperature,
      maxOutputTokens: profile.maxOutputTokens,
      abortSignal: signal,
      onError: ({ error }) => {
        streamError = errorMessage(error);
      },
    });

    let aborted = false;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            text += part.text;
            cb.onTextDelta?.(part.text);
            break;
          case "tool-call":
            cb.onToolCall?.({ id: part.toolCallId, name: part.toolName, input: part.input });
            break;
          case "tool-result": {
            const out = part.output as { error?: string } | undefined;
            cb.onToolResult?.({
              id: part.toolCallId,
              name: part.toolName,
              output: part.output,
              error: out && typeof out === "object" && "error" in out ? String(out.error) : undefined,
            });
            break;
          }
          case "tool-error":
            cb.onToolResult?.({ id: part.toolCallId, name: part.toolName, output: null, error: errorMessage(part.error) });
            break;
          case "finish-step":
            text += text && !text.endsWith("\n") ? "\n" : "";
            cb.onStepFinish?.();
            break;
          case "finish":
            finishReason = part.finishReason;
            addUsage(usage, part.totalUsage);
            break;
          case "abort":
            aborted = true;
            break;
          case "error":
            streamError = errorMessage(part.error);
            break;
        }
      }
    } catch (e) {
      if (signal?.aborted) aborted = true;
      else streamError = errorMessage(e);
    }

    // Persist whatever completed: user message + every finished step's messages.
    let stepMessages: ModelMessage[] = [];
    try {
      const steps = await result.steps;
      stepMessages = steps.flatMap((s) => s.response.messages as ModelMessage[]);
    } catch {
      // aborted/errored before any step finished
    }
    if (stepMessages.length || !streamError) {
      this.messages = [...pending, ...stepMessages];
      if (aborted || (stepMessages.length && stepMessages[stepMessages.length - 1]!.role === "tool")) {
        // Keep the transcript valid if we stopped mid-loop.
        this.messages.push({ role: "assistant", content: aborted ? "(interrupted by user)" : "(stopped: step limit reached)" });
      }
    }
    this.totalUsage.input += usage.input;
    this.totalUsage.output += usage.output;
    return { text: text.trim(), usage, finishReason, aborted, error: aborted ? undefined : streamError };
  }
}
