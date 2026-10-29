import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "vitest";
import { createBrainMcpServer } from "../src/mcp/server";
import { createTestBrain } from "./helpers";

async function connect(clientName = "claude-code") {
  const brain = createTestBrain();
  const server = createBrainMcpServer(brain);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
    };
    return { isError: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
  };
  return { brain, client, call };
}

test("exposes the same 7 tools as cloud Brain", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "add_memory",
    "delete_memory",
    "get_memory",
    "get_memory_versions",
    "list_brains",
    "search_brain",
    "update_memory",
  ]);
});

test("list_brains returns the single personal brain", async () => {
  const { call } = await connect();
  const { data } = await call("list_brains");
  assert.deepEqual(data.brains.map((brain: { id: string }) => brain.id), ["personal"]);
});

test("a custom brain stays hidden until it is granted", async () => {
  const { brain, call } = await connect("cursor");
  const work = brain.store.createBrain({ name: "Work" });
  assert.deepEqual(
    (await call("list_brains")).data.brains.map((item: { id: string }) => item.id),
    ["personal"],
  );
  const denied = await call("add_memory", { brain: work.id, content: "Billing is net 30" });
  assert.equal(denied.isError, true);
  assert.equal(denied.data.code, "not_found");

  brain.store.setClientBrains("cursor", ["personal", work.id]);
  assert.deepEqual(
    (await call("list_brains")).data.brains.map((item: { id: string }) => item.id),
    ["personal", work.id],
  );
  const added = await call("add_memory", { brain: work.id, content: "Billing is net 30" });
  assert.equal(added.isError, false);
  assert.equal(added.data.brain, work.id);
  const personal = await call("search_brain", { brain: "personal", query: "billing net" });
  assert.equal(personal.data.memories.length, 0);
  const found = await call("search_brain", { brain: work.id, query: "billing net" });
  assert.equal(found.data.memories[0].id, added.data.memory.id);

  brain.store.setClientBrains("cursor", [work.id]);
  const hidden = await call("search_brain", { brain: "personal", query: "billing" });
  assert.equal(hidden.data.code, "not_found");
});

test("other brain ids are not found", async () => {
  const { call } = await connect();
  const result = await call("search_brain", { query: "x", brain: "work" });
  assert.equal(result.isError, true);
  assert.equal(result.data.code, "not_found");
});

test("tool calls record reads and writes for the calling app", async () => {
  const { brain, call } = await connect("cursor");
  const added = await call("add_memory", { brain: "personal", content: "My cat is named Miso" });
  await call("search_brain", { brain: "personal", query: "cat name" });
  await call("get_memory", { brain: "personal", memoryId: added.data.memory.id });
  await call("search_brain", { brain: "work", query: "denied" });
  assert.deepEqual(
    brain.store.listSeenClients().map((client) => [client.id, client.name]),
    [["cursor", "cursor"]],
  );
  const rows = brain.store.listUsage("2000-01-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientId, "cursor");
  assert.equal(rows[0].brainId, "personal");
  assert.equal(rows[0].writes, 1);
  assert.equal(rows[0].reads, 2);
  assert.ok(rows[0].tokensIn > 0 && rows[0].tokensOut > 0);
});

test("add, search, update, versions, delete round trip with writer attribution", async () => {
  const { call } = await connect("cursor-vscode");
  const added = await call("add_memory", { brain: "personal", content: "My dog is named Bruno" });
  assert.equal(added.isError, false);
  assert.equal(added.data.memory.addedBy, "cursor");
  assert.equal(added.data.memory.versionCount, 1);
  const id = added.data.memory.id;

  const search = await call("search_brain", { brain: "personal", query: "dog name" });
  assert.equal(search.data.memories[0].id, id);
  assert.deepEqual(search.data.workspace, []);
  assert.equal(typeof search.data.memories[0].score, "number");

  const updated = await call("update_memory", { brain: "personal", memoryId: id, content: "My dog is named Max" });
  assert.equal(updated.data.memory.versionCount, 2);

  const versions = await call("get_memory_versions", { brain: "personal", memoryId: id });
  assert.equal(versions.data.versions.find((version: { current: boolean }) => version.current).writtenBy, "cursor");
  assert.deepEqual(
    versions.data.versions.map((version: { versionNumber: number; current: boolean }) => [version.versionNumber, version.current]),
    [[2, true], [1, false]],
  );

  const deleted = await call("delete_memory", { brain: "personal", memoryId: id });
  assert.equal(deleted.data.recoverable, true);
  const missing = await call("get_memory", { brain: "personal", memoryId: id });
  assert.equal(missing.data.code, "not_found");
});

test("unknown clients keep their app name on add and update", async () => {
  const { call } = await connect("some-agent");
  const added = await call("add_memory", { brain: "personal", content: "Prefers metric units" });
  assert.equal(added.data.memory.addedBy, "mcp");
  const id = added.data.memory.id;
  const updated = await call("update_memory", { brain: "personal", memoryId: id, content: "Prefers metric units in the kitchen" });
  assert.equal(updated.isError, false);
  const versions = await call("get_memory_versions", { brain: "personal", memoryId: id });
  const current = versions.data.versions.find((version: { current: boolean }) => version.current);
  assert.equal(current.writtenBy, "mcp");
  assert.equal(current.writerName, "some-agent");
});

test("Claude Desktop and Claude Code client names are attributed to claude", async () => {
  for (const clientName of ["claude-ai", "Claude Code", "claude-desktop-3p", "ClaudeDesktop", "remote-tools-bridge", "cowork-device-dispatch"]) {
    const { call } = await connect(clientName);
    const added = await call("add_memory", { brain: "personal", content: `Remembered from ${clientName} today` });
    assert.equal(added.data.memory.addedBy, "claude", clientName);
  }
});

test("search truncates long memories to 600 chars", async () => {
  const { call } = await connect();
  await call("add_memory", { brain: "personal", content: `Project notes: ${"launch ".repeat(200)}` });
  const search = await call("search_brain", { brain: "personal", query: "launch project notes" });
  assert.equal(search.data.memories[0].truncated, true);
  assert.equal(search.data.memories[0].content.length, 601);
});

test("update_memory with no fields is an invalid request", async () => {
  const { call } = await connect();
  const added = await call("add_memory", { brain: "personal", content: "Prefers metric units" });
  const result = await call("update_memory", { brain: "personal", memoryId: added.data.memory.id });
  assert.equal(result.data.code, "invalid_request");
});
