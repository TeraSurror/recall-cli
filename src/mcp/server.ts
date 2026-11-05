import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Workspace } from "../workspace.ts";
import { ALL_TOOLS, invokeTool } from "../tools/registry.ts";
import type { ToolContext } from "../tools/context.ts";
import { newSessionId } from "../agent/sessions.ts";
import { effectiveMode } from "../agent/approval.ts";
import { RecallError } from "../util/errors.ts";
import pkg from "../../package.json" with { type: "json" };

export interface McpOptions {
  vaults?: string[];
  allowWrites?: boolean;
}

/**
 * Expose the vault tool registry over MCP so external agents (Claude Code, Claude Desktop,
 * Cursor, …) can search and — if permitted — edit notes. Write tools are only listed when
 * at least one exposed vault is writable on the MCP surface.
 */
export function createMcpServer(ws: Workspace, opts: McpOptions = {}): McpServer {
  const ctx: ToolContext = {
    ws,
    surface: "mcp",
    policy: { allowWrites: opts.allowWrites },
    sessionId: `mcp-${newSessionId()}`,
    allowedVaults: opts.vaults?.length ? opts.vaults : undefined,
  };
  for (const name of ctx.allowedVaults ?? []) {
    if (!ws.vaultNames().includes(name)) {
      throw new RecallError(`--vault ${name}: no such vault. Registered: ${ws.vaultNames().join(", ") || "(none)"}`);
    }
  }
  const exposed = ctx.allowedVaults ?? ws.vaultNames();
  // MCP has no human in the loop, so only "auto" (configured, or "ask" + --allow-writes) can write.
  const anyWritable = exposed.some((n) => effectiveMode(ws.get(n).vault.config, "mcp", ctx.policy) === "auto");

  const server = new McpServer(
    { name: "recall", version: pkg.version },
    {
      instructions:
        `Recall gives you access to the user's Obsidian vaults (${exposed.join(", ")}). ` +
        "Search before answering, read notes before editing, cite notes as [[wikilinks]], and prefer small targeted edits. " +
        (anyWritable ? "Writes are journaled and can be undone by the user with `recall undo`." : "All vaults are read-only for this connection."),
    },
  );

  for (const t of ALL_TOOLS) {
    if (t.kind === "write" && !anyWritable) continue;
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.input as z.ZodObject,
        annotations: {
          readOnlyHint: t.kind === "read",
          destructiveHint: t.name === "delete_note" || t.name === "move_note",
          idempotentHint: t.kind === "read",
          openWorldHint: false,
        },
      },
      async (args: unknown) => {
        const r = await invokeTool(t, args, ctx);
        if (!r.ok) return { content: [{ type: "text" as const, text: r.error }], isError: true };
        const text = typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 1);
        return { content: [{ type: "text" as const, text }] };
      },
    );
  }
  return server;
}

export async function serveMcp(ws: Workspace, opts: McpOptions = {}, transport: Transport = new StdioServerTransport()) {
  const server = createMcpServer(ws, opts);
  await server.connect(transport);
  return server;
}
