import type { SearchResult } from "../vector/store.ts";

export interface ContextChunk {
  title: string;
  path: string;
  heading: string | null;
  content: string;
  score: number;
}

export interface AssembledContext {
  chunks: ContextChunk[];
  totalTokens: number;
  sources: string[];
}

export function assembleContext(
  results: SearchResult[],
  maxTokens: number = 4000
): AssembledContext {
  const chunks: ContextChunk[] = [];
  let estimatedTokens = 0;
  const sources = new Set<string>();

  for (const result of results) {
    const chunkTokens = estimateTokens(result.content);

    if (estimatedTokens + chunkTokens > maxTokens) {
      break;
    }

    chunks.push({
      title: result.title,
      path: result.path,
      heading: result.heading,
      content: result.content,
      score: result.score,
    });

    estimatedTokens += chunkTokens;
    sources.add(result.path);
  }

  return {
    chunks,
    totalTokens: estimatedTokens,
    sources: Array.from(sources),
  };
}

export function formatContextForPrompt(context: AssembledContext): string {
  if (context.chunks.length === 0) {
    return "No relevant notes found.";
  }

  const sections = context.chunks.map((chunk, index) => {
    const header = chunk.heading
      ? `[${chunk.title} > ${chunk.heading}]`
      : `[${chunk.title}]`;

    return `--- Note ${index + 1}: ${header} ---
${chunk.content}`;
  });

  return sections.join("\n\n");
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildSystemPrompt(context: AssembledContext): string {
  const contextText = formatContextForPrompt(context);

  return `You are a helpful assistant with access to the user's personal notes from their Obsidian vault. Use the following context from their notes to answer questions accurately and helpfully.

CONTEXT FROM NOTES:
${contextText}

INSTRUCTIONS:
- Answer based on the provided notes when relevant
- If the notes don't contain relevant information, say so and provide general knowledge if appropriate
- Reference specific notes by title when citing information
- Be concise but thorough
- If asked to summarize, focus on key points and themes`;
}
