import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNote, maskNonContent } from "../src/parse/note.ts";
import { chunkNote } from "../src/parse/chunk.ts";
import { formatMomentDate } from "../src/vault/obsidian.ts";
import { FIXTURE_VAULT } from "./helpers.ts";

const alpha = readFileSync(join(FIXTURE_VAULT, "Projects/Alpha/Alpha Plan.md"), "utf8");

describe("parseNote", () => {
  const note = parseNote(alpha);

  test("frontmatter, aliases and tags (frontmatter + inline, nested, lowercased)", () => {
    expect(note.frontmatter.status).toBe("active");
    expect(note.aliases).toEqual(["Alpha"]);
    expect(note.tags).toEqual(["milestone", "project", "project/alpha"]);
  });

  test("wikilinks with subpath and alias; embeds", () => {
    const targets = note.links.map((l) => [l.target, l.subpath, l.alias, l.embed]);
    expect(targets).toEqual([
      ["Auth Redesign", undefined, undefined, false],
      ["Meeting Notes", "Decisions", "the decisions", false],
      ["diagram.png", undefined, undefined, true],
    ]);
  });

  test("ignores links/tags in code fences, inline code and %% comments %%", () => {
    const all = note.links.map((l) => l.target).join(",");
    expect(all).not.toContain("Not A Link");
    expect(all).not.toContain("Also Not");
    expect(all).not.toContain("code link");
    expect(all).not.toContain("Hidden Comment Link");
    expect(note.tags).not.toContain("notatag");
  });

  test("link offsets point at the original text", () => {
    for (const l of note.links) expect(alpha.slice(l.start, l.end)).toMatch(/^!?\[\[.*\]\]$/);
    const line = alpha.split("\n")[note.links[0]!.line]!;
    expect(line).toContain("[[Auth Redesign]]");
  });

  test("headings with file line numbers", () => {
    expect(note.headings.map((h) => [h.level, h.text])).toEqual([
      [1, "Alpha Plan"],
      [2, "Goals"],
      [2, "Risks"],
    ]);
    expect(alpha.split("\n")[note.headings[1]!.line]).toBe("## Goals");
  });

  test("numeric-only hashtags are not tags; markdown links are captured and decoded", () => {
    const n = parseNote(readFileSync(join(FIXTURE_VAULT, "Meeting Notes.md"), "utf8"));
    expect(n.tags).toEqual(["decision"]);
    const auth = parseNote(readFileSync(join(FIXTURE_VAULT, "Areas/Auth Redesign.md"), "utf8"));
    expect(auth.links.find((l) => l.kind === "markdown")?.target).toBe("../Meeting Notes");
    expect(auth.tags).toEqual(["security"]);
  });

  test("masking preserves length and newlines", () => {
    const m = maskNonContent(alpha);
    expect(m.length).toBe(alpha.length);
    expect(m.split("\n").length).toBe(alpha.split("\n").length);
  });

  test("malformed frontmatter doesn't throw", () => {
    const n = parseNote("---\nfoo: [unclosed\n---\nbody #tag\n");
    expect(n.frontmatterError).toBeDefined();
    expect(n.tags).toEqual(["tag"]);
  });
});

describe("chunkNote", () => {
  test("splits by headings with breadcrumb paths and correct line ranges", () => {
    const note = parseNote(alpha);
    const chunks = chunkNote(alpha, note, { minChars: 0 });
    expect(chunks.map((c) => c.headingPath)).toEqual(["Alpha Plan", "Alpha Plan > Goals", "Alpha Plan > Risks"]);
    const lines = alpha.split("\n");
    for (const c of chunks) {
      expect(lines.slice(c.startLine, c.endLine + 1).join("\n")).toBe(c.text);
    }
  });

  test("long sections split without breaking code fences", () => {
    const code = "```\n" + Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n") + "\n```";
    const text = `# Big\n\n${"word ".repeat(250)}\n\n${code}\n\n${"tail ".repeat(250)}`;
    const chunks = chunkNote(text, parseNote(text), { maxChars: 600 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((c) => c.text.startsWith("```") && c.text.endsWith("```"))).toBe(true);
  });
});

test("formatMomentDate", () => {
  const d = new Date(2026, 10, 4, 9, 5);
  expect(formatMomentDate(d, "YYYY-MM-DD")).toBe("2026-11-04");
  expect(formatMomentDate(d, "dddd, MMMM D YYYY")).toBe("Wednesday, November 4 2026");
  expect(formatMomentDate(d, "[Week] YYYY/MM")).toBe("Week 2026/11");
});
