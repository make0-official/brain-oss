import type { Memory, MemoryEdge } from "../shared/types";

// Constants match Make0 cloud graph expansion.
export const MEMORY_CONTEXT_NEIGHBOR_HOPS = 2;
const MEMORY_CONTEXT_HOP_DECAY = 0.85;
const MEMORY_CONTEXT_HOP1_MIN_WEIGHT = 0.7;
const MEMORY_CONTEXT_HOP2_MIN_WEIGHT = 0.85;

export type MemoryContextEntry = {
  memory: Memory;
  score: number;
  hop: number;
  isSeed: boolean;
  link?: {
    relationshipType: string;
    fromMemoryId: string;
  };
};

type MemoryGraphNeighbor = {
  memoryId: string;
  edgeType: string;
  weight: number;
};

function minNeighborWeightForHop(hop: number): number {
  return hop <= 1 ? MEMORY_CONTEXT_HOP1_MIN_WEIGHT : MEMORY_CONTEXT_HOP2_MIN_WEIGHT;
}

/** Keep seeds; if over budget drop hop-2, then hop-1, then lowest score. */
function compareKeepOrder(a: MemoryContextEntry, b: MemoryContextEntry): number {
  if (a.isSeed !== b.isSeed) return a.isSeed ? -1 : 1;
  if (a.hop !== b.hop) return a.hop - b.hop;
  return b.score - a.score;
}

function isBetter(candidate: MemoryContextEntry, current: MemoryContextEntry): boolean {
  return compareKeepOrder(candidate, current) < 0;
}

export function trimMemoryContextEntries(
  entries: MemoryContextEntry[],
  maxNodes: number,
): MemoryContextEntry[] {
  const seeds = entries.filter((entry) => entry.isSeed);
  const others = entries.filter((entry) => !entry.isSeed);
  if (seeds.length >= maxNodes) return seeds.sort(compareKeepOrder);
  const keptOthers = others.sort(compareKeepOrder).slice(0, maxNodes - seeds.length);
  return [...seeds, ...keptOthers].sort(compareKeepOrder);
}

function buildAdjacencyList(edges: MemoryEdge[]): Map<string, MemoryGraphNeighbor[]> {
  const adjacency = new Map<string, MemoryGraphNeighbor[]>();
  const addNeighbor = (fromId: string, neighbor: MemoryGraphNeighbor): void => {
    const existing = adjacency.get(fromId) || [];
    existing.push(neighbor);
    adjacency.set(fromId, existing);
  };
  for (const edge of edges) {
    const weight = Number.isFinite(edge.weight) ? edge.weight : 0.5;
    addNeighbor(edge.fromMemoryId, { memoryId: edge.toMemoryId, edgeType: edge.relationshipType, weight });
    addNeighbor(edge.toMemoryId, { memoryId: edge.fromMemoryId, edgeType: edge.relationshipType, weight });
  }
  return adjacency;
}

/**
 * Walk up to `maxHops` along strong edges from the ranked seeds.
 * Neighbor score = parent score × edge weight × 0.85^hop.
 */
export function expandMemoryContextSubgraph(params: {
  seeds: Array<{ id: string; score: number }>;
  edges: MemoryEdge[];
  memoryById: Map<string, Memory>;
  maxNodes: number;
  maxHops: number;
  minScore: number;
}): MemoryContextEntry[] {
  const { seeds, edges, memoryById, maxNodes, maxHops, minScore } = params;
  if (seeds.length === 0) return [];

  const adjacency = buildAdjacencyList(edges);
  const entries = new Map<string, MemoryContextEntry>();

  for (const seed of seeds) {
    const memory = memoryById.get(seed.id);
    if (!memory) continue;
    entries.set(seed.id, { memory, score: seed.score, hop: 0, isSeed: true });
  }

  const queue = [...entries.values()].map((entry) => ({
    id: entry.memory.id,
    score: entry.score,
    hop: entry.hop,
  }));

  const tryAdmit = (candidate: MemoryContextEntry): boolean => {
    const existing = entries.get(candidate.memory.id);
    if (existing?.isSeed) return false;
    if (existing && !isBetter(candidate, existing)) return false;

    if (!existing && entries.size >= maxNodes) {
      let worst: MemoryContextEntry | null = null;
      for (const entry of entries.values()) {
        if (entry.isSeed) continue;
        if (!worst || isBetter(worst, entry)) worst = entry;
      }
      if (!worst || !isBetter(candidate, worst)) return false;
      entries.delete(worst.memory.id);
    }

    entries.set(candidate.memory.id, candidate);
    return true;
  };

  while (queue.length > 0) {
    queue.sort((a, b) => (a.hop !== b.hop ? a.hop - b.hop : b.score - a.score));
    const current = queue.shift();
    if (!current || current.hop >= maxHops) continue;
    if (!entries.has(current.id)) continue;

    for (const neighbor of adjacency.get(current.id) || []) {
      const hop = current.hop + 1;
      if (neighbor.weight < minNeighborWeightForHop(hop)) continue;
      const memory = memoryById.get(neighbor.memoryId);
      if (!memory) continue;
      const propagatedScore = current.score * neighbor.weight * MEMORY_CONTEXT_HOP_DECAY ** hop;
      if (propagatedScore < minScore) continue;
      const candidate: MemoryContextEntry = {
        memory,
        score: propagatedScore,
        hop,
        isSeed: false,
        link: { relationshipType: neighbor.edgeType, fromMemoryId: current.id },
      };
      if (!tryAdmit(candidate)) continue;
      queue.push({ id: neighbor.memoryId, score: propagatedScore, hop });
    }
  }

  return trimMemoryContextEntries([...entries.values()], maxNodes);
}
