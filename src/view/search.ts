import type { Brain } from "../brain";

export type ViewSearchHit = {
  id: string;
  score: number;
  hop: number;
};

export type ViewSearchResult = {
  query: string;
  /** Embed, vector and BM25 retrieval, rerank, and graph expansion. HTTP is not included. */
  searchMs: number;
  hits: ViewSearchHit[];
};

/**
 * Hybrid retrieval for the viewer: semantic + BM25, rerank, then graph expansion.
 * `minResults: 0` keeps the score floor, so weak padding does not fill the board.
 */
export async function searchViewMemories(brain: Brain, brainId: string, query: string): Promise<ViewSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) return { query: "", searchMs: 0, hits: [] };

  await brain.reembedStale();
  const started = performance.now();
  const hits = await brain.search(trimmed, {
    brainId,
    limit: 64,
    minResults: 0,
    skipReembed: true,
  });
  const searchMs = Math.max(0, Math.round(performance.now() - started));

  return {
    query: trimmed,
    searchMs,
    hits: hits.map((hit) => ({
      id: hit.memory.id,
      score: Math.round(hit.score * 1000) / 1000,
      hop: hit.hop,
    })),
  };
}
