import assert from "node:assert/strict";
import { test } from "vitest";
import { HashingEmbeddingProvider } from "../src/embeddings/hashing";
import { BrainStore } from "../src/store/store";
import { buildMemoryList } from "../src/view/list";
import { startViewer } from "../src/view/server";

const base = { category: "Preferences", kind: "profile" as const, entityType: "preference" as const };

test("buildMemoryList groups live memories and omits embeddings", () => {
  const store = new BrainStore(":memory:");
  store.createMemory({
    ...base,
    content: "Likes window seats",
    originProvider: "claude",
    isManuallyAdded: true,
    embedding: [1, 2, 3],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  store.createMemory({
    ...base,
    category: "Work",
    content: "Works at Acme",
    originProvider: "cursor",
    createdAt: "2026-02-01T00:00:00.000Z",
  });
  const archived = store.createMemory({ ...base, content: "Old fact", createdAt: "2026-03-01T00:00:00.000Z" });
  store.archiveMemory(archived.id, "make0");

  const list = buildMemoryList(store);
  assert.equal(list.title, "Personal brain");
  assert.deepEqual(
    list.memories.map((memory) => memory.content),
    ["Works at Acme", "Likes window seats"],
  );
  assert.deepEqual(
    list.archived.map((memory) => memory.content),
    ["Old fact"],
  );
  assert.equal(list.archived[0].archived, true);
  assert.equal(list.memories[0].addedBy, "cursor");
  assert.equal(list.memories[1].addedBy, "claude");
  assert.equal("embedding" in list.memories[0], false);
  store.close();
});

test("viewer serves the list page and the memory API", async () => {
  const store = new BrainStore(":memory:");
  store.createMemory({ ...base, content: "Test phrase is blue heron", originProvider: "claude" });
  const server = await startViewer(store, 0, new HashingEmbeddingProvider());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const page = await fetch(baseUrl);
  const html = await page.text();
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(html, /Search memories/);
  assert.match(html, /Personal brain/);
  assert.match(html, /Recycle bin/);
  assert.match(html, /Make version/);
  assert.match(html, /Larger writer/);
  assert.match(html, /import --detect/);
  assert.match(html, /export --json brain.json/);
  assert.match(html, /https:\/\/make0\.ai/);
  assert.match(html, /Use hosted Brain on Make0/);
  assert.match(html, /Dismiss hosted Brain ad/);
  assert.match(html, /Connect \/ import \/ export/);
  assert.match(html, /Refresh memories/);

  const api = await fetch(`${baseUrl}/api/memories`);
  const body = (await api.json()) as { memories: Array<{ id: string; content: string }> };
  assert.equal(body.memories[0].content, "Test phrase is blue heron");

  const seeded = await fetch(`${baseUrl}/api/memories/${body.memories[0].id}/embedding`);
  const seededBody = (await seeded.json()) as { missing: boolean; storedModel: string; values: number[] };
  assert.equal(seeded.status, 200);
  assert.equal(seededBody.missing, false);
  assert.equal(seededBody.storedModel, "hashing-bow-384");
  assert.equal(seededBody.values.length, 384);

  const logo = await fetch(`${baseUrl}/logo.png`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.ok((await logo.arrayBuffer()).byteLength > 1000);

  const created = await fetch(`${baseUrl}/api/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "I prefer aisle seats", category: "Preferences" }),
  });
  const createdBody = (await created.json()) as { id: string; content: string };
  assert.equal(created.status, 201);
  assert.equal(createdBody.content, "I prefer aisle seats");

  const updated = await fetch(`${baseUrl}/api/memories/${createdBody.id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "I prefer window seats", category: "Preferences" }),
  });
  assert.equal(updated.status, 200);

  const versions = await fetch(`${baseUrl}/api/memories/${createdBody.id}/versions`);
  const versionBody = (await versions.json()) as {
    versions: Array<{ versionNumber: number; content: string; isCurrent: boolean; embeddingModel: string | null }>;
  };
  assert.equal(versionBody.versions.length, 2);
  assert.equal(versionBody.versions.find((version) => version.isCurrent)?.content, "I prefer window seats");
  assert.equal(versionBody.versions.find((version) => version.isCurrent)?.embeddingModel, "hashing-bow-384");

  const restored = await fetch(`${baseUrl}/api/memories/${createdBody.id}/versions/1/restore`, { method: "POST" });
  const restoredBody = (await restored.json()) as { content: string };
  assert.equal(restored.status, 200);
  assert.equal(restoredBody.content, "I prefer aisle seats");

  const removed = await fetch(`${baseUrl}/api/memories/${createdBody.id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  const afterDelete = (await (await fetch(`${baseUrl}/api/memories`)).json()) as {
    memories: Array<{ id: string }>;
    archived: Array<{ id: string; archived: boolean }>;
  };
  assert.equal(afterDelete.memories.some((memory) => memory.id === createdBody.id), false);
  assert.equal(afterDelete.archived.some((memory) => memory.id === createdBody.id && memory.archived), true);

  const recovered = await fetch(`${baseUrl}/api/memories/${createdBody.id}/restore`, { method: "POST" });
  const recoveredBody = (await recovered.json()) as { id: string; content: string; archived: boolean };
  assert.equal(recovered.status, 200);
  assert.equal(recoveredBody.archived, false);
  assert.equal(recoveredBody.content, "I prefer aisle seats");
  const afterRecover = (await (await fetch(`${baseUrl}/api/memories`)).json()) as {
    memories: Array<{ id: string }>;
    archived: Array<{ id: string }>;
  };
  assert.equal(afterRecover.memories.some((memory) => memory.id === createdBody.id), true);
  assert.equal(afterRecover.archived.some((memory) => memory.id === createdBody.id), false);

  const rejected = await fetch(`${baseUrl}/api/memories`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "no", category: "Preferences" }),
  });
  assert.equal(rejected.status, 400);

  const config = await fetch(`${baseUrl}/api/config`);
  const configBody = (await config.json()) as {
    embedder: { name: string; model: string };
    reranker: { name: string };
    howToChange: string;
    apiKey?: string;
  };
  assert.equal(config.status, 200);
  assert.ok(configBody.embedder.name);
  assert.ok(configBody.reranker.name);
  assert.match(configBody.howToChange, /\.env/);
  assert.equal("apiKey" in configBody, false);

  store.updateMemory(createdBody.id, { embedding: [0.25, -0.5], embeddingModel: "test-model" });
  const embedding = await fetch(`${baseUrl}/api/memories/${createdBody.id}/embedding`);
  const embeddingBody = (await embedding.json()) as { values: number[]; storedModel: string; stale: boolean; embedder: { name: string; model: string } };
  assert.equal(embedding.status, 200);
  assert.equal(embeddingBody.storedModel, "hashing-bow-384");
  assert.equal(embeddingBody.values.length, 384);
  assert.equal(embeddingBody.stale, embeddingBody.embedder.model !== "hashing-bow-384");
  assert.ok(embeddingBody.embedder.name);

  const removedAgain = await fetch(`${baseUrl}/api/memories/${createdBody.id}`, { method: "DELETE" });
  assert.equal(removedAgain.status, 200);
  const livePurge = await fetch(`${baseUrl}/api/memories/missing-id/purge`, { method: "POST" });
  assert.equal(livePurge.status, 400);
  const purged = await fetch(`${baseUrl}/api/memories/${createdBody.id}/purge`, { method: "POST" });
  assert.equal(purged.status, 200);
  const afterPurge = (await (await fetch(`${baseUrl}/api/memories`)).json()) as { archived: Array<{ id: string }> };
  assert.equal(afterPurge.archived.some((memory) => memory.id === createdBody.id), false);

  const missing = await fetch(`${baseUrl}/nope`);
  assert.equal(missing.status, 404);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  store.close();
});
