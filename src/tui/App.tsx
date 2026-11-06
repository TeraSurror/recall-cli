import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, measureElement, useApp, useInput, useWindowSize, type DOMElement } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type { ModelMessage } from "ai";
import type { Workspace } from "../workspace.ts";
import { Agent } from "../agent/agent.ts";
import type { ToolContext } from "../tools/context.ts";
import type { Changeset } from "../changes/changeset.ts";
import type { PermissionMode } from "../config/schema.ts";
import { effectiveMode } from "../agent/approval.ts";
import { newSessionId, saveSession } from "../agent/sessions.ts";
import { VaultWatcher } from "../index/watcher.ts";
import { describeToolCall, describeToolResult } from "../util/term.ts";
import { errorMessage } from "../util/errors.ts";
import { credentialStatus } from "../llm/catalog.ts";
import { Markdown } from "./Markdown.tsx";
import { DiffReview, type ReviewResult } from "./DiffReview.tsx";
import { expandMentions, handleSlash, type Notice } from "./commands.ts";
import pkg from "../../package.json" with { type: "json" };

type ToolSeg = { type: "tool"; id: string; name: string; input: unknown; result?: string; error?: boolean; done: boolean };
type TextSeg = { type: "text"; text: string };
type Seg = ToolSeg | TextSeg;

type Item =
  | { id: number; kind: "banner" }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "seg"; seg: Seg }
  | { id: number; kind: "notice"; notice: Notice };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

let nextId = 0;
const item = (i: NewItem) => ({ ...i, id: nextId++ }) as Item;

export interface AppProps {
  ws: Workspace;
  profile?: string;
  vaults?: string[];
  resume?: { id: string; messages: ModelMessage[] };
  /** Take over the whole terminal (alternate screen) with the input pinned to the bottom. */
  fullscreen?: boolean;
}

/** Fullscreen mode renders only the most recent transcript items, to keep frames cheap. */
const MAX_FULLSCREEN_ITEMS = 400;

function ToolLine({ seg, paused }: { seg: ToolSeg; paused?: boolean }) {
  const icon = seg.name.match(/^(create|edit|append|set|move|delete)/) ? "✎" : "⌕";
  return (
    <Box paddingLeft={2} flexDirection="column">
      <Text>
        {seg.done ? (
          <Text color={seg.error ? "red" : "gray"}>{icon} </Text>
        ) : paused ? (
          <Text color="yellow">◌ </Text>
        ) : (
          <Text color="cyan">
            <Spinner type="dots" />{" "}
          </Text>
        )}
        <Text color="gray">{describeToolCall(seg.name, seg.input)}</Text>
        {seg.result && <Text color={seg.error ? "red" : seg.result.startsWith("✓") ? "green" : "gray"}> · {seg.result}</Text>}
      </Text>
    </Box>
  );
}

function Banner({ ws }: { ws: Workspace }) {
  const names = ws.vaultNames();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold color="magenta">recall</Text>
        <Text color="gray"> v{pkg.version} · your vaults, any model</Text>
      </Text>
      {names.length === 0 ? (
        <Text color="yellow">No vaults registered yet. Add one with /vault add ~/path/to/vault</Text>
      ) : (
        <Text color="gray">/help for commands · @[[Note]] to attach · Esc to interrupt</Text>
      )}
    </Box>
  );
}

function renderItem(it: Item, ws: Workspace) {
  switch (it.kind) {
    case "banner":
      return <Banner key={it.id} ws={ws} />;
    case "user":
      return (
        <Box key={it.id} marginTop={1}>
          <Text color="magenta" bold>› </Text>
          <Text>{it.text}</Text>
        </Box>
      );
    case "seg":
      return it.seg.type === "text" ? (
        <Box key={it.id} marginTop={1}>
          <Markdown text={it.seg.text.trim()} />
        </Box>
      ) : (
        <ToolLine key={it.id} seg={it.seg} />
      );
    case "notice":
      return (
        <Box key={it.id} marginTop={1} paddingLeft={2}>
          <Text color={it.notice.kind === "error" ? "red" : it.notice.kind === "success" ? "green" : "gray"}>
            {it.notice.kind === "error" ? "✗ " : it.notice.kind === "success" ? "✓ " : ""}
            {it.notice.text}
          </Text>
        </Box>
      );
  }
}

export function App({ ws, profile, vaults, resume, fullscreen = false }: AppProps) {
  const { exit } = useApp();
  const { rows, columns } = useWindowSize();
  // Fullscreen transcript scrolling: lines scrolled up from the bottom.
  const [scroll, setScroll] = useState(0);
  const viewRef = useRef<DOMElement>(null);
  const contentRef = useRef<DOMElement>(null);
  const maxScroll = () => {
    if (!viewRef.current || !contentRef.current) return 0;
    return Math.max(0, measureElement(contentRef.current).height - measureElement(viewRef.current).height);
  };
  const [items, setItems] = useState<Item[]>(() => [item({ kind: "banner" })]);
  const [live, setLive] = useState<Seg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ cs: Changeset; resolve: (r: ReviewResult) => void } | null>(null);
  const [activeVaults, setActiveVaults] = useState<string[] | undefined>(vaults);
  const [modeOverride, setModeOverride] = useState<PermissionMode | undefined>();
  const [indexStatus, setIndexStatus] = useState("indexing…");
  const [usage, setUsage] = useState({ input: 0, output: 0 });
  const [, setTick] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const history = useRef<string[]>([]);
  const historyPos = useRef(-1);
  const lastCtrlC = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const sessionId = useRef(resume?.id ?? newSessionId());

  const push = useCallback((...its: NewItem[]) => setItems((prev) => [...prev, ...its.map(item)]), []);
  const notify = useCallback((n: Notice) => push({ kind: "notice", notice: n }), [push]);

  // One mutable tool context shared with the agent; state changes update it in place.
  const ctx = useMemo<ToolContext>(
    () => ({
      ws,
      surface: "tui",
      policy: {},
      sessionId: sessionId.current,
      approve: (cs) =>
        new Promise((resolve) => {
          setPending({
            cs,
            resolve: (r) => {
              setPending(null);
              if (r.always) setModeOverride("auto");
              resolve(r);
            },
          });
        }),
    }),
    [ws],
  );
  ctx.allowedVaults = activeVaults;
  ctx.policy.override = modeOverride;

  const agent = useMemo(() => {
    const a = new Agent(ctx, profile);
    if (resume) a.messages = resume.messages;
    return a;
  }, [ctx]);

  // Initial index + watcher.
  useEffect(() => {
    let watcher: VaultWatcher | null = null;
    let cancelled = false;
    (async () => {
      const names = ws.vaultNames();
      let total = 0;
      for (const n of names) {
        try {
          ws.sync(n);
          total += (ws.get(n).db.query("SELECT count(*) AS c FROM notes").get() as { c: number }).c;
        } catch (e) {
          notify({ kind: "error", text: `${n}: ${errorMessage(e)}` });
        }
      }
      if (cancelled) return;
      setIndexStatus(`${total.toLocaleString()} notes`);
      watcher = new VaultWatcher(ws, (e) => {
        if (e.type === "indexed") setIndexStatus(`↻ ${e.path.split("/").pop()}`);
        else if (e.type === "embedded") setIndexStatus(`embedded ${e.count}`);
        else setIndexStatus(`! ${e.message.slice(0, 40)}`);
      });
      await watcher.start(names);
      // Background embedding of anything new since last run.
      for (const n of names) {
        ws.embed(n, { onProgress: (p) => setIndexStatus(`embedding ${n} ${p.done}/${p.total}`) })
          .then((c) => c && setIndexStatus(`${total.toLocaleString()} notes`))
          .catch((e) => setIndexStatus(`keyword-only (${errorMessage(e).slice(0, 30)})`));
      }
    })();
    return () => {
      cancelled = true;
      void watcher?.stop();
    };
  }, [ws]);

  // Warn early if the active model can't authenticate (e.g. the template's default profile).
  useEffect(() => {
    (async () => {
      const name = agent.profileName ?? ws.config.defaultProfile;
      const prof = name ? ws.config.profiles[name] : undefined;
      const prov = prof ? ws.config.providers[prof.provider] : undefined;
      if (!prof || !prov) {
        notify({ kind: "error", text: "No model is set up yet. Quit (Ctrl-C twice) and run: recall setup" });
        return;
      }
      const st = await credentialStatus(prov);
      if (!st.ok) {
        notify({ kind: "error", text: `Model "${name}" (${prof.provider}/${prof.model}) isn't set up: ${st.reason}. Run \`recall setup\`, or /model to switch.` });
      }
    })();
  }, []);

  // Show resumed transcript.
  useEffect(() => {
    if (!resume) return;
    for (const m of resume.messages) {
      if (m.role === "user" && typeof m.content === "string") push({ kind: "user", text: m.content.split("\n\n<attached_note")[0]! });
      if (m.role === "assistant") {
        const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
        if (text.trim()) push({ kind: "seg", seg: { type: "text", text } });
      }
    }
  }, []);

  const flushLive = useCallback(() => {
    setLive((segs) => {
      const done = segs.filter((s) => s.type === "text" || s.done);
      if (done.length) push(...done.map((seg) => ({ kind: "seg" as const, seg })));
      return segs.filter((s) => !(s.type === "text" || s.done));
    });
  }, [push]);

  const send = useCallback(
    async (raw: string, display?: string) => {
      const names = activeVaults ?? ws.vaultNames();
      const { prompt, attached } = expandMentions(raw, ws, names);
      push({ kind: "user", text: display ?? raw });
      setScroll(0);
      if (attached.length) notify({ kind: "info", text: `attached ${attached.join(", ")}` });
      setBusy(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const r = await agent.send(
          prompt,
          {
            onTextDelta: (t) =>
              setLive((segs) => {
                const last = segs[segs.length - 1];
                if (last?.type === "text") return [...segs.slice(0, -1), { type: "text", text: last.text + t }];
                return [...segs, { type: "text", text: t }];
              }),
            onToolCall: (c) => setLive((segs) => [...segs, { type: "tool", id: c.id, name: c.name, input: c.input, done: false }]),
            onToolResult: (res) =>
              setLive((segs) =>
                segs.map((s) =>
                  s.type === "tool" && s.id === res.id
                    ? { ...s, done: true, error: !!res.error, result: describeToolResult(res.name, res.error ? { error: res.error } : res.output) }
                    : s,
                ),
              ),
            onStepFinish: flushLive,
          },
          ac.signal,
        );
        flushLive();
        if (r.aborted) notify({ kind: "info", text: "interrupted" });
        if (r.error) notify({ kind: "error", text: r.error });
        setUsage({ ...agent.totalUsage });
        saveSession(sessionId.current, agent.messages, agent.profileName);
      } catch (e) {
        flushLive();
        notify({ kind: "error", text: errorMessage(e) });
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [agent, activeVaults, ws],
  );

  const onSubmit = useCallback(
    async (value: string) => {
      if (value.endsWith("\\")) return setInput(value.slice(0, -1) + "\n");
      const text = value.trim();
      setInput("");
      setSuggestions([]);
      if (!text) return;
      history.current.unshift(text);
      historyPos.current = -1;
      if (text.startsWith("/")) {
        push({ kind: "user", text });
        await handleSlash(text, {
          ws,
          agent,
          sessionId: sessionId.current,
          activeVaults,
          setActiveVaults,
          modeOverride,
          setModeOverride,
          notify,
          clearTranscript: () => {
            agent.clear();
            sessionId.current = newSessionId();
            ctx.sessionId = sessionId.current;
            if (!fullscreen) console.clear();
            setScroll(0);
            setItems([item({ kind: "banner" })]);
          },
          submitPrompt: (p, d) => void send(p, d),
          resume: (id, messages) => {
            sessionId.current = id;
            ctx.sessionId = id;
            agent.messages = messages;
          },
          reindex: async () => {
            for (const n of ws.vaultNames()) {
              const s = ws.sync(n);
              notify({ kind: "info", text: `${n}: ${s.added} added, ${s.updated} updated, ${s.removed} removed` });
              ws.embed(n, { onProgress: (p) => setIndexStatus(`embedding ${n} ${p.done}/${p.total}`) })
                .then(() => setIndexStatus("index up to date"))
                .catch((e) => setIndexStatus(`keyword-only (${errorMessage(e).slice(0, 30)})`));
            }
          },
          exit,
        });
        setTick((t) => t + 1);
        return;
      }
      if (ws.vaultNames().length === 0) {
        notify({ kind: "error", text: "Add a vault first: /vault add ~/path/to/vault" });
        return;
      }
      await send(text);
    },
    [send, activeVaults, modeOverride, agent, ws],
  );

  // @-mention suggestions
  useEffect(() => {
    const m = /@(?:\[\[)?([^\]@]*)$/.exec(input);
    if (!m || busy) return setSuggestions([]);
    const q = m[1]!.toLowerCase();
    const out: string[] = [];
    for (const n of activeVaults ?? ws.vaultNames()) {
      try {
        const rows = ws
          .get(n)
          .db.query("SELECT name FROM notes WHERE name LIKE ? ORDER BY length(name), mtime DESC LIMIT 5")
          .all(`%${q}%`) as { name: string }[];
        out.push(...rows.map((r) => r.name));
      } catch {}
    }
    setSuggestions([...new Set(out)].slice(0, 5));
  }, [input, busy]);

  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "c") {
        if (busy && abortRef.current) return abortRef.current.abort();
        if (Date.now() - lastCtrlC.current < 1500) return exit();
        lastCtrlC.current = Date.now();
        notify({ kind: "info", text: "Press Ctrl-C again to exit" });
        return;
      }
      if (key.escape && busy) return abortRef.current?.abort();
      if (fullscreen && !pending && (key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow)))) {
        const step = key.pageUp || key.pageDown ? Math.max(1, Math.floor(rows / 2)) : 1;
        const up = key.pageUp || key.upArrow;
        setScroll((s) => Math.min(maxScroll(), Math.max(0, s + (up ? step : -step))));
        return;
      }
      if (busy || pending) return;
      if (key.tab && suggestions.length) {
        setInput((v) => v.replace(/@(?:\[\[)?([^\]@]*)$/, `@[[${suggestions[0]}]] `));
        return;
      }
      if (key.upArrow && history.current.length) {
        historyPos.current = Math.min(historyPos.current + 1, history.current.length - 1);
        setInput(history.current[historyPos.current]!);
      }
      if (key.downArrow) {
        historyPos.current = Math.max(historyPos.current - 1, -1);
        setInput(historyPos.current < 0 ? "" : history.current[historyPos.current]!);
      }
    },
  );

  const names = activeVaults ?? ws.vaultNames();
  const modes = [...new Set(names.map((n) => effectiveMode(ws.get(n).vault.config, "tui", { override: modeOverride })))];
  const profileLabel = (() => {
    const p = ws.config.profiles[agent.profileName ?? ws.config.defaultProfile ?? ""];
    return p ? `${agent.profileName ?? ws.config.defaultProfile} · ${p.model}` : "no model";
  })();

  const liveView = (
    <>
      {live.map((seg, i) =>
        seg.type === "text" ? (
          <Box key={`l${i}`} marginTop={1}>
            <Markdown text={seg.text} />
          </Box>
        ) : (
          <ToolLine key={seg.id} seg={seg} paused={!!pending} />
        ),
      )}
      {busy && !pending && live.length === 0 && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color="cyan">
            <Spinner type="dots" />
          </Text>
          <Text color="gray"> thinking… (esc to interrupt)</Text>
        </Box>
      )}
    </>
  );

  const inputView = pending ? (
    <Box marginTop={1}>
      <DiffReview cs={pending.cs} onDecide={pending.resolve} rows={rows} />
    </Box>
  ) : (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Box borderStyle="round" borderColor={busy ? "gray" : "magenta"} paddingX={1}>
        <Text color="magenta">› </Text>
        {busy ? (
          <Text color="gray">{input || "…"}</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="Ask about your notes, or /help" />
        )}
      </Box>
      {suggestions.length > 0 && (
        <Box paddingLeft={3}>
          <Text color="gray">
            tab → <Text color="cyan">[[{suggestions[0]}]]</Text>
            {suggestions.length > 1 && `   ${suggestions.slice(1).join(" · ")}`}
          </Text>
        </Box>
      )}
    </Box>
  );

  const statusView = (
    <Box paddingX={1} justifyContent="space-between" flexShrink={0}>
      <Text color="gray" wrap="truncate">
        {names.length ? names.join(", ") : "no vaults"} · <Text color={modes.includes("auto") ? "yellow" : modes.includes("ask") ? "cyan" : "green"}>{modes.join("/") || "–"}</Text>
        {modeOverride ? <Text color="yellow"> (session)</Text> : null}
      </Text>
      <Text color="gray" wrap="truncate">
        {indexStatus} · {profileLabel}
        {usage.input + usage.output > 0 ? ` · ${(usage.input / 1000).toFixed(1)}k↑ ${(usage.output / 1000).toFixed(1)}k↓` : ""}
      </Text>
    </Box>
  );

  if (fullscreen) {
    // The transcript is bottom-anchored and clipped; scrolling pushes it down past the bottom edge.
    return (
      <Box flexDirection="column" height={rows} width={columns}>
        <Box ref={viewRef} flexDirection="column" flexGrow={1} flexShrink={1} justifyContent="flex-end" overflow="hidden" paddingX={1}>
          <Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-scroll}>
            {items.slice(-MAX_FULLSCREEN_ITEMS).map((it) => renderItem(it, ws))}
            {liveView}
          </Box>
        </Box>
        {scroll > 0 && (
          <Box paddingX={1} flexShrink={0}>
            <Text color="yellow">↑ scrolled {scroll} lines · PgDn / Shift-↓ to return</Text>
          </Box>
        )}
        {inputView}
        {statusView}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Static items={items}>{(it) => renderItem(it, ws)}</Static>
      {liveView}
      {inputView}
      {statusView}
    </Box>
  );
}
