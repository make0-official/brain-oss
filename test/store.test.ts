import assert from "node:assert/strict";
import { test } from "vitest";
import { BrainStore } from "../src/store/store";
import { SCHEMA_VERSION } from "../src/store/schema";

function newStore() {
  return new BrainStore(":memory:");
}

const base = { category: "Preferences", kind: "profile", entityType: "preference" } as const;

test("migrates to the latest schema version", () => {
  const store = newStore();
  assert.equal(store.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
});

test("create writes version 1 as current", () => {
  const store = newStore();
  const memory = store.createMemory({ ...base, content: "Likes tea", originProvider: "claude", isManuallyAdded: true });
  const versions = store.getVersions(memory.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].versionNumber, 1);
  assert.equal(versions[0].isCurrent, true);
  assert.equal(versions[0].writtenBy, "claude");
  assert.equal(memory.lastWrittenVia, "claude");
});

test("embeddings round-trip through the blob column", () => {
  const store = newStore();
  const embedding = [0.25, -0.5, 1];
  const memory = store.createMemory({ ...base, content: "Likes tea", embedding, embeddingModel: "m" });
  assert.deepEqual(store.getMemory(memory.id)?.embedding, embedding);
  assert.equal(store.getMemory(memory.id)?.embeddingModel, "m");
});

test("content updates add a current version; confidence-only updates do not", () => {
  const store = newStore();
  const memory = store.createMemory({ ...base, content: "Likes tea" });
  store.updateMemory(memory.id, { content: "Likes green tea", lastWrittenVia: "cursor" });
  store.updateMemory(memory.id, { confidence: 40 });
  const versions = store.getVersions(memory.id);
  assert.deepEqual(versions.map((version) => version.versionNumber), [2, 1]);
  assert.deepEqual(versions.map((version) => version.isCurrent), [true, false]);
  assert.equal(versions[0].writtenBy, "cursor");
  assert.equal(store.getMemory(memory.id)?.confidence, 40);
});

test("archive hides a memory, keeps versions, and restore brings it back", () => {
  const store = newStore();
  const memory = store.createMemory({ ...base, content: "Likes tea" });
  assert.equal(store.archiveMemory(memory.id, "claude"), true);
  assert.equal(store.getMemory(memory.id), undefined);
  assert.equal(store.getMemory(memory.id, { includeArchived: true })?.deletedVia, "claude");
  assert.equal(store.getVersions(memory.id).length, 1);
  assert.equal(store.countMemories(), 0);
  assert.ok(store.restoreMemory(memory.id));
  assert.equal(store.countMemories(), 1);
});

test("restoreVersion makes an old version current without adding one", () => {
  const store = newStore();
  const memory = store.createMemory({ ...base, content: "Likes tea" });
  store.updateMemory(memory.id, { content: "Likes coffee" });
  const restored = store.restoreVersion(memory.id, 1);
  assert.equal(restored?.content, "Likes tea");
  assert.equal(restored?.embedding, null);
  const versions = store.getVersions(memory.id);
  assert.equal(versions.length, 2);
  assert.equal(versions.find((version) => version.isCurrent)?.versionNumber, 1);
});

test("edges are undirected, upserted, and hidden when an endpoint is archived", () => {
  const store = newStore();
  const a = store.createMemory({ ...base, content: "A memory" });
  const b = store.createMemory({ ...base, content: "B memory" });
  store.upsertEdge({ fromMemoryId: b.id, toMemoryId: a.id, relationshipType: "related_to", weight: 0.7 });
  store.upsertEdge({ fromMemoryId: a.id, toMemoryId: b.id, relationshipType: "related_to", weight: 0.9 });
  const edges = store.listEdges();
  assert.equal(edges.length, 1);
  assert.equal(edges[0].weight, 0.9);
  assert.equal(edges[0].fromMemoryId < edges[0].toMemoryId, true);
  store.archiveMemory(a.id, "make0");
  assert.equal(store.listEdges().length, 0);
});

test("purge removes the memory, its versions, and its edges", () => {
  const store = newStore();
  const a = store.createMemory({ ...base, content: "A memory" });
  const b = store.createMemory({ ...base, content: "B memory" });
  store.upsertEdge({ fromMemoryId: a.id, toMemoryId: b.id, relationshipType: "related_to", weight: 0.9 });
  assert.equal(store.purgeMemory(a.id), true);
  assert.equal(store.getMemory(a.id, { includeArchived: true }), undefined);
  assert.equal(store.getVersions(a.id).length, 0);
  const { n } = store.db.prepare("SELECT COUNT(*) AS n FROM memory_edges").get() as { n: number };
  assert.equal(n, 0);
});
