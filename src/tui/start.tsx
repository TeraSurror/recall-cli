import React from "react";
import { render } from "ink";
import { Workspace } from "../workspace.ts";
import { App } from "./App.tsx";
import { listSessions, loadSession } from "../agent/sessions.ts";
import { RecallError } from "../util/errors.ts";

export interface TuiOptions {
  profile?: string;
  vaults?: string[];
  /** true → most recent session; string → that session id. */
  resume?: boolean | string;
  /** Use the alternate screen with a pinned input (default true; RECALL_NO_FULLSCREEN=1 disables). */
  fullscreen?: boolean;
}

export async function startTui(opts: TuiOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new RecallError("The interactive TUI needs a terminal.", 'For scripts use: recall ask "…"');
  }
  const ws = Workspace.load();
  for (const v of opts.vaults ?? []) ws.get(v);
  let resume: { id: string; messages: import("ai").ModelMessage[] } | undefined;
  if (opts.resume) {
    const id = typeof opts.resume === "string" ? opts.resume : listSessions(1)[0]?.id;
    const s = id ? loadSession(id) : null;
    if (!s) throw new RecallError("No session to resume.");
    resume = { id: s.info.id, messages: s.messages };
  }
  const fullscreen = (opts.fullscreen ?? true) && !process.env.RECALL_NO_FULLSCREEN;
  const app = render(<App ws={ws} profile={opts.profile} vaults={opts.vaults} resume={resume} fullscreen={fullscreen} />, {
    exitOnCtrlC: false,
    alternateScreen: fullscreen,
  });
  await app.waitUntilExit();
  ws.close();
}
