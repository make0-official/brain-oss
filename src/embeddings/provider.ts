/** Turns memory text into vectors. Swap for a BYO-key provider later. */
export interface EmbeddingProvider {
  /** Stored in `embedding_model`; a mismatch means re-embed. */
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<Array<number[] | null>>;
}

/** Scores how relevant `b` is to `a`, 0..1. Cloud uses MiniLM cross-encoder. */
export interface PairScorer {
  readonly model: string;
  score(a: string, pairs: string[]): Promise<number[]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function embedOne(provider: EmbeddingProvider, text: string): Promise<number[] | null> {
  const [embedding] = await provider.embed([text]);
  return embedding ?? null;
}
``