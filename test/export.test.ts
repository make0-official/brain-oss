import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { buildBundle, writeMarkdownExport } from "../src/export/export";
import { runImport } from "../src/import/run";
import { collectImportFiles } from "../src/import/sources";
import { createTestBrain } from "./helpers";

async function seededBrain() {
  const brain = createTestBrain();
  const a = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  await brain.updateMemory(a.memory.id, { content: "My dog is named Bruno, a beagle" }, "cursor");
  const b = await brain.addMemory({ content: "I prefer window seats on flights", writer: "chatgpt" });
  brain.deleteMemory(b.memory.id, "chatgpt");
  brain.store.upsertEdge({ fromMemoryId: a.memory.id, toMemoryId: b.memory.id, relationshipType: "related_to", weight: 0.8 });
  return { brain, a, b };
}

test("bundle has archived memories, all versions, edges, and no embeddings", async () => {
  const { brain, a, b } = await seededBrain();
  const bundle = buildBundle(brain.store);
  assert.equal(bundle.format, "make0-brain-bundle");
  assert.equal(bundle.version, 1);
  assert.equal(bundle.memories.length, 2);
  assert.ok(bundle.memories.find((memory) => memory.id === b.memory.id)?.deletedAt);
  assert.ok(bundle.memories.every((memory) => !("embedding" in memory) && !("embeddingModel" in memory)));
  const versions = bundle.versions.filter((version) => version.memoryId === a.memory.id);
  assert.deepEqual(versions.map((version) => [version.versionNumber, version.writtenBy]), [[1, "claude"], [2, "cursor"]]);
  assert.equal(bundle.edges.length, 1);
  assert.equal(bundle.memories.find((memory) => memory.id === a.memory.id)?.originProvider, "claude");
});

test("markdown export writes live memories with frontmatter and re-imports", async () => {
  const { brain } = await seededBrain();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make0-export-"));
  assert.equal(writeMarkdownExport(brain.store, dir).files, 1);
  const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith(".md") && file !== "README.md");
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, files[0]), "utf8");
  assert.match(text, /^---\nid: /);
  assert.match(text, /addedBy: claude/);
  assert.match(text, /My dog is named Bruno, a beagle/);

  const fresh = createTestBrain();
  fs.rmSync(path.join(dir, "README.md"));
  await runImport(fresh, collectImportFiles(dir));
  assert.match(fresh.store.listMemories()[0].content, /Bruno, a beagle/);
});
