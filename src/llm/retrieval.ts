import { type LlmClient, parseJsonObjectLoose } from "./client";

// Matches the Make0 cloud LLM retrieval filter.
const FILTER_CHARS = 700;
const RERANK_CHARS = 800;

export type MemoryLlmCandidate = {
  id: string;
  text: string;
  retrieveScore: number;
};

export type MemoryRetrievalLlmHooks = {
  filterKeepIds: (query: string, candidates: MemoryLlmCandidate[]) => Promise<string[] | null>;
  rerank: (query: string, candidates: MemoryLlmCandidate[]) => Promise<Array<{ id: string; score: number }> | null>;
};

function truncateMemoryText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function formatCandidateList(candidates: MemoryLlmCandidate[], maxChars: number): string {
  return candidates
    .map(
      (candidate, index) =>
        `${index + 1}. hybrid=${candidate.retrieveScore.toFixed(3)}\n${truncateMemoryText(candidate.text, maxChars)}`,
    )
    .join("\n\n");
}

/** Accepts 1-based numbers or raw ids. */
export function parseMemoryKeepIds(raw: string, validIds: Set<string>, orderedIds: string[] = []): string[] | null {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const keep = (parsed as { keep?: unknown }).keep;
  if (!Array.isArray(keep)) return null;
  const ids = keep.flatMap((item) => {
    if (typeof item === "number" || (typeof item === "string" && /^\d+$/.test(item))) {
      const id = orderedIds[Number(item) - 1];
      return id && validIds.has(id) ? [id] : [];
    }
    const id = typeof item === "string" ? item : String(item ?? "");
    return validIds.has(id) ? [id] : [];
  });
  return [...new Set(ids)];
}

export function parseMemoryRanked(
  raw: string,
  validIds: Set<string>,
  orderedIds: string[] = [],
): Array<{ id: string; score: number }> | null {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const ranked = (parsed as { ranked?: unknown }).ranked;
  if (!Array.isArray(ranked)) return null;
  const scores: Array<{ id: string; score: number }> = [];
  const seen = new Set<string>();
  for (const item of ranked) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rawId = (item as { id?: unknown; i?: unknown }).id ?? (item as { i?: unknown }).i;
    let id = "";
    if (typeof rawId === "number" || (typeof rawId === "string" && /^\d+$/.test(rawId))) {
      id = orderedIds[Number(rawId) - 1] ?? "";
    } else if (typeof rawId === "string") {
      id = rawId;
    }
    if (!validIds.has(id) || seen.has(id)) continue;
    const rawScore = Number((item as { score?: unknown }).score);
    seen.add(id);
    scores.push({ id, score: Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0 });
  }
  return scores.length > 0 ? scores : null;
}

export function createRetrievalLlmHooks(client: LlmClient): MemoryRetrievalLlmHooks {
  return {
    async filterKeepIds(query, candidates) {
      if (candidates.length === 0) return [];
      const orderedIds = candidates.map((candidate) => candidate.id);
      const raw = await client.completeJson({
        maxTokens: 700,
        timeoutMs: 12_000,
        system:
          'You filter retrieved personal memories for a search query. Return strict JSON only: {"keep":[1,2,5]} using 1-based candidate numbers. KEEP a candidate only if it could help answer the query. The query may include what the user is trying to ask. For an open or hypothetical question, keep personal facts that support that intent, including hobbies, relationships, and routines. DROP memories that do not help, even if they share a common word. Never return an empty keep list: if nothing is clearly relevant, keep the strongest candidates. Prefer precision over a long list.',
        user: `Query:\n${query.trim()}\n\nCandidates:\n${formatCandidateList(candidates, FILTER_CHARS)}`,
      });
      const keepIds = parseMemoryKeepIds(raw, new Set(orderedIds), orderedIds);
      return keepIds && keepIds.length > 0 ? keepIds : null;
    },
    async rerank(query, candidates) {
      if (candidates.length === 0) return [];
      const orderedIds = candidates.map((candidate) => candidate.id);
      const raw = await client.completeJson({
        maxTokens: 900,
        timeoutMs: 12_000,
        system:
          'You rerank retrieved personal memories for a search query. Return strict JSON only: {"ranked":[{"i":1,"score":0.9}]} using 1-based candidate numbers and scores 0-1. Rank complementary facts above duplicate sessions. Include every candidate number.',
        user: `Query:\n${query.trim()}\n\nMemories:\n${formatCandidateList(candidates, RERANK_CHARS)}`,
      });
      return parseMemoryRanked(raw, new Set(orderedIds), orderedIds);
    },
  };
}
