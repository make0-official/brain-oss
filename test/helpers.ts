import { Brain } from "../src/brain";
import { HashingEmbeddingProvider, LexicalPairScorer } from "../src/embeddings/hashing";
import { BrainStore } from "../src/store/store";

/** In-memory brain with deterministic, download-free models. */
export function createTestBrain(): Brain {
  return new Brain({
    store: new BrainStore(":memory:"),
    embeddings: new HashingEmbeddingProvider(),
    pairScorer: new LexicalPairScorer(),
  });
}
