import React from "react";
import { Box, Text } from "ink";

/** Inline markdown: **bold**, *italic*, `code`, [[wikilinks]], [links](url), #tags. */
export function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)]+\)|(?<![\w*])\*[^*\s][^*]*\*(?!\w)|(?<=^|\s)#[\p{L}\p{N}_\/-]*\p{L}[\p{L}\p{N}_\/-]*)/gu;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) parts.push(<Text key={k++} bold>{t.slice(2, -2)}</Text>);
    else if (t.startsWith("`")) parts.push(<Text key={k++} color="yellow">{t.slice(1, -1)}</Text>);
    else if (t.startsWith("[[")) parts.push(<Text key={k++} color="cyan">{t}</Text>);
    else if (t.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      parts.push(<Text key={k++} color="blue" underline>{mm[1]}</Text>);
    } else if (t.startsWith("#")) parts.push(<Text key={k++} color="magenta">{t}</Text>);
    else parts.push(<Text key={k++} italic>{t.slice(1, -1)}</Text>);
    last = m.index! + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text>{parts}</Text>;
}

/** Block-level markdown good enough for chat answers. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let inCode = false;
  let code: string[] = [];
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      if (inCode) {
        out.push(
          <Box key={i} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
            {code.map((c, j) => (
              <Text key={j} color="yellow">{c || " "}</Text>
            ))}
          </Box>,
        );
        code = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) return void code.push(line);
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(
        <Text key={i} bold color={h[1]!.length <= 2 ? "green" : undefined} underline={h[1]!.length === 1}>
          {h[2]}
        </Text>,
      );
      return;
    }
    const li = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (li) {
      const bullet = /\d/.test(li[2]!) ? li[2] : "•";
      const box = li[3] ? (/x/i.test(li[3]) ? "☑ " : "☐ ") : "";
      out.push(
        <Box key={i} paddingLeft={li[1]!.length}>
          <Text color="gray">{bullet} </Text>
          <Text>
            {box}
            <Inline text={li[4]!} />
          </Text>
        </Box>,
      );
      return;
    }
    if (/^>\s?/.test(line)) {
      out.push(
        <Text key={i} color="gray">
          │ <Inline text={line.replace(/^>\s?/, "")} />
        </Text>,
      );
      return;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return void out.push(<Text key={i} color="gray">{"─".repeat(30)}</Text>);
    out.push(<Inline key={i} text={line || " "} />);
  });
  if (inCode && code.length) {
    out.push(
      <Box key="open-code" borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {code.map((c, j) => (
          <Text key={j} color="yellow">{c || " "}</Text>
        ))}
      </Box>,
    );
  }
  return <Box flexDirection="column">{out}</Box>;
}

export function DiffView({ diff, maxLines }: { diff: string; maxLines?: number }) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("===") && !/^Index:/.test(l));
  const shown = maxLines && lines.length > maxLines ? lines.slice(0, maxLines) : lines;
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => {
        if (l.startsWith("+++") || l.startsWith("---")) return <Text key={i} bold>{l}</Text>;
        if (l.startsWith("+")) return <Text key={i} color="green">{l}</Text>;
        if (l.startsWith("-")) return <Text key={i} color="red">{l}</Text>;
        if (l.startsWith("@@")) return <Text key={i} color="cyan">{l}</Text>;
        if (l.startsWith("\\")) return null;
        return <Text key={i} color="gray">{l || " "}</Text>;
      })}
      {shown.length < lines.length && (
        <Text color="yellow">… {lines.length - shown.length} more lines (press d for the full diff)</Text>
      )}
    </Box>
  );
}
