import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeEnv, type TestEnv } from "./helpers.ts";
import { scriptedModel, type ScriptStep } from "./mock-model.ts";
import { Agent } from "../src/agent/agent.ts";
import { buildSystemPrompt } from "../src/agent/system-prompt.ts";
import type { ToolContext } from "../src/tools/context.ts";
import { ProfileSchema } from "../src/config/schema.ts";
import { loadSession, saveSession } from "../src/agent/sessions.ts";

let env: TestEnv;
afterEach(() => env?.cleanup());

function agentWith(steps: ScriptStep[], over: Partial<ToolContext> = {}, tools = true) {
  const ctx: ToolContext = { ws: env.ws, surface: "tui", policy: {}, sessionId: "s", ...over };
  const agent = new Agent(ctx);
  const m = scriptedModel(steps);
  agent.useResolved({ name: "mock", model: m.model, profile: ProfileSchema.parse({ provider: "x", model: "y", tools }) });
  return { agent, ...m };
}

describe("agent loop", () => {
  test("search → read → answer, with streamed callbacks and persisted history", async () => {
    env = makeEnv();
    const { agent } = agentWith([
      { tool: "search", input: { query: "passkeys decision" } },
      { tool: "read_note", input: { note: "Auth Redesign" } },
      { text: "You decided on WebAuthn passkeys — see [[Auth Redesign]]." },
    ]);
    const events: string[] = [];
    let streamed = "";
    const r = await agent.send("what did I decide about auth?", {
      onTextDelta: (t) => (streamed += t),
      onToolCall: (c) => events.push(`call:${c.name}`),
      onToolResult: (res) => events.push(`result:${res.name}${res.error ? ":err" : ""}`),
    });
    expect(events).toEqual(["call:search", "result:search", "call:read_note", "result:read_note"]);
    expect(r.text).toContain("[[Auth Redesign]]");
    expect(streamed.trim()).toBe(r.text);
    // user + (assistant tool-call + tool result) x2 + final assistant
    expect(agent.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant"]);
  });

  test("write in ask mode goes through approver; rejection feedback is visible to the model", async () => {
    env = makeEnv({ mode: "ask" });
    const { agent, prompts } = agentWith(
      [{ tool: "append_to_note", input: { note: "Orphan", content: "- new" } }, { text: "ok, I won't." }],
      { approve: async () => ({ approved: false, feedback: "not that note" }) },
    );
    await agent.send("add a line");
    expect(readFileSync(join(env.vaultRoot, "Orphan.md"), "utf8")).not.toContain("- new");
    expect(JSON.stringify(prompts[1])).toContain("not that note");
  });

  test("tool errors are returned to the model instead of crashing the loop", async () => {
    env = makeEnv();
    const { agent, prompts } = agentWith([{ tool: "read_note", input: { note: "../../etc/passwd" } }, { text: "can't" }]);
    const errs: string[] = [];
    const r = await agent.send("read it", { onToolResult: (x) => x.error && errs.push(x.error) });
    expect(errs[0]).toContain("escapes the vault");
    expect(r.error).toBeUndefined();
    expect(JSON.stringify(prompts[1])).toContain("escapes the vault");
  });

  test("non-tool models get retrieved excerpts inline", async () => {
    env = makeEnv();
    const { agent, prompts } = agentWith([{ text: "Passkeys." }], {}, false);
    await agent.send("passkeys decision");
    const p = JSON.stringify(prompts[0]);
    expect(p).toContain("<excerpt");
    expect(p).toContain("Auth Redesign");
    expect(p).not.toContain('"tools"');
  });

  test("multi-turn keeps history", async () => {
    env = makeEnv();
    const { agent, prompts } = agentWith([{ text: "first" }, { text: "second" }]);
    await agent.send("one");
    await agent.send("two");
    expect(JSON.stringify(prompts[1])).toContain("first");
  });

  test("abort mid-turn leaves a valid transcript", async () => {
    env = makeEnv();
    const { agent } = agentWith([{ text: "x".repeat(400) }]);
    const ac = new AbortController();
    const r = await agent.send("hi", { onTextDelta: () => ac.abort() }, ac.signal);
    expect(r.aborted).toBe(true);
  });
});

describe("system prompt & sessions", () => {
  test("includes vaults, write modes, daily format and vault instructions", () => {
    env = makeEnv({ mode: "ask" });
    mkdirSync(join(env.vaultRoot, ".recall"));
    writeFileSync(join(env.vaultRoot, ".recall/instructions.md"), "Always tag meeting notes with #meeting.");
    const p = buildSystemPrompt({ ws: env.ws, surface: "tui", policy: {}, sessionId: "s" }, { toolsEnabled: true, now: new Date(2026, 10, 4) });
    expect(p).toContain("Wednesday, 2026-11-04");
    expect(p).toContain("- test (default): 5 notes; writes: ask; daily notes: Daily/YYYY-MM-DD.md");
    expect(p).toContain("Always tag meeting notes with #meeting.");
  });

  test("sessions round-trip", () => {
    env = makeEnv();
    saveSession("20261104-abcd1234", [{ role: "user", content: "hello there" }, { role: "assistant", content: "hi" }], "mock");
    const s = loadSession("abcd1234");
    expect(s?.info.title).toBe("hello there");
    expect(s?.messages).toHaveLength(2);
  });
});
