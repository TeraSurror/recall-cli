export interface Chunk {
  content: string;
  index: number;
  startLine: number;
  endLine: number;
  heading?: string;
}

export interface ChunkerOptions {
  maxChunkSize: number;
  minChunkSize: number;
  overlapSize: number;
}

const defaultOptions: ChunkerOptions = {
  maxChunkSize: 1000,
  minChunkSize: 100,
  overlapSize: 100,
};

export function chunkDocument(
  content: string,
  options: Partial<ChunkerOptions> = {}
): Chunk[] {
  const opts = { ...defaultOptions, ...options };
  const lines = content.split("\n");
  const sections = splitBySections(lines);
  const chunks: Chunk[] = [];

  let chunkIndex = 0;

  for (const section of sections) {
    const sectionChunks = chunkSection(section, opts, chunkIndex);
    chunks.push(...sectionChunks);
    chunkIndex += sectionChunks.length;
  }

  return chunks;
}

interface Section {
  heading?: string;
  content: string;
  startLine: number;
  endLine: number;
}

function splitBySections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let currentHeading: string | undefined;
  let currentContent: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || "";
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      if (currentContent.length > 0) {
        sections.push({
          heading: currentHeading,
          content: currentContent.join("\n"),
          startLine,
          endLine: i - 1,
        });
      }
      currentHeading = headingMatch[2];
      currentContent = [];
      startLine = i;
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      content: currentContent.join("\n"),
      startLine,
      endLine: lines.length - 1,
    });
  }

  return sections;
}

function chunkSection(
  section: Section,
  options: ChunkerOptions,
  startIndex: number
): Chunk[] {
  const { maxChunkSize, minChunkSize, overlapSize } = options;
  const content = section.content.trim();

  if (content.length === 0) {
    return [];
  }

  if (content.length <= maxChunkSize) {
    return [
      {
        content: formatChunk(content, section.heading),
        index: startIndex,
        startLine: section.startLine,
        endLine: section.endLine,
        heading: section.heading,
      },
    ];
  }

  const chunks: Chunk[] = [];
  const paragraphs = content.split(/\n\n+/);
  let currentChunk = "";
  let chunkStartLine = section.startLine;
  let lineOffset = 0;

  for (const paragraph of paragraphs) {
    const paragraphLines = paragraph.split("\n").length;

    if (currentChunk.length + paragraph.length > maxChunkSize) {
      if (currentChunk.length >= minChunkSize) {
        chunks.push({
          content: formatChunk(currentChunk.trim(), section.heading),
          index: startIndex + chunks.length,
          startLine: chunkStartLine,
          endLine: chunkStartLine + lineOffset,
          heading: section.heading,
        });

        const overlapText = getOverlapText(currentChunk, overlapSize);
        currentChunk = overlapText + (overlapText ? "\n\n" : "") + paragraph;
        chunkStartLine = chunkStartLine + lineOffset;
        lineOffset = paragraphLines;
      } else {
        currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
        lineOffset += paragraphLines + 1;
      }
    } else {
      currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      lineOffset += paragraphLines + 1;
    }
  }

  if (currentChunk.trim().length >= minChunkSize) {
    chunks.push({
      content: formatChunk(currentChunk.trim(), section.heading),
      index: startIndex + chunks.length,
      startLine: chunkStartLine,
      endLine: section.endLine,
      heading: section.heading,
    });
  } else if (chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1]!;
    lastChunk.content += "\n\n" + currentChunk.trim();
    lastChunk.endLine = section.endLine;
  } else if (currentChunk.trim().length > 0) {
    chunks.push({
      content: formatChunk(currentChunk.trim(), section.heading),
      index: startIndex,
      startLine: section.startLine,
      endLine: section.endLine,
      heading: section.heading,
    });
  }

  return chunks;
}

function formatChunk(content: string, heading?: string): string {
  if (heading) {
    return `## ${heading}\n\n${content}`;
  }
  return content;
}

function getOverlapText(text: string, overlapSize: number): string {
  if (text.length <= overlapSize) {
    return text;
  }

  const lastPart = text.slice(-overlapSize);
  const sentenceEnd = lastPart.search(/[.!?]\s+[A-Z]/);

  if (sentenceEnd !== -1) {
    return lastPart.slice(sentenceEnd + 2);
  }

  const wordBoundary = lastPart.indexOf(" ");
  return wordBoundary !== -1 ? lastPart.slice(wordBoundary + 1) : lastPart;
}
