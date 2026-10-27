import assert from "node:assert/strict";
import { test } from "vitest";
import { classifyMemoryHeuristic, resolveMemoryClassification } from "../src/write/classify";
import { ensureMemoryGraphLinks } from "../src/write/links";
import { createTestBrain } from "./helpers";

test("heuristic classifier matches cloud categories", () => {
  assert.deepEqual(classifyMemoryHeuristic("I work as a product designer at Acme"), {
    category: "Personal Info",
    kind: "profile",
    entityType: "person",
  });
  assert.equal(classifyMemoryHeuristic("I prefer short LinkedIn posts").category, "Content Preferences");
  assert.equal(classifyMemoryHeuristic("Launched the Make0 Brain OSS repo").entityType, "artifact");
});

test("explicit category wins; explicit entity type picks the default category", () => {
  assert.equal(resolveMemoryClassification("anything", { category: "Food" }).category, "Food");
  assert.equal(resolveMemoryClassification("anything", { entityType: "project" }).category, "Projects");
});

test("addMemory embeds, classifies, and attributes the writer", async () => {
  const brain = createTestBrain();
  const { memory } = await brain.addMemory({ content: "I prefer   dark mode", writer: "claude" });
  assert.equal(memory.content, "I prefer dark mode");
  assert.equal(memory.entityType, "preference");
  assert.equal(memory.originProvider, "claude");
  assert.equal(memory.confidence, 100);
  assert.equal(memory.embedding?.length, 384);
  assert.equal(memory.embeddingModel, "hashing-bow-384");
});

test("an opposite-polarity memory archives the older one", async () => {
  const brain = createTestBrain();
  const first = await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  const second = await brain.addMemory({ content: "I dislike spicy food at dinner", writer: "cursor" });
  assert.deepEqual(second.supersededIds, [first.memory.id]);
  assert.equal(brain.getMemory(first.memory.id), undefined);
  assert.ok(brain.getMemory(first.memory.id, { includeArchived: true })?.deletedAt);
});

test("restated memories are kept without an LLM judge", async () => {
  const brain = createTestBrain();
  await brain.addMemory({ content: "Make0 Brain launch plan: Show HN post and Reddit posts", writer: "claude" });
  const second = await brain.addMemory({ content: "Make0 Brain launch plan: Show HN post and X thread", writer: "claude" });
  assert.deepEqual(second.supersededIds, []);
  assert.equal(brain.store.countMemories(), 2);
});

test("a correction archives the memory it corrects", async () => {
  const brain = createTestBrain();
  const first = await brain.addMemory({ content: "My home city is Pune", writer: "claude" });
  const second = await brain.addMemory({
    content: "Correction: my home city is Bangalore, not Pune",
    entityType: "correction",
    writer: "claude",
  });
  assert.deepEqual(second.supersededIds, [first.memory.id]);
});

test("unrelated memories are kept", async () => {
  const brain = createTestBrain();
  await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  const result = await brain.addMemory({ content: "I work as a product designer at Acme", writer: "claude" });
  assert.deepEqual(result.supersededIds, []);
  assert.equal(brain.store.countMemories(), 2);
});

test("similar memories get related_to links; distant ones do not", () => {
  const brain = createTestBrain();
  const base = { category: "Topics", kind: "work", entityType: "topic", embeddingModel: "m" } as const;
  const a = brain.store.createMemory({ ...base, content: "a", embedding: [1, 0, 0] });
  const b = brain.store.createMemory({ ...base, content: "b", embedding: [0.9, 0.3, 0] });
  brain.store.createMemory({ ...base, content: "c", embedding: [0, 0, 1] });
  assert.equal(ensureMemoryGraphLinks(brain.store), 1);
  const [edge] = brain.store.listEdges();
  assert.deepEqual([edge.fromMemoryId, edge.toMemoryId].sort(), [a.id, b.id].sort());
  assert.ok(edge.weight > 0.9);
});

test("links are pruned when an endpoint drifts away", () => {
  const brain = createTestBrain();
  const base = { category: "Topics", kind: "work", entityType: "topic", embeddingModel: "m" } as const;
  const a = brain.store.createMemory({ ...base, content: "a", embedding: [1, 0, 0] });
  brain.store.createMemory({ ...base, content: "b", embedding: [0.9, 0.3, 0] });
  ensureMemoryGraphLinks(brain.store);
  brain.store.updateMemory(a.id, { embedding: [0, 0, 1] }, { recordVersion: false });
  ensureMemoryGraphLinks(brain.store);
  assert.equal(brain.store.listEdges().length, 0);
});

test("updateMemory re-embeds, versions, and records the new writer", async () => {
  const brain = createTestBrain();
  const { memory } = await brain.addMemory({ content: "My favorite editor is Vim", writer: "claude" });
  const updated = await brain.updateMemory(memory.id, { content: "My favorite editor is Zed" }, "cursor");
  assert.equal(updated?.lastWrittenVia, "cursor");
  assert.equal(updated?.originProvider, "claude");
  assert.notDeepEqual(updated?.embedding, memory.embedding);
  assert.equal(brain.getVersions(memory.id).length, 2);
});

test("restoreVersion re-embeds the restored content", async () => {
  const brain = createTestBrain();
  const { memory } = await brain.addMemory({ content: "My favorite editor is Vim", writer: "claude" });
  await brain.updateMemory(memory.id, { content: "My favorite editor is Zed" }, "claude");
  const restored = await brain.restoreVersion(memory.id, 1);
  assert.equal(restored?.content, "My favorite editor is Vim");
  assert.deepEqual(restored?.embedding, memory.embedding);
});

test("search ranks the matching memory first", async () => {
  const brain = createTestBrain();
  await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  await brain.addMemory({ content: "I work as a product designer at Acme", writer: "claude" });
  await brain.addMemory({ content: "I prefer window seats on long flights", writer: "claude" });
  const hits = await brain.search("what is my dog called");
  assert.match(hits[0].memory.content, /Bruno/);
  assert.equal(hits[0].isSeed, true);
});

test("search filters by kind and entity type", async () => {
  const brain = createTestBrain();
  await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  await brain.addMemory({
    content: "Bruno tracker app for dog walks",
    category: "Projects",
    kind: "work",
    entityType: "project",
    writer: "claude",
  });
  const hits = await brain.search("Bruno", { entityType: "project" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].memory.entityType, "project");
});

test("search skips archived memories and low-confidence Make0 memories", async () => {
  const brain = createTestBrain();
  const kept = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  const archived = await brain.addMemory({ content: "My cat is named Luna", writer: "claude" });
  brain.deleteMemory(archived.memory.id, "claude");
  await brain.addMemory({
    content: "Maybe the user has a hamster",
    writer: "make0",
    isManuallyAdded: false,
    confidence: 30,
  });
  const hits = await brain.search("pet named", { minConfidence: 50, minScore: 0, relativeRatio: 0 });
  const ids = hits.map((hit) => hit.memory.id);
  assert.ok(ids.includes(kept.memory.id));
  assert.ok(!ids.includes(archived.memory.id));
  assert.ok(!hits.some((hit) => /hamster/.test(hit.memory.content)));
});

test("search re-embeds memories from another model", async () => {
  const brain = createTestBrain();
  const { memory } = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  brain.store.updateMemory(memory.id, { embedding: [1, 2, 3], embeddingModel: "cloud-model" }, { recordVersion: false });
  await brain.search("dog");
  assert.equal(brain.getMemory(memory.id)?.embeddingModel, "hashing-bow-384");
});
