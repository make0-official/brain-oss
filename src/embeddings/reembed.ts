import { memoryDocumentText } from "../shared/limits";
import type { BrainStore } from "../store/store";
import { embedOne, type EmbeddingProvider } from "./provider";

/** A stored vector is usable only when it came from the embedder this process is running. */
export function embeddingMatches(embedding: number[] | null, storedModel: string | null, model: string): boolean {
  return Boolean(embedding && embedding.length > 0 && storedModel === model);
}

/**
 * Rewrite live vectors whose embedder is missing or different.
 * A change in `.env` (local MiniLM vs API, or another API model) does not mix spaces.
 */
export async function reembedMismatched(store: BrainStore, embeddings: EmbeddingProvider): Promise<number> {
  const stale = store
    .listMemories()
    .filter((memory) => !embeddingMatches(memory.embedding, memory.embeddingModel, embeddings.model));
  let updated = 0;
  for (const memory of stale) {
    try {
      const embedding = await embedOne(embeddings, memoryDocumentText(memory));
      if (!embedding) continue;
      store.updateMemory(memory.id, { embedding, embeddingModel: embeddings.model }, { recordVersion: false });
      updated += 1;
    } catch (error) {
      console.error("[make0-brain] re-embed failed:", error);
    }
  }
  return updated;
}
