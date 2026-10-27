import { lexicalSimilarity, queryTermCoverage, tokenize } from "../search/lexical";
import type { EmbeddingProvider, PairScorer } from "./provider";

function hashToken(token: string, dimensions: number): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % dimensions;
}

/**
 * Deterministic bag-of-words vectors. No download; used by tests and
 * `MAKE0_BRAIN_EMBEDDINGS=hashing` for offline CI. Not for real use.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model = "hashing-bow-384";
  readonly dimensions = 384;

  async embed(texts: string[]): Promise<Array<number[] | null>> {
    return texts.map((text) => {
      const tokens = tokenize(text);
      if (tokens.length === 0) return null;
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const token of tokens) vector[hashToken(token, this.dimensions)] += 1;
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      return vector.map((value) => value / norm);
    });
  }
}

/** Lexical stand-in for the cross-encoder in tests. */
export class LexicalPairScorer implements PairScorer {
  readonly model = "lexical";

  async score(a: string, pairs: string[]): Promise<number[]> {
    return pairs.map((text) => Math.max(lexicalSimilarity(a, text), queryTermCoverage(a, text)));
  }
}
