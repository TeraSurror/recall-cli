import matter from "gray-matter";
import { readFileSync } from "fs";

export interface DocumentMetadata {
  title: string;
  tags: string[];
  aliases: string[];
  created?: Date;
  modified?: Date;
  frontmatter: Record<string, unknown>;
}

export interface ParsedDocument {
  content: string;
  metadata: DocumentMetadata;
  wikiLinks: string[];
}

export function parseDocument(filePath: string): ParsedDocument {
  const fileContent = readFileSync(filePath, "utf-8");
  const { data: frontmatter, content } = matter(fileContent);

  const metadata = extractMetadata(filePath, frontmatter);
  const wikiLinks = extractWikiLinks(content);

  return {
    content,
    metadata,
    wikiLinks,
  };
}

function extractMetadata(
  filePath: string,
  frontmatter: Record<string, unknown>
): DocumentMetadata {
  const fileName = filePath.split("/").pop()?.replace(/\.md$/, "") || "";

  const tags = normalizeTags(frontmatter.tags);
  const aliases = normalizeAliases(frontmatter.aliases);

  return {
    title: (frontmatter.title as string) || fileName,
    tags,
    aliases,
    created: parseDate(frontmatter.created || frontmatter.date),
    modified: parseDate(frontmatter.modified || frontmatter.updated),
    frontmatter,
  };
}

function normalizeTags(tags: unknown): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map(String);
  if (typeof tags === "string") return tags.split(/[,\s]+/).filter(Boolean);
  return [];
}

function normalizeAliases(aliases: unknown): string[] {
  if (!aliases) return [];
  if (Array.isArray(aliases)) return aliases.map(String);
  if (typeof aliases === "string") return [aliases];
  return [];
}

function parseDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function extractWikiLinks(content: string): string[] {
  const wikiLinkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
  const links: string[] = [];
  let match;

  while ((match = wikiLinkRegex.exec(content)) !== null) {
    if (match[1]) {
      links.push(match[1].trim());
    }
  }

  return [...new Set(links)];
}
