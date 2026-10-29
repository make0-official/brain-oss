import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { test } from "vitest";
import { BrainStore, BrainStoreError } from "../src/store/store";
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

test("upgrades a version-3 database and keeps memories on personal", () => {
  const file = path.join(os.tmpdir(), `make0-v3-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'work',
      entity_type TEXT NOT NULL DEFAULT 'topic',
      confidence INTEGER NOT NULL DEFAULT 75,
      source_type TEXT NOT NULL DEFAULT 'manual',
      is_manually_added INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      embedding BLOB,
      embedding_model TEXT,
      origin_provider TEXT NOT NULL DEFAULT 'make0',
      last_written_via TEXT NOT NULL DEFAULT 'make0',
      deleted_at TEXT,
      deleted_via TEXT,
      discovered_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL,
      kind TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      confidence INTEGER NOT NULL DEFAULT 75,
      written_by TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      embedding_model TEXT,
      writer_name TEXT
    );
    CREATE TABLE memory_edges (
      id TEXT PRIMARY KEY,
      from_memory_id TEXT NOT NULL,
      to_memory_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL DEFAULT 'related_to',
      weight REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare(
    `INSERT INTO memories (
      id, content, category, kind, entity_type, confidence, source_type, is_manually_added,
      metadata, origin_provider, last_written_via, discovered_at, created_at, updated_at
    ) VALUES ('mem-old', 'Likes tea', 'Preferences', 'profile', 'preference', 75, 'manual', 1, '{}', 'claude', 'claude', ?, ?, ?)`,
  ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.pragma("user_version = 3");
  db.close();

  const store = new BrainStore(file);
  const [memory] = store.listMemories();
  assert.equal(memory.content, "Likes tea");
  assert.equal(memory.brainId, "personal");
  assert.equal(store.getBrain("personal")?.name, "Personal brain");
  assert.equal(store.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  store.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
});

test("grants saved before agent_access keep their brains after migrating", () => {
  const file = path.join(os.tmpdir(), `make0-brain-access-${process.pid}-${Date.now()}.db`);
  const before = new BrainStore(file);
  const work = before.createBrain({ name: "Work" });
  before.setClientBrains("cursor", [work.id]);
  before.db.exec("DROP TABLE agent_access");
  before.db.pragma(`user_version = ${SCHEMA_VERSION - 1}`);
  before.close();

  const store = new BrainStore(file);
  assert.deepEqual(store.listConfiguredClientIds(), ["cursor"]);
  assert.deepEqual(store.brainsVisibleToClient("cursor").map((brain) => brain.id), [work.id]);
  assert.deepEqual(store.brainsVisibleToClient("codex").map((brain) => brain.id), ["personal"]);
  store.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
});

test("creates, grants, and refuses to delete a brain that still has memories", () => {
  const store = newStore();
  const work = store.createBrain({ name: "  Work notes  ", description: "  client   work  ", emoji: "💼" });
  assert.equal(work.kind, "custom");
  assert.equal(work.name, "Work notes");
  assert.equal(work.description, "client work");
  assert.deepEqual(store.brainsVisibleToClient("cursor").map((brain) => brain.id), ["personal"]);
  store.grantClientBrain("cursor", work.id);
  assert.deepEqual(store.brainsVisibleToClient("cursor").map((brain) => brain.id), ["personal", work.id]);
  store.setClientBrains("cursor", [work.id]);
  assert.deepEqual(store.brainsVisibleToClient("cursor").map((brain) => brain.id), [work.id]);
  store.revokeClientBrain("cursor", work.id);
  assert.deepEqual(store.brainsVisibleToClient("cursor"), []);
  assert.deepEqual(store.clientIdsForBrain("personal", ["cursor", "codex"]), ["codex"]);
  assert.deepEqual(store.listConfiguredClientIds(), ["cursor"]);
  store.revokeClientBrain("codex", "personal");
  assert.deepEqual(store.brainsVisibleToClient("codex"), []);
  store.grantClientBrain("cursor", work.id);
  assert.deepEqual(store.brainsVisibleToClient("cursor").map((brain) => brain.id), [work.id]);

  const memory = store.createMemory({ ...base, content: "Ship Friday", brainId: work.id });
  assert.equal(memory.brainId, work.id);
  assert.equal(store.listMemories({ brainId: "personal" }).length, 0);
  assert.throws(() => store.deleteBrain(work.id), (error: unknown) => error instanceof BrainStoreError && error.code === "in_use");
  store.purgeMemory(memory.id);
  store.deleteBrain(work.id);
  assert.equal(store.getBrain(work.id), undefined);
  assert.throws(() => store.deleteBrain("personal"), (error: unknown) => error instanceof BrainStoreError && error.code === "protected");
  store.close();
});
