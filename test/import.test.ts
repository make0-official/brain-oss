import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { rulesBlock } from "../src/init/clients";
import { extractWikilinks, parseFrontmatter, splitMarkdown } from "../src/import/markdown";
import { runImport, stdinImportFile } from "../src/import/run";
import { collectImportFiles, detectAgentFiles, sourceKindFor } from "../src/import/sources";
import { createTestBrain } from "./helpers";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "make0-import-"));
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeVault(): string {
  const vault = tempDir();
  write(path.join(vault, ".obsidian", "app.json"), "{}");
  write(path.join(vault, ".trash", "old.md"), "# Old\n\nShould never be imported at all.");
  write(
    path.join(vault, "People", "Bruno.md"),
    "---\ntags: [pets]\n---\n# Bruno\n\nBruno is my beagle. He was born in 2019 and loves the beach.",
  );
  write(
    path.join(vault, "Projects", "Launch.md"),
    "# Launch plan\n\nShow HN on Tuesday, then Reddit. Ask [[Bruno|the dog]] to pose for the demo GIF.",
  );
  return vault;
}

test("frontmatter tags parse in inline and list form", () => {
  assert.deepEqual(parseFrontmatter("---\ntags: [a, \"#b\"]\n---\nbody").frontmatter.tags, ["a", "b"]);
  assert.deepEqual(parseFrontmatter("---\ntitle: X\ntags:\n  - one\n  - two\n---\nbody").frontmatter, {
    title: "X",
    tags: ["one", "two"],
  });
});

test("short notes stay whole; long notes split by top headings", () => {
  assert.deepEqual(splitMarkdown("Bruno is my beagle and loves walks.", "Bruno"), [
    { key: "note", content: "# Bruno\n\nBruno is my beagle and loves walks." },
  ]);
  const long = `# Guide\n\n## Setup\n\n${"Install it. ".repeat(250)}\n\n## Usage\n\n${"Run it. ".repeat(300)}\n\n\`\`\`\n# not a heading\n\`\`\``;
  const sections = splitMarkdown(long, "Guide");
  assert.ok(sections.length >= 2);
  assert.ok(sections.every((section) => section.content.length <= 4000));
  assert.ok(sections.some((section) => section.key.startsWith("usage")));
});

test("wikilinks resolve aliases, headings, and folders; embeds skipped", () => {
  assert.deepEqual(extractWikilinks("See [[Bruno|dog]], [[People/Sam#Notes]], ![[image.png]]"), ["bruno", "sam"]);
});

test("source kinds by file name and vault", () => {
  assert.equal(sourceKindFor("/x/CLAUDE.md", false), "claude-md");
  assert.equal(sourceKindFor("/x/.cursor/rules/style.mdc", false), "cursor-rules");
  assert.equal(sourceKindFor("/x/notes/a.md", true), "obsidian");
  assert.equal(sourceKindFor("/x/notes/a.md", false), "markdown");
});

test("vault import: skips .obsidian/.trash, tags categories, links wikilinks", async () => {
  const brain = createTestBrain();
  const files = collectImportFiles(makeVault());
  assert.deepEqual(files.map((file) => file.name).sort(), ["Bruno", "Launch"]);
  const summary = await runImport(brain, files);
  assert.equal(summary.added, 2);
  const memories = brain.store.listMemories();
  const bruno = memories.find((memory) => memory.content.includes("beagle"))!;
  assert.equal(bruno.category, "Pets");
  assert.equal(bruno.originProvider, "make0");
  assert.equal(bruno.metadata.import?.source, "obsidian");
  assert.equal(memories.find((memory) => memory.content.includes("Show HN"))!.category, "Projects");
  assert.ok(brain.store.listEdges().some((edge) => edge.relationshipType === "references"));
});

test("re-import is idempotent; edits version; deleted stays deleted", async () => {
  const brain = createTestBrain();
  const vault = makeVault();
  await runImport(brain, collectImportFiles(vault));
  const again = await runImport(brain, collectImportFiles(vault));
  assert.equal(again.added, 0);
  assert.equal(again.unchanged, 2);

  write(path.join(vault, "People", "Bruno.md"), "# Bruno\n\nBruno is my beagle. He turned six and still loves the beach.");
  const edited = await runImport(brain, collectImportFiles(vault));
  assert.equal(edited.updated, 1);
  const bruno = brain.store.listMemories().find((memory) => memory.content.includes("turned six"))!;
  assert.equal(brain.getVersions(bruno.id).length, 2);

  brain.deleteMemory(bruno.id, "claude");
  const afterDelete = await runImport(brain, collectImportFiles(vault));
  assert.equal(afterDelete.skippedArchived, 1);
  assert.equal(brain.getMemory(bruno.id), undefined);
});

test("dump import never archives existing memories", async () => {
  const brain = createTestBrain();
  const kept = await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  await runImport(brain, [stdinImportFile("I dislike spicy food at dinner, it hurts my stomach.")]);
  assert.ok(brain.getMemory(kept.memory.id));
});

test("dry run changes nothing; big imports ask first", async () => {
  const brain = createTestBrain();
  const dry = await runImport(brain, collectImportFiles(makeVault()), { dryRun: true });
  assert.equal(dry.added, 0);
  assert.equal(brain.store.countMemories(), 0);

  const dir = tempDir();
  for (let index = 0; index < 205; index += 1) write(path.join(dir, `n${index}.md`), `Note number ${index} about topic ${index}.`);
  const aborted = await runImport(brain, collectImportFiles(dir), { confirm: async () => false });
  assert.equal(aborted.aborted, true);
  assert.equal(brain.store.countMemories(), 0);
});

test("agent rule files: detected, our rules block stripped", async () => {
  const home = tempDir();
  const cwd = tempDir();
  write(path.join(home, ".claude", "CLAUDE.md"), `# Global\n\nAlways use pnpm, never npm.\n\n${rulesBlock()}\n`);
  write(path.join(cwd, ".cursor", "rules", "style.mdc"), "Use 2-space indentation in TypeScript files.");
  const found = detectAgentFiles(home, cwd);
  assert.equal(found.length, 2);

  const brain = createTestBrain();
  await runImport(brain, found.flatMap(collectImportFiles));
  const contents = brain.store.listMemories().map((memory) => memory.content).join("\n");
  assert.match(contents, /pnpm/);
  assert.doesNotMatch(contents, /source of truth/);
  assert.equal(brain.store.listMemories()[0].category, "Agent Instructions");
});

test("extract mode stores facts and replaces them when the file changes", async () => {
  const brain = createTestBrain();
  let calls = 0;
  brain.llm.extract = async (_name, text) => {
    calls += 1;
    return text.includes("yarn")
      ? [{ content: "The user prefers yarn over npm.", category: "Tools", kind: "profile", entityType: "preference", confidence: 90 }]
      : [
          { content: "The user prefers pnpm over npm.", category: "Tools", kind: "profile", entityType: "preference", confidence: 90 },
          { content: "The user writes TypeScript in strict mode.", category: "Tools", kind: "profile", entityType: "preference", confidence: 90 },
        ];
  };
  const dir = tempDir();
  const file = path.join(dir, "AGENTS.md");
  write(file, "Use pnpm. TypeScript strict.");
  assert.equal((await runImport(brain, collectImportFiles(file), { extract: true })).added, 2);
  assert.equal((await runImport(brain, collectImportFiles(file), { extract: true })).unchanged, 2);
  assert.equal(calls, 1);

  write(file, "Use yarn.");
  const changed = await runImport(brain, collectImportFiles(file), { extract: true });
  assert.equal(changed.replaced, 2);
  assert.deepEqual(brain.store.listMemories().map((memory) => memory.content), ["The user prefers yarn over npm."]);
});

test("extract mode without a key fails clearly", async () => {
  await assert.rejects(runImport(createTestBrain(), [stdinImportFile("hello world text here")], { extract: true }), /API key/);
});
