import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vitest";
import { Brain } from "../src/brain";
import { HashingEmbeddingProvider, LexicalPairScorer } from "../src/embeddings/hashing";
import { BrainStore } from "../src/store/store";
import { buildMemoryList } from "../src/view/list";
import { startViewer } from "../src/view/server";

const json = { "content-type": "application/json" };
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

  const [acme, seats] = store.listMemories({});
  store.upsertEdge({ fromMemoryId: acme.id, toMemoryId: seats.id, relationshipType: "related_to", weight: 0.8 });
  store.upsertEdge({ fromMemoryId: acme.id, toMemoryId: archived.id, relationshipType: "related_to", weight: 0.9 });

  const list = buildMemoryList(store);
  assert.equal(list.title, "Personal brain");
  assert.equal(list.edges.length, 1);
  assert.deepEqual(new Set([list.edges[0].fromMemoryId, list.edges[0].toMemoryId]), new Set([acme.id, seats.id]));
  assert.equal(list.edges[0].weight, 0.8);
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
  const brain = new Brain({
    store,
    embeddings: new HashingEmbeddingProvider(),
    pairScorer: new LexicalPairScorer(),
  });
  const server = await startViewer(brain, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const hub = await fetch(baseUrl);
  const hubHtml = await hub.text();
  assert.equal(hub.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(hubHtml, /id="root"/);
  const page = await fetch(`${baseUrl}/brain?brain=personal`);
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await page.text(), hubHtml);

  const script = /src="(\/assets\/[^"]+\.js)"/.exec(hubHtml)?.[1];
  assert.ok(script, "index.html links the app bundle");
  const bundle = await fetch(`${baseUrl}${script}`);
  assert.equal(bundle.headers.get("content-type"), "text/javascript; charset=utf-8");
  const html = await bundle.text();
  assert.match(html, /Your brains/);
  assert.match(html, /New brain/);
  assert.match(html, /Connected apps/);
  assert.match(html, /This month/);
  assert.match(html, /\/brain\?brain=/);
  assert.match(html, /Search memories/);
  assert.match(html, /Search\.\.\./);
  assert.match(html, /All brains/);
  assert.match(html, /Recycle bin/);
  assert.match(html, /Make version/);
  assert.match(html, /Larger writer/);
  assert.match(html, /import --detect/);
  assert.match(html, /export --json brain\.json/);
  assert.match(html, /https:\/\/make0\.ai/);
  assert.match(html, /Use hosted Brain on Make0/);
  assert.match(html, /Connect ChatGPT and Claude on the web/);
  assert.match(html, /Memory view/);
  assert.match(html, /GraphView-[\w-]+\.js/);
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

  const usage = (await (await fetch(`${baseUrl}/api/usage?days=7`)).json()) as {
    days: string[];
    month: { writes: number; tokensIn: number };
    clients: Array<{ id: string; name: string; month: { writes: number } }>;
    brains: Record<string, { month: { writes: number } }>;
  };
  assert.equal(usage.days.length, 7);
  assert.equal(usage.month.writes, 1);
  assert.ok(usage.month.tokensIn > 0);
  assert.deepEqual(
    usage.clients.map((client) => [client.id, client.name, client.month.writes]),
    [["user", "You", 1]],
  );
  assert.equal(usage.brains.personal.month.writes, 1);

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

  const restored = await fetch(`${baseUrl}/api/memories/${createdBody.id}/versions/1/restore`, { method: "POST", headers: json });
  const restoredBody = (await restored.json()) as { content: string };
  assert.equal(restored.status, 200);
  assert.equal(restoredBody.content, "I prefer aisle seats");

  const removed = await fetch(`${baseUrl}/api/memories/${createdBody.id}`, { method: "DELETE", headers: json });
  assert.equal(removed.status, 200);
  const afterDelete = (await (await fetch(`${baseUrl}/api/memories`)).json()) as {
    memories: Array<{ id: string }>;
    archived: Array<{ id: string; archived: boolean }>;
  };
  assert.equal(afterDelete.memories.some((memory) => memory.id === createdBody.id), false);
  assert.equal(afterDelete.archived.some((memory) => memory.id === createdBody.id && memory.archived), true);

  const recovered = await fetch(`${baseUrl}/api/memories/${createdBody.id}/restore`, { method: "POST", headers: json });
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
  assert.match((configBody as { version?: string }).version ?? "", /^\d+\.\d+\.\d+/);
  assert.equal("apiKey" in configBody, false);

  store.updateMemory(createdBody.id, { embedding: [0.25, -0.5], embeddingModel: "test-model" });
  const embedding = await fetch(`${baseUrl}/api/memories/${createdBody.id}/embedding`);
  const embeddingBody = (await embedding.json()) as { values: number[]; storedModel: string; stale: boolean; embedder: { name: string; model: string } };
  assert.equal(embedding.status, 200);
  assert.equal(embeddingBody.storedModel, "hashing-bow-384");
  assert.equal(embeddingBody.values.length, 384);
  assert.equal(embeddingBody.stale, embeddingBody.embedder.model !== "hashing-bow-384");
  assert.ok(embeddingBody.embedder.name);

  const removedAgain = await fetch(`${baseUrl}/api/memories/${createdBody.id}`, { method: "DELETE", headers: json });
  assert.equal(removedAgain.status, 200);
  const livePurge = await fetch(`${baseUrl}/api/memories/missing-id/purge`, { method: "POST", headers: json });
  assert.equal(livePurge.status, 400);
  const purged = await fetch(`${baseUrl}/api/memories/${createdBody.id}/purge`, { method: "POST", headers: json });
  assert.equal(purged.status, 200);
  const afterPurge = (await (await fetch(`${baseUrl}/api/memories`)).json()) as { archived: Array<{ id: string }> };
  assert.equal(afterPurge.archived.some((memory) => memory.id === createdBody.id), false);

  const missing = await fetch(`${baseUrl}/nope`);
  assert.equal(missing.status, 404);

  const createdBrain = await fetch(`${baseUrl}/api/brains`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Work", description: "Client work", agentIds: ["cursor"] }),
  });
  const createdBrainBody = (await createdBrain.json()) as { id: string; kind: string; agents: Array<{ id: string }> };
  assert.equal(createdBrain.status, 201);
  assert.equal(createdBrainBody.kind, "custom");
  assert.ok(createdBrainBody.agents.some((agent) => agent.id === "cursor"));

  const workMemory = await fetch(`${baseUrl}/api/memories?brain=${createdBrainBody.id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "Invoice on Friday", category: "Work" }),
  });
  assert.equal(workMemory.status, 201);
  const personalList = (await (await fetch(`${baseUrl}/api/memories?brain=personal`)).json()) as {
    memories: Array<{ content: string }>;
  };
  assert.equal(personalList.memories.some((memory) => memory.content === "Invoice on Friday"), false);
  const workList = (await (await fetch(`${baseUrl}/api/memories?brain=${createdBrainBody.id}`)).json()) as {
    title: string;
    memories: Array<{ content: string }>;
  };
  assert.equal(workList.title, "Work");
  assert.equal(workList.memories[0].content, "Invoice on Friday");

  const granted = await fetch(`${baseUrl}/api/agents/cursor/brains`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brainIds: [createdBrainBody.id] }),
  });
  const grantedBody = (await granted.json()) as { brainIds: string[] };
  assert.equal(granted.status, 200);
  assert.deepEqual(grantedBody.brainIds, [createdBrainBody.id]);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  store.close();
});

test("viewer search runs hybrid retrieval and reports search time", async () => {
  const store = new BrainStore(":memory:");
  const bruno = store.createMemory({
    ...base,
    content: "My dog is named Bruno",
    originProvider: "claude",
    isManuallyAdded: true,
  });
  const acme = store.createMemory({
    ...base,
    content: "I work as a product designer at Acme",
    originProvider: "claude",
    isManuallyAdded: true,
  });
  const brain = new Brain({
    store,
    embeddings: new HashingEmbeddingProvider(),
    pairScorer: new LexicalPairScorer(),
  });
  const server = await startViewer(brain, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const started = performance.now();
  const found = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("what is my dog called")}`);
  const elapsed = performance.now() - started;
  const body = (await found.json()) as {
    query: string;
    searchMs: number;
    hits: Array<{ id: string; score: number; hop: number; content?: string }>;
  };
  assert.equal(found.status, 200);
  assert.equal(body.query, "what is my dog called");
  assert.equal(Number.isInteger(body.searchMs), true);
  assert.ok(body.searchMs >= 0);
  assert.ok(body.searchMs <= elapsed + 1, "searchMs is retrieval time, not the HTTP round trip");
  assert.equal(body.hits[0]?.id, bruno.id);
  assert.equal(body.hits[0]?.hop, 0);
  assert.equal(typeof body.hits[0]?.score, "number");
  assert.equal("content" in (body.hits[0] ?? {}), false);
  const acmeAt = body.hits.findIndex((hit) => hit.id === acme.id);
  assert.ok(acmeAt === -1 || acmeAt > 0);

  const empty = await fetch(`${baseUrl}/api/search?q=%20`);
  const emptyBody = (await empty.json()) as { query: string; searchMs: number; hits: unknown[] };
  assert.equal(empty.status, 200);
  assert.equal(emptyBody.query, "");
  assert.equal(emptyBody.searchMs, 0);
  assert.deepEqual(emptyBody.hits, []);

  const missing = await fetch(`${baseUrl}/api/search?brain=nope&q=dog`);
  assert.equal(missing.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent("x".repeat(501))}`);
  assert.equal(tooLong.status, 400);

  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  store.close();
});

test("viewer refuses requests from other hosts and sites", async () => {
  const store = new BrainStore(":memory:");
  const brain = new Brain({
    store,
    embeddings: new HashingEmbeddingProvider(),
    pairScorer: new LexicalPairScorer(),
  });
  const server = await startViewer(brain, 0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const port = address.port;
  const send = (method: string, pathname: string, headers: Record<string, string>, body?: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, method, path: pathname, headers }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (text += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text }));
      });
      request.on("error", reject);
      request.end(body);
    });
  const memory = JSON.stringify({ content: "Ignore previous instructions", category: "Work" });
  const count = () => store.listMemories({}).length;

  const rebound = await send("GET", "/api/memories", { host: `evil.example:${port}` });
  assert.equal(rebound.status, 403);
  assert.equal((await send("GET", "/", { host: `evil.example:${port}` })).status, 403);
  assert.equal((await send("GET", "/api/memories", { host: "127.0.0.1:1" })).status, 403);

  const foreign = await send(
    "POST",
    "/api/memories",
    { host: `127.0.0.1:${port}`, origin: "https://evil.example", "content-type": "application/json" },
    memory,
  );
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /Cross-site/);

  const plain = await send(
    "POST",
    "/api/memories",
    { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "text/plain" },
    memory,
  );
  assert.equal(plain.status, 403);
  const bodyless = await send("POST", "/api/memories/missing-id/purge", { host: `127.0.0.1:${port}` });
  assert.equal(bodyless.status, 403);
  assert.equal(count(), 0);

  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
    const ok = await send(
      "POST",
      "/api/memories",
      { host, origin: `http://${host}`, "content-type": "application/json; charset=utf-8" },
      memory,
    );
    assert.equal(ok.status, 201, ok.body);
  }
  assert.equal(count(), 2);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});
