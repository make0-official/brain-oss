import { cosineSimilarity } from "../embeddings/provider";
import type { BrainStore } from "../store/store";
import { sortedEdgeEndpoints } from "../store/store";
import type { Memory } from "../shared/types";

// Constants match Make0 cloud link inference.
export const MEMORY_LINK_VECTOR_MIN_SIMILARITY = 0.69;
const MEMORY_LINK_VECTOR_CANDIDATES = 50;
const MAX_LINKS_PER_MEMORY = 10;

export function resolveMemoryLinkWeight(similarityScore: number): number {
  if (!Number.isFinite(similarityScore)) return 0.6;
  return Math.max(0.2, Math.min(1, similarityScore));
}

function edgeKey(fromId: string, toId: string, relationshipType: string): string {
  const [a, b] = sortedEdgeEndpoints(fromId, toId);
  return `${a}|${b}|${relationshipType}`;
}

function hasEmbedding(memory: Memory): memory is Memory & { embedding: number[] } {
  return Array.isArray(memory.embedding) && memory.embedding.length > 0;
}

/** Drop `related_to` edges whose endpoints drifted apart (content edited, re-embedded). */
export function pruneWeakMemoryLinks(
  store: BrainStore,
  memories: Memory[],
  minSimilarity = MEMORY_LINK_VECTOR_MIN_SIMILARITY,
): number {
  const byId = new Map(memories.map((memory) => [memory.id, memory]));
  let deleted = 0;
  for (const edge of store.listEdges()) {
    if (edge.relationshipType !== "related_to") continue;
    const from = byId.get(edge.fromMemoryId);
    const to = byId.get(edge.toMemoryId);
    if (!from || !to || !hasEmbedding(from) || !hasEmbedding(to)) continue;
    if (cosineSimilarity(from.embedding, to.embedding) < minSimilarity) {
      store.deleteEdge(edge.id);
      deleted += 1;
    }
  }
  return deleted;
}

/**
 * Add `related_to` edges between vector neighbors (cosine ≥ 0.69), at most
 * 10 per memory. Same rule as Make0 cloud.
 */
export function ensureMemoryGraphLinks(
  store: BrainStore,
  minSimilarity = MEMORY_LINK_VECTOR_MIN_SIMILARITY,
): number {
  const nodes = store.listMemories().filter(hasEmbedding);
  pruneWeakMemoryLinks(store, nodes, minSimilarity);
  if (nodes.length < 2) return 0;

  const edges = store.listEdges();
  const existingKeys = new Set(
    edges.map((edge) => edgeKey(edge.fromMemoryId, edge.toMemoryId, edge.relationshipType)),
  );
  const linkCounts = new Map<string, number>();
  for (const edge of edges) {
    linkCounts.set(edge.fromMemoryId, (linkCounts.get(edge.fromMemoryId) ?? 0) + 1);
    linkCounts.set(edge.toMemoryId, (linkCounts.get(edge.toMemoryId) ?? 0) + 1);
  }

  let created = 0;
  for (const source of nodes) {
    const ranked = nodes
      .filter((candidate) => candidate.id !== source.id)
      .map((candidate) => ({ candidate, score: cosineSimilarity(source.embedding, candidate.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MEMORY_LINK_VECTOR_CANDIDATES);

    for (const { candidate, score } of ranked) {
      if (score < minSimilarity) break;
      const sourceCount = linkCounts.get(source.id) ?? 0;
      if (sourceCount >= MAX_LINKS_PER_MEMORY) break;
      const otherCount = linkCounts.get(candidate.id) ?? 0;
      if (otherCount >= MAX_LINKS_PER_MEMORY) continue;
      const key = edgeKey(source.id, candidate.id, "related_to");
      if (existingKeys.has(key)) continue;

      store.upsertEdge({
        fromMemoryId: source.id,
        toMemoryId: candidate.id,
        relationshipType: "related_to",
        weight: resolveMemoryLinkWeight(score),
      });
      existingKeys.add(key);
      linkCounts.set(source.id, sourceCount + 1);
      linkCounts.set(candidate.id, otherCount + 1);
      created += 1;
    }
  }
  return created;
}
