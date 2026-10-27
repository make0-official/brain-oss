import type { LlmClient } from "../llm/client";
import { MEMORY_EMBEDDING_DIMENSIONS } from "../shared/limits";
import type { EmbeddingProvider } from "./provider";

const EMBED_BATCH_SIZE = 64;

/**
 * OpenAI-compatible embeddings at 384 dims. With text-embedding-3-small this
 * is the same vector space as Make0 cloud. Opt in with MAKE0_BRAIN_EMBEDDINGS=api.
 */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = MEMORY_EMBEDDING_DIMENSIONS;

  constructor(private client: LlmClient) {}

  get model(): string {
    return this.client.config.embeddingModel;
  }

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    const results: Array<number[] | null> = [];
    for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
      const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
      const vectors = await this.client.embed(batch, this.dimensions);
      results.push(...batch.map((_, index) => (vectors[index]?.length === this.dimensions ? vectors[index] : null)));
    }
    return results;
  }
}
