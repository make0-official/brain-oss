import assert from "node:assert/strict";
import { test } from "vitest";
import { expandMemoryContextSubgraph } from "../src/search/graph";
import type { Memory, MemoryEdge } from "../src/shared/types";

function memory(id: string): Memory {
  return {
    id,
    content: id,
    category: "Topics",
    kind: "work",
    entityType: "topic",
    confidence: 100,
    sourceType: "manual",
    isManuallyAdded: true,
    metadata: {},
    embedding: null,
    embeddingModel: null,
    originProvider: "claude",
    lastWrittenVia: "claude",
    deletedAt: null,
    deletedVia: null,
    discoveredAt: "",
    createdAt: "",
    updatedAt: "",
  };
}

function edge(from: string, to: string, weight: number): MemoryEdge {
  return { id: `${from}-${to}`, fromMemoryId: from, toMemoryId: to, relationshipType: "related_to", weight, createdAt: "", updatedAt: "" };
}

const memoryById = new Map(["a", "b", "c", "d"].map((id) => [id, memory(id)]));

test("expands two hops along strong edges with decayed scores", () => {
  const entries = expandMemoryContextSubgraph({
    seeds: [{ id: "a", score: 1 }],
    edges: [edge("a", "b", 0.9), edge("b", "c", 0.9)],
    memoryById,
    maxNodes: 10,
    maxHops: 2,
    minScore: 0.1,
  });
  assert.deepEqual(entries.map((entry) => [entry.memory.id, entry.hop]), [["a", 0], ["b", 1], ["c", 2]]);
  assert.ok(Math.abs(entries[1].score - 0.9 * 0.85) < 1e-9);
});

test("skips edges below the per-hop weight floor", () => {
  const entries = expandMemoryContextSubgraph({
    seeds: [{ id: "a", score: 1 }],
    edges: [edge("a", "b", 0.65), edge("a", "c", 0.9), edge("c", "d", 0.8)],
    memoryById,
    maxNodes: 10,
    maxHops: 2,
    minScore: 0.1,
  });
  assert.deepEqual(entries.map((entry) => entry.memory.id), ["a", "c"]);
});

test("keeps seeds first when over budget", () => {
  const entries = expandMemoryContextSubgraph({
    seeds: [{ id: "a", score: 0.5 }, { id: "d", score: 0.4 }],
    edges: [edge("a", "b", 1), edge("a", "c", 1)],
    memoryById,
    maxNodes: 3,
    maxHops: 2,
    minScore: 0.1,
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.slice(0, 2).map((entry) => entry.memory.id), ["a", "d"]);
});
