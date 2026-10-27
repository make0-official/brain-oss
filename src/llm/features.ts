import type { MemoryClassifier } from "./classify";
import { createMemoryClassifier } from "./classify";
import type { LlmClient } from "./client";
import { createMemoryExtractor, type MemoryExtractor } from "./extract";
import { createPairJudge, type PairJudge } from "./judge";
import { createRetrievalLlmHooks, type MemoryRetrievalLlmHooks } from "./retrieval";

/** Optional BYO-key features. Each one has a local fallback. */
export type LlmFeatures = {
  judge?: PairJudge;
  classify?: MemoryClassifier;
  retrieval?: MemoryRetrievalLlmHooks;
  extract?: MemoryExtractor;
};

export function createLlmFeatures(client: LlmClient, options: { search?: boolean } = {}): LlmFeatures {
  return {
    judge: createPairJudge(client),
    classify: createMemoryClassifier(client),
    retrieval: options.search === false ? undefined : createRetrievalLlmHooks(client),
    extract: createMemoryExtractor(client),
  };
}
