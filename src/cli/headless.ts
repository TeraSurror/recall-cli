import type { Workspace } from "../workspace.ts";
import { Agent } from "../agent/agent.ts";
import type { ToolContext } from "../tools/context.ts";
import { newSessionId, saveSession } from "../agent/sessions.ts";
import type { PermissionMode } from "../config/schema.ts";
import { c, describeToolCall, describeToolResult } from "../util/term.ts";

export interface HeadlessOptions {
  vaults?: string[];
  profile?: string;
  allowWrites?: boolean;
  /** Recipe cap: "read-only" forces read-only; other values can't grant more than the vault allows. */
  modeCap?: PermissionMode;
  json?: boolean;
  quiet?: boolean;
}

/** Run one agent turn without a UI: answer → stdout, tool activity → stderr. Returns exit code. */
export async function runHeadless(ws: Workspace, prompt: string, opts: HeadlessOptions = {}): Promise<number> {
  const sessionId = newSessionId();
  const applied: string[] = [];
  const ctx: ToolContext = {
    ws,
    surface: "headless",
    policy: { allowWrites: opts.allowWrites, override: opts.modeCap === "read-only" ? "read-only" : undefined },
    sessionId,
    allowedVaults: opts.vaults?.length ? opts.vaults : undefined,
    onApplied: (rec) => applied.push(rec.changeset.title),
  };
  for (const v of opts.vaults ?? []) ws.get(v); // validate early

  const agent = new Agent(ctx, opts.profile);
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  const err = process.stderr;
  const streamToStdout = !opts.json;
  let wroteText = false;

  const result = await agent.send(
    prompt,
    {
      onTextDelta: (t) => {
        if (streamToStdout) {
          process.stdout.write(t);
          wroteText = true;
        }
      },
      onToolCall: (call) => {
        if (!opts.quiet) err.write(c.dim(`  ⋯ ${describeToolCall(call.name, call.input)}\n`, err));
      },
      onToolResult: (r) => {
        if (opts.quiet) return;
        const line = describeToolResult(r.name, r.error ? { error: r.error } : r.output);
        err.write((r.error ? c.red : c.dim)(`    ${line}\n`, err));
      },
    },
    ac.signal,
  );
  saveSession(sessionId, agent.messages, agent.profileName);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ text: result.text, session: sessionId, applied, usage: result.usage, error: result.error }, null, 2) + "\n",
    );
  } else if (wroteText) {
    process.stdout.write("\n");
  }
  if (!opts.quiet && applied.length) err.write(c.green(`\n✓ ${applied.length} change(s) applied — undo with: recall undo\n`, err));
  if (result.error) {
    err.write(c.red(`\nError: ${result.error}\n`, err));
    return 1;
  }
  return result.aborted ? 130 : 0;
}
