import { cosineSimilarity, type PairScorer } from "../embeddings/provider";
import type { MemoryLlmCandidate, MemoryRetrievalLlmHooks } from "../llm/retrieval";
import { memoryDateMatchScore, scoreDocumentsBm25 } from "./lexical";
import { keepRankedByThreshold } from "./threshold";

// Constants match Make0 cloud retrieval.
export const MEMORY_RETRIEVAL_VECTOR_CANDIDATES = 40;
export const MEMORY_RETRIEVAL_BM25_CANDIDATES = 40;
export const MEMORY_RETRIEVAL_CROSS_ENCODER_CANDIDATES = 40;
/** Score every memory with the cross-encoder when the brain is at or below this size. */
export const MEMORY_RETRIEVAL_FULL_SCAN_MAX = 64;
export const MEMORY_RETRIEVAL_MIN_SCORE = 0.15;
/** After prune, still return this many ranked memories when the pool is large enough. */
export const MEMORY_RETRIEVAL_MIN_RESULTS = 10;
export const MEMORY_RETRIEVAL_RELATIVE_RATIO = 0.5;
const MEMORY_RETRIEVAL_VECTOR_BLEND = 0.55;
const MEMORY_RETRIEVAL_BM25_BLEND = 0.45;
const MEMORY_RETRIEVAL_DATE_VECTOR_BLEND = 0.5;
const MEMORY_RETRIEVAL_DATE_BM25_BLEND = 0.35;
const MEMORY_RETRIEVAL_DATE_BLEND = 0.15;
const MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR = 0.05;
const MEMORY_RETRIEVAL_CROSS_ENCODER_BLEND = 0.7;
/** Skip the LLM rerank stage when the filter keeps this many or fewer. */
const MEMORY_RETRIEVAL_LLM_STAGE2_MIN = 3;

export type RankedMemoryCandidate = {
  id: string;
  score: number;
};

export type RankableMemory = {
  id: string;
  text: string;
  embedding?: number[] | null;
};

type MemoryRetrievalCandidate = RankableMemory & {
  bm25?: number;
  vector?: number;
  retrieveScore?: number;
  /** BM25 hit came from a prefix of a complete word. */
  partialKeyword?: boolean;
};

function allVectorScores(
  memories: RankableMemory[],
  queryEmbedding: number[],
): Array<{ id: string; score: number }> {
  return memories
    .filter((memory) => Array.isArray(memory.embedding) && memory.embedding.length > 0)
    .map((memory) => ({
      id: memory.id,
      score: cosineSimilarity(queryEmbedding, memory.embedding as number[]),
    }))
    .sort((a, b) => b.score - a.score);
}

function retrieveScore(vector?: number, bm25?: number, dateScore = 0): number {
  if (dateScore > 0) {
    return (
      (vector ?? 0) * MEMORY_RETRIEVAL_DATE_VECTOR_BLEND +
      (bm25 ?? 0) * MEMORY_RETRIEVAL_DATE_BM25_BLEND +
      dateScore * MEMORY_RETRIEVAL_DATE_BLEND
    );
  }
  if (vector != null && bm25 != null) {
    return vector * MEMORY_RETRIEVAL_VECTOR_BLEND + bm25 * MEMORY_RETRIEVAL_BM25_BLEND;
  }
  return Math.max(vector ?? 0, bm25 ?? 0);
}

export function blendMemoryRerankScore(
  crossEncoderScore: number,
  hybridScore: number,
  keywordScore = 0,
): number {
  const blended =
    crossEncoderScore * MEMORY_RETRIEVAL_CROSS_ENCODER_BLEND +
    hybridScore * (1 - MEMORY_RETRIEVAL_CROSS_ENCODER_BLEND);
  // A typed fragment has no exact token for the reranker. Keep a real prefix hit
  // above the score floor instead of dropping it.
  return Math.max(blended, keywordScore * 0.5);
}

export function buildHybridCandidates(
  query: string,
  memories: RankableMemory[],
  options: {
    queryEmbedding: number[] | null;
    candidateCap: number;
    fullScanMax: number;
  },
): MemoryRetrievalCandidate[] {
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const bm25Hits = scoreDocumentsBm25(query, memories);
  const bm25ById = new Map(bm25Hits.map((item) => [item.id, item]));
  const allVectorHits = options.queryEmbedding ? allVectorScores(memories, options.queryEmbedding) : [];
  const vectorById = new Map(allVectorHits.map((item) => [item.id, item.score]));

  const useFullScan = memories.length <= options.fullScanMax;
  const candidateIds = new Set<string>();
  if (useFullScan) {
    for (const memory of memories) candidateIds.add(memory.id);
  } else {
    for (const hit of allVectorHits
      .filter((item) => item.score > MEMORY_RETRIEVAL_VECTOR_CANDIDATE_FLOOR)
      .slice(0, options.candidateCap)) {
      candidateIds.add(hit.id);
    }
    for (const hit of bm25Hits.filter((item) => item.score > 0).slice(0, options.candidateCap)) {
      candidateIds.add(hit.id);
    }
  }

  const dateById = new Map<string, number>();
  let anyDateMatch = false;
  for (const id of candidateIds) {
    const memory = memoryById.get(id);
    if (!memory) continue;
    const dateScore = memoryDateMatchScore(query, memory.text);
    dateById.set(id, dateScore);
    if (dateScore > 0) anyDateMatch = true;
  }

  return [...candidateIds].flatMap((id) => {
    const memory = memoryById.get(id);
    if (!memory) return [];
    const vector = vectorById.get(id);
    const bm25Hit = bm25ById.get(id);
    const bm25 = bm25Hit?.normalized ?? 0;
    const dateScore = anyDateMatch ? (dateById.get(id) ?? 0) : 0;
    return [
      {
        ...memory,
        bm25,
        vector,
        partialKeyword: bm25Hit?.partial ?? false,
        retrieveScore: retrieveScore(vector, bm25, dateScore),
      },
    ];
  });
}

function hybridScores(pool: MemoryRetrievalCandidate[]): RankedMemoryCandidate[] {
  return pool.map((candidate) => ({ id: candidate.id, score: candidate.retrieveScore ?? 0 }));
}

function padRankedMemories(
  kept: RankedMemoryCandidate[],
  pool: RankedMemoryCandidate[],
  minResults: number,
  maxResults?: number,
): RankedMemoryCandidate[] {
  const ceiling = Math.min(
    Math.max(minResults, 0),
    maxResults ?? Number.POSITIVE_INFINITY,
    pool.length || kept.length,
  );
  const padded = [...kept];
  if (ceiling > 0 && padded.length < ceiling) {
    const seen = new Set(padded.map((item) => item.id));
    for (const item of pool) {
      if (padded.length >= ceiling) break;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      padded.push(item);
    }
  }
  if (maxResults == null) return padded;
  return padded.slice(0, Math.max(0, maxResults));
}

function applyKeepList(pool: MemoryRetrievalCandidate[], keepIds: string[]): MemoryRetrievalCandidate[] {
  const byId = new Map(pool.map((candidate) => [candidate.id, candidate]));
  const kept: MemoryRetrievalCandidate[] = [];
  for (const id of new Set(keepIds)) {
    const candidate = byId.get(id);
    if (candidate) kept.push(candidate);
  }
  return kept.sort((left, right) => (right.retrieveScore ?? 0) - (left.retrieveScore ?? 0));
}

/** Cross-encoder blended with the hybrid score; hybrid only without a scorer or on failure. */
async function scoreWithCrossEncoder(
  query: string,
  pool: MemoryRetrievalCandidate[],
  pairScorer?: PairScorer,
): Promise<RankedMemoryCandidate[]> {
  if (!pairScorer) return hybridScores(pool);
  try {
    const cross = await pairScorer.score(
      query,
      pool.map((candidate) => candidate.text),
    );
    return pool.map((candidate, index) => ({
      id: candidate.id,
      score: blendMemoryRerankScore(
        cross[index] ?? 0,
        candidate.retrieveScore ?? 0,
        candidate.partialKeyword ? (candidate.bm25 ?? 0) : 0,
      ),
    }));
  } catch (error) {
    console.error("[make0-brain] cross-encoder failed; using semantic+BM25:", error);
    return hybridScores(pool);
  }
}

/** LLM keep-list, then LLM rerank blended with the hybrid score. Null means fall back. */
async function scoreWithLlmFilter(
  query: string,
  pool: MemoryRetrievalCandidate[],
  hooks: MemoryRetrievalLlmHooks,
): Promise<RankedMemoryCandidate[] | null> {
  const llmCandidates: MemoryLlmCandidate[] = pool.map((candidate) => ({
    id: candidate.id,
    text: candidate.text,
    retrieveScore: candidate.retrieveScore ?? 0,
  }));
  const keepIds = await hooks.filterKeepIds(query, llmCandidates);
  if (!keepIds || keepIds.length === 0) return null;
  const kept = applyKeepList(pool, keepIds);
  if (kept.length === 0) return null;
  if (kept.length <= MEMORY_RETRIEVAL_LLM_STAGE2_MIN) return hybridScores(kept);

  try {
    const ranked = await hooks.rerank(
      query,
      kept.map((candidate) => ({ id: candidate.id, text: candidate.text, retrieveScore: candidate.retrieveScore ?? 0 })),
    );
    if (!ranked || ranked.length === 0) return hybridScores(kept);
    const llmById = new Map(ranked.map((item) => [item.id, item.score]));
    return kept.map((candidate) => ({
      id: candidate.id,
      score: blendMemoryRerankScore(
        llmById.get(candidate.id) ?? 0,
        candidate.retrieveScore ?? 0,
        candidate.partialKeyword ? (candidate.bm25 ?? 0) : 0,
      ),
    }));
  } catch (error) {
    console.error("[make0-brain] LLM rerank failed; keeping filter order:", error);
    return hybridScores(kept);
  }
}

/**
 * Hybrid memory retrieval: semantic + BM25 shortlist → LLM filter/rerank
 * (BYO key) or cross-encoder → relative pruning → pad to minResults.
 * Same pipeline as Make0 cloud retrieval, without its query optimizer.
 */
export async function rankMemoriesForQuery(
  query: string,
  memories: RankableMemory[],
  options: {
    queryEmbedding: number[] | null;
    maxResults?: number;
    minScore?: number;
    relativeRatio?: number;
    minResults?: number;
    candidateCap?: number;
    fullScanMax?: number;
    /** Omit to rank with vector + BM25 only. */
    pairScorer?: PairScorer;
    /** BYO-key LLM filter; tried first, cross-encoder is the fallback. */
    llmHooks?: MemoryRetrievalLlmHooks;
  },
): Promise<RankedMemoryCandidate[]> {
  if (memories.length === 0 || !query.trim()) return [];

  const maxResults = options.maxResults;
  const minScore = options.minScore ?? MEMORY_RETRIEVAL_MIN_SCORE;
  const relativeRatio = options.relativeRatio ?? MEMORY_RETRIEVAL_RELATIVE_RATIO;
  const minResults = options.minResults ?? MEMORY_RETRIEVAL_MIN_RESULTS;
  const candidateCap = options.candidateCap ?? MEMORY_RETRIEVAL_CROSS_ENCODER_CANDIDATES;
  const fullScanMax = options.fullScanMax ?? MEMORY_RETRIEVAL_FULL_SCAN_MAX;

  const candidates = buildHybridCandidates(query, memories, {
    queryEmbedding: options.queryEmbedding,
    candidateCap: Math.max(candidateCap, MEMORY_RETRIEVAL_VECTOR_CANDIDATES, MEMORY_RETRIEVAL_BM25_CANDIDATES),
    fullScanMax,
  }).sort((left, right) => (right.retrieveScore ?? 0) - (left.retrieveScore ?? 0));

  const rerankPool = candidates.slice(0, Math.max(maxResults ?? 0, candidateCap));

  let scored: RankedMemoryCandidate[] | null = null;
  if (options.llmHooks) {
    try {
      scored = await scoreWithLlmFilter(query, rerankPool, options.llmHooks);
    } catch (error) {
      console.error("[make0-brain] LLM filter failed; using cross-encoder:", error);
    }
  }
  if (!scored || scored.length === 0) {
    scored = await scoreWithCrossEncoder(query, rerankPool, options.pairScorer);
  }

  scored.sort((a, b) => b.score - a.score);
  const pruned = keepRankedByThreshold(scored, { minScore, relativeRatio });
  return padRankedMemories(pruned, hybridScores(rerankPool), minResults, maxResults);
}
