import { MockLanguageModelV4 } from "ai/test";
import { simulateReadableStream } from "ai";

export type ScriptStep =
  | { text: string }
  | { tool: string; input: Record<string, unknown> }
  | { tools: { tool: string; input: Record<string, unknown> }[] };

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/**
 * A scripted model: each call to the model plays the next step. Tool steps emit tool
 * calls; text steps stream text in a few deltas. Records the prompts it received.
 */
export function scriptedModel(steps: ScriptStep[]) {
  let i = 0;
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doStream: async (opts: { prompt: unknown }) => {
      prompts.push(opts.prompt);
      const step = steps[Math.min(i++, steps.length - 1)]!;
      const parts: unknown[] = [{ type: "stream-start", warnings: [] }];
      if ("text" in step) {
        parts.push({ type: "text-start", id: "t" });
        for (const piece of step.text.match(/.{1,8}/gs) ?? []) parts.push({ type: "text-delta", id: "t", delta: piece });
        parts.push({ type: "text-end", id: "t" });
        parts.push({ type: "finish", usage, finishReason: { unified: "stop", raw: "stop" } });
      } else {
        const calls = "tools" in step ? step.tools : [step];
        calls.forEach((c, k) =>
          parts.push({
            type: "tool-call",
            toolCallId: `call_${i}_${k}`,
            toolName: c.tool,
            input: JSON.stringify(c.input),
          }),
        );
        parts.push({ type: "finish", usage, finishReason: { unified: "tool-calls", raw: "tool_use" } });
      }
      return { stream: simulateReadableStream({ chunks: parts as never[] }) };
    },
  });
  return { model, prompts, calls: () => i };
}
