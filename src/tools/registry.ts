import { readTools } from "./read.ts";
import { writeTools } from "./write.ts";
import type { RecallTool, ToolContext } from "./context.ts";
import { errorMessage, RecallError } from "../util/errors.ts";

export const ALL_TOOLS: RecallTool[] = [...readTools, ...writeTools] as RecallTool[];

export function getTool(name: string): RecallTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export type ToolResult = { ok: true; value: unknown } | { ok: false; error: string };

/** Validate input and run a tool, converting errors into a model-readable result. */
export async function invokeTool(tool: RecallTool, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: `Invalid arguments for ${tool.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`,
    };
  }
  try {
    return { ok: true, value: await tool.run(parsed.data, ctx) };
  } catch (e) {
    if (e instanceof RecallError) return { ok: false, error: e.message };
    if ((e as Error)?.name === "AbortError") throw e;
    return { ok: false, error: `${tool.name} failed: ${errorMessage(e)}` };
  }
}
