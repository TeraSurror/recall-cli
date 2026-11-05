# Recall

An agentic terminal hub for **all your Obsidian vaults**. Chat with your notes, search them by meaning, and let an LLM maintain them (tag, link, rename, file, summarize) with every change shown as a diff you approve and can undo.

Bring any model: **local** (Ollama, LM Studio, llama.cpp, vLLM), **hosted** (OpenRouter, Groq, any OpenAI-compatible API) or **proprietary** (Anthropic, OpenAI, Google). The same vault tools are also exposed over **MCP**, so Claude Code, Claude Desktop, Cursor and others can use your vaults too.

```
╭──────────────────────────────────────────────────────────────╮
│ › what did I decide about the auth redesign?                  │
╰──────────────────────────────────────────────────────────────╯
  ⌕ search "auth redesign decision" · 6 hits
  ⌕ read_note "Auth Redesign" · Areas/Auth Redesign.md (2,140 chars)

You chose WebAuthn passkeys with a password fallback ([[Auth Redesign]]),
confirmed in the 3 Nov sync ([[Meeting Notes#Decisions]]). Open question:
vendor lock-in, flagged as the main risk in [[Alpha Plan]].

 work, personal · ask                       4,812 notes · sonnet · claude-sonnet-5-5
```

## Install

Requires [Bun](https://bun.sh) ≥ 1.3.

```bash
git clone https://github.com/TeraSurror/recall-cli && cd recall-cli
bun install
bun link            # puts `recall` on your PATH
# or build a standalone binary:
bun run build       # → dist/recall
```

## Quick start

```bash
recall setup                             # pick a provider + model interactively, store the key
recall vault add ~/Notes/Work --name work
recall vault add ~/Notes/Personal --name personal
recall                                   # open the TUI
```

`recall setup` walks you through choosing a provider (OpenRouter, Anthropic, OpenAI, Google, Ollama, LM Studio, Groq or any OpenAI-compatible API). It stores the API key in your OS keychain (or reads an env var), **fetches the provider's model list** so you can search and pick (showing which models support tool calling), and sends a test request. It also sets up embeddings and offers to remove profiles that can't work yet.

Until you run it, the config template includes an Anthropic `sonnet` profile (it needs `ANTHROPIC_API_KEY`) and Ollama's `nomic-embed-text` for embeddings. Without embeddings Recall still works, using keyword search only.

## Vaults

Vaults are **only ever added explicitly**. Nothing is indexed until you register it. There are three equivalent ways:

| | |
|---|---|
| CLI | `recall vault add <path> [--name n] [--mode ask] [--mcp-mode read-only] [--exclude 'Archive/**']` · `vault list` · `vault set` · `vault remove` · `vault default` |
| TUI | `/vault add <path>` · `/vault remove <name>` · `/vault use work personal` (limit the session) |
| Config | edit `~/.config/recall/config.jsonc` by hand (comments survive CLI edits) |

```jsonc
"vaults": {
  "work": {
    "path": "~/Notes/Work",
    "mode": "ask",           // TUI: read-only | ask | auto
    "mcpMode": "read-only",  // MCP + headless (`recall ask`, `recall run`)
    "exclude": ["Archive/**", "Templates/**"],
    "embeddings": true
  }
}
```

`recall vault discover` reads Obsidian's own vault list and offers each one. Nothing is added unless you say yes. Removing a vault deletes Recall's index for it and never touches your notes.

## Write safety

Every write the agent makes (create, edit, append, set properties, move, delete) goes through one gate:

- **`read-only`**: refused. The agent is told to describe the change instead. A vault configured read-only can't be overridden by any flag or session setting.
- **`ask`** (TUI default): you see a colored diff. Press `y` to apply, `n` to reject, `f` to reject with feedback the agent will act on, or `A` to approve everything for the rest of the session. Enter and other keys never approve.
- **`auto`**: applied straight away.

Edits are exact find/replace (never blind rewrites). They're refused if the file changed on disk after the agent read it. Each one is journaled, so `/undo` or `recall undo` reverts it, and `recall history --diff` shows what changed. Deletes go to the vault's `.trash/`. `move_note` updates every `[[wikilink]]` and markdown link, as Obsidian does.

On surfaces with nobody to ask (MCP, `recall ask`, `recall run`), `ask` acts like read-only unless you pass `--allow-writes`. That flag only upgrades `ask` vaults, never `read-only` ones.

## Models

The easiest way is `recall setup`. To script it instead:

```bash
recall model list
recall model remove sonnet                     # drop a profile (remove-provider drops a provider)
recall model provider lmstudio --type openai-compatible --base-url http://localhost:1234/v1
recall model add local --provider lmstudio --model qwen3-14b
recall model add sonnet --provider anthropic --model claude-sonnet-5-5 --default
recall model embeddings ollama nomic-embed-text      # or: --off
recall model provider openrouter --type openai-compatible --base-url https://openrouter.ai/api/v1
recall model key set openrouter --provider openrouter # stores the key in the OS keychain
```

Provider types: `anthropic`, `openai`, `google`, `ollama`, `openai-compatible`. API keys can be `env:VAR`, `keychain:name`, or omitted to use the provider's standard env var. For small local models that can't call tools, set `"tools": false` on the profile. Recall then retrieves the relevant excerpts itself and the model answers from those.

Switch models mid-conversation with `/model <profile>`.

## Ways to use it

**Interactive (TUI)**: run `recall`.
- Ask across vaults: *"What have I written about pricing experiments this year?"*
- Maintenance: *"Find orphan notes in Research and suggest links"*, *"Merge #ml into #machine-learning"*, *"Rename Projects/foo to Projects/Atlas and fix links"*
- Capture: *"Add to today's daily note under Log: shipped v2"*. Recall knows your daily-note folder, format and template from `.obsidian/`.
- Attach notes with `@[[Note Name]]` (Tab completes). Esc interrupts. `/help` lists everything.

**Headless**: for scripts and pipes:
```bash
recall ask "what's due this week?" --vault work
pbpaste | recall ask --vault work "file this into the right project note" --allow-writes
recall ask --json "list open questions in #project/atlas" | jq .text
```

**Recipes**: saved prompts as markdown files in `~/.config/recall/recipes/` or `<vault>/.recall/recipes/`:
```markdown
---
description: Weekly review
vault: personal
mode: ask        # recipes can only restrict permissions, never grant them
---
Today is {{date}}. Summarize my daily notes from the last 7 days into Reviews/Week of {{date}}.md …
```
Run `recall run weekly-review` (from cron, for example), `recall run --list`, or `/run weekly-review` in the TUI. Placeholders: `{{date}}`, `{{date:FORMAT}}`, `{{args}}`, `{{1}}`… See [`examples/recipes`](examples/recipes).

**MCP**: give other agents access to your vaults:
```bash
claude mcp add recall -- recall mcp                         # Claude Code
claude mcp add recall -- recall mcp --vault work --allow-writes
```
Claude Desktop / Cursor (`mcpServers` config):
```json
{ "recall": { "command": "recall", "args": ["mcp", "--vault", "work"] } }
```
Write tools are only offered when a vault is actually writable over MCP.

**Background indexing**: the TUI and `recall mcp` watch your vaults while they run. For an always-fresh index, run `recall daemon`. Other commands rescan incrementally on start (milliseconds for thousands of notes).

## Per-vault instructions

Put conventions in `<vault>/.recall/instructions.md` (folder layout, tag taxonomy, writing style, "never delete, archive instead"). Recall includes it in the agent's instructions for that vault. See [`examples/instructions.md`](examples/instructions.md).

## Tools the agent has

`list_vaults` · `search` (hybrid semantic + keyword; filter by tags, folder, recency) · `read_note` (whole note or one section) · `list_notes` · `get_links` (backlinks/outlinks) · `vault_health` (orphans, broken links) · `list_tags` · `query_frontmatter` · `get_daily_note` · `create_note` · `edit_note` · `append_to_note` · `set_frontmatter` · `move_note` · `delete_note`

## How it works

- **Index**: one SQLite DB per vault (`~/.local/share/recall/index/<vault>.db`, WAL). It holds notes, tags, resolved links, and heading-aware chunks with FTS5 (porter stemming) plus normalized embedding vectors. Search merges keyword and vector rankings with reciprocal-rank fusion. Re-indexing is incremental on mtime and content hash, and unchanged chunks keep their embeddings.
- **Parsing**: frontmatter, aliases, nested tags, `[[links|aliases]]`, `![[embeds]]`, and markdown links. Code blocks, inline code, `%% comments %%` and math are ignored, as in Obsidian. Links resolve the way Obsidian resolves them (shortest path, same folder first).
- **Agent**: [Vercel AI SDK](https://ai-sdk.dev) tool loop. A single zod-typed tool registry drives the TUI agent, headless mode and the MCP server.
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) (React for the terminal).

## Files

| | |
|---|---|
| `~/.config/recall/config.jsonc` | config (`recall config path`, `recall config edit`, `recall config schema`) |
| `~/.config/recall/recipes/` | global recipes |
| `~/.local/share/recall/index/` | search indexes (safe to delete; `recall index --rebuild`) |
| `~/.local/share/recall/snapshots/journal/` | change journal for undo |
| `~/.local/share/recall/sessions.db` | chat history (`recall sessions`, `recall --resume [id]`) |

`RECALL_CONFIG_DIR` and `RECALL_DATA_DIR` override these locations, as do `XDG_CONFIG_HOME` and `XDG_DATA_HOME`.

## Development

```bash
bun test            # parser, indexer, search, tools, permissions, agent loop (mock model), MCP, watcher
bun run typecheck
bun run dev         # watch mode
```

## License

MIT
