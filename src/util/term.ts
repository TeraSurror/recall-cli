const enabled = (stream: NodeJS.WriteStream) => stream.isTTY && !process.env.NO_COLOR;

function wrap(open: number, close: number) {
  return (s: string, stream: NodeJS.WriteStream = process.stdout) =>
    enabled(stream) ? `\x1b[${open}m${s}\x1b[${close}m` : s;
}

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
};

export function table(rows: string[][], gap = 2): string {
  const widths: number[] = [];
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  for (const r of rows) r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell))));
  return rows
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell + " ".repeat(widths[i]! - visible(cell) + gap))).join(""))
    .join("\n");
}

export function colorDiff(diff: string, stream: NodeJS.WriteStream = process.stdout): string {
  return diff
    .split("\n")
    .map((l) =>
      l.startsWith("+++") || l.startsWith("---") ? c.bold(l, stream)
      : l.startsWith("+") ? c.green(l, stream)
      : l.startsWith("-") ? c.red(l, stream)
      : l.startsWith("@@") ? c.cyan(l, stream)
      : l,
    )
    .join("\n");
}

export function relTime(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** One-line summary of a tool call for logs and the TUI. */
export function describeToolCall(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const q = (v: unknown) => (typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 57)}…` : v) : "");
  switch (name) {
    case "search":
      return `search ${q(i.query)}${i.vault ? ` in ${i.vault}` : ""}`;
    case "read_note":
    case "get_links":
    case "edit_note":
    case "set_frontmatter":
    case "delete_note":
      return `${name} ${q(i.note)}${i.heading ? ` #${i.heading}` : ""}`;
    case "append_to_note":
      return `append_to_note ${i.daily ? "(daily)" : q(i.note)}${i.heading ? ` under ${q(i.heading)}` : ""}`;
    case "create_note":
      return `create_note ${q(i.path)}`;
    case "move_note":
      return `move_note ${q(i.note)} → ${q(i.newPath)}`;
    case "list_notes":
      return `list_notes${i.folder ? ` ${q(i.folder)}` : ""}${i.tag ? ` #${i.tag}` : ""}`;
    case "query_frontmatter":
      return `query_frontmatter ${String(i.key)}${i.value !== undefined ? `=${String(i.value)}` : ""}`;
    default:
      return name;
  }
}

/** Short summary of a tool result. */
export function describeToolResult(name: string, output: unknown): string {
  const o = (output ?? {}) as Record<string, any>;
  if (o.error) return String(o.error);
  if (o.status === "applied") return `✓ ${o.diffStat}`;
  if (o.status === "rejected") return `✗ ${o.feedback ? `rejected: ${o.feedback}` : o.reason}`;
  switch (name) {
    case "search":
      return `${o.results?.length ?? 0} hits`;
    case "read_note":
      return `${o.path} (${(o.content?.length ?? 0).toLocaleString()} chars)`;
    case "list_notes":
      return `${o.notes?.length ?? 0} notes`;
    case "get_links":
      return `${o.backlinks?.length ?? 0} backlinks, ${o.outlinks?.length ?? 0} outlinks`;
    case "vault_health":
      return `${o.orphans?.count ?? 0} orphans, ${o.brokenLinks?.count ?? 0} broken links`;
    case "query_frontmatter":
      return `${o.count ?? 0} notes`;
    case "list_vaults":
      return `${Array.isArray(output) ? output.length : 0} vaults`;
    case "list_tags":
      return `${o.tags?.length ?? 0} tags`;
    case "get_daily_note":
      return o.exists ? o.path : `${o.path} (doesn't exist yet)`;
    default:
      return "done";
  }
}
