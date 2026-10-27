/** Hard cap for one memory. A memory is a short markdown page. */
export const MEMORY_CONTENT_MAX_CHARS = 4000;

/** Human size of one memory, used in tool descriptions. */
export const MEMORY_WORDS_PER_MEMORY = 800;

export function countMemoryWords(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

/** Keep markdown line breaks. Collapse spaces on each line. */
export function normalizeMemoryDocument(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .trim();
}

/** Text used for memory embedding and lexical/semantic retrieval. */
export function memoryDocumentText(memory: {
  category: string;
  content: string;
  kind?: string | null;
  entityType?: string | null;
}): string {
  return [memory.kind, memory.entityType, memory.category, memory.content]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

export const MEMORY_EMBEDDING_DIMENSIONS = 384;
