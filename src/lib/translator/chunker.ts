export interface TextChunk {
  id: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Split raw text into paragraph-aware chunks.
 * Tries to break at paragraph boundaries (\n\n) to preserve context.
 */
export function chunkText(
  rawText: string,
  targetChars: number,
): TextChunk[] {
  const cleaned = rawText.replace(/\r\n/g, "\n");
  const paragraphs = cleaned.split(/\n(?=\n)/);
  const chunks: TextChunk[] = [];
  let currentChunk = "";
  let currentOffset = 0;
  let chunkId = 0;

  for (const para of paragraphs) {
    if (
      currentChunk.length + para.length > targetChars &&
      currentChunk.length > 0
    ) {
      chunks.push({
        id: chunkId++,
        text: currentChunk.trim(),
        startOffset: currentOffset,
        endOffset: currentOffset + currentChunk.length,
      });
      currentOffset += currentChunk.length;
      currentChunk = "";
    }

    // If a single paragraph exceeds target, split it further
    if (para.length > targetChars) {
      if (currentChunk.length > 0) {
        chunks.push({
          id: chunkId++,
          text: currentChunk.trim(),
          startOffset: currentOffset,
          endOffset: currentOffset + currentChunk.length,
        });
        currentOffset += currentChunk.length;
        currentChunk = "";
      }
      // Split long paragraph at sentence boundaries (。！？)
      const sentences = para.split(/(?<=[。！？])/);
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > targetChars && currentChunk.length > 0) {
          chunks.push({
            id: chunkId++,
            text: currentChunk.trim(),
            startOffset: currentOffset,
            endOffset: currentOffset + currentChunk.length,
          });
          currentOffset += currentChunk.length;
          currentChunk = "";
        }
        currentChunk += sentence;
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + para;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({
      id: chunkId++,
      text: currentChunk.trim(),
      startOffset: currentOffset,
      endOffset: currentOffset + currentChunk.length,
    });
  }

  return chunks;
}
