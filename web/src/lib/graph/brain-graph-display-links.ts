import { normalizeLinkWeight } from "./memory-link-strength";

export const HIGH_CONFIDENCE_LINK_THRESHOLD = 0.6;

export type DisplayGraphEdge = {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  weight: number;
};

export function isHighConfidenceLink(weight: number | null | undefined) {
  return normalizeLinkWeight(weight) >= HIGH_CONFIDENCE_LINK_THRESHOLD;
}

function neighborCap(nodeCount: number) {
  if (nodeCount >= 80) return 4;
  if (nodeCount >= 30) return 5;
  return 6;
}

function backboneEdgeIds(
  nodeIds: string[],
  edges: DisplayGraphEdge[],
  cap: number,
): Set<string> {
  const kept = new Set<string>();
  if (edges.length === 0 || nodeIds.length === 0) return kept;

  const nodeIdSet = new Set(nodeIds);
  const parent = new Map(nodeIds.map((id) => [id, id]));
  const find = (id: string): string => {
    let current = parent.get(id) ?? id;
    while (current !== (parent.get(current) ?? current)) {
      const next = parent.get(current) ?? current;
      parent.set(current, parent.get(next) ?? next);
      current = next;
    }
    return current;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return false;
    parent.set(a, b);
    return true;
  };

  const usable = edges.filter(
    (edge) =>
      nodeIdSet.has(edge.fromMemoryId) && nodeIdSet.has(edge.toMemoryId),
  );
  const ranked = [...usable].sort(
    (left, right) =>
      normalizeLinkWeight(right.weight) - normalizeLinkWeight(left.weight),
  );

  if (ranked.length <= nodeIds.length * 2.2) {
    for (const edge of ranked) kept.add(edge.id);
    return kept;
  }

  const degree = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of ranked) {
    if (union(edge.fromMemoryId, edge.toMemoryId)) {
      kept.add(edge.id);
      degree.set(edge.fromMemoryId, (degree.get(edge.fromMemoryId) ?? 0) + 1);
      degree.set(edge.toMemoryId, (degree.get(edge.toMemoryId) ?? 0) + 1);
    }
  }

  for (const edge of ranked) {
    if (kept.has(edge.id)) continue;
    const fromDegree = degree.get(edge.fromMemoryId) ?? 0;
    const toDegree = degree.get(edge.toMemoryId) ?? 0;
    if (fromDegree >= cap || toDegree >= cap) continue;
    kept.add(edge.id);
    degree.set(edge.fromMemoryId, fromDegree + 1);
    degree.set(edge.toMemoryId, toDegree + 1);
  }

  return kept;
}

export function displayLinkIds(
  nodeIds: string[],
  edges: DisplayGraphEdge[],
): Set<string> {
  const strong = edges.filter((edge) => isHighConfidenceLink(edge.weight));
  const pool =
    strong.length > 0
      ? strong
      : [...edges]
          .sort(
            (left, right) =>
              normalizeLinkWeight(right.weight) -
              normalizeLinkWeight(left.weight),
          )
          .slice(0, Math.max(12, Math.round(nodeIds.length * 1.4)));
  return backboneEdgeIds(nodeIds, pool, neighborCap(nodeIds.length));
}
