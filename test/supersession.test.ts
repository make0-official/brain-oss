import assert from "node:assert/strict";
import { test } from "vitest";
import { Brain } from "../src/brain";
import { HashingEmbeddingProvider } from "../src/embeddings/hashing";
import type { PairJudge } from "../src/llm/judge";
import type { MemoryEntityType } from "../src/shared/types";
import { BrainStore } from "../src/store/store";
import { buildMemoryList } from "../src/view/list";
import { resolveSupersession } from "../src/write/contradictions";
import { createTestBrain } from "./helpers";

type PairCase = {
  name: string;
  existing: string[];
  incoming: string;
  entityType?: MemoryEntityType;
  /** Existing memories the write must archive when no LLM judge is configured. */
  archived: string[];
  /**
   * The right answer is to replace or merge, but only a judge can tell.
   * Without one the rule is to keep both, never to guess.
   */
  needsJudge?: true;
};

/** Labelled pairs for the no-LLM rules. Add a row before changing a threshold or pattern. */
const PAIR_CASES: PairCase[] = [
  // Same statement, opposite polarity: the newer one replaces the older one.
  { name: "like, then dislike", existing: ["I like spicy food at dinner"], incoming: "I dislike spicy food at dinner", archived: ["I like spicy food at dinner"] },
  { name: "like, then don't like", existing: ["I like dark mode in my editor"], incoming: "I don't like dark mode in my editor", archived: ["I like dark mode in my editor"] },
  { name: "dislike, then like", existing: ["I dislike dark mode in my editor"], incoming: "I like dark mode in my editor", archived: ["I dislike dark mode in my editor"] },
  { name: "third person", existing: ["The user prefers TypeScript for backend services"], incoming: "The user avoids TypeScript for backend services", archived: ["The user prefers TypeScript for backend services"] },
  { name: "always, then never", existing: ["I always use tabs"], incoming: "I never use tabs", archived: ["I always use tabs"] },
  { name: "usually, then no longer", existing: ["I usually drink coffee in the morning"], incoming: "I no longer drink coffee in the morning", archived: ["I usually drink coffee in the morning"] },
  { name: "we like, then we avoid", existing: ["We like deploying on Fridays"], incoming: "We avoid deploying on Fridays", archived: ["We like deploying on Fridays"] },
  { name: "love, then hate", existing: ["I love long meetings"], incoming: "I hate long meetings", archived: ["I love long meetings"] },
  { name: "filler words do not count", existing: ["I like spicy food at dinner"], incoming: "I really dislike spicy food at dinner now", archived: ["I like spicy food at dinner"] },
  { name: "only the matching memory goes", existing: ["I like spicy food at dinner", "I like dark mode in my editor"], incoming: "I dislike spicy food at dinner", archived: ["I like spicy food at dinner"] },

  // Opposite polarity about a different thing: both are true, both stay.
  { name: "dark mode and light mode", existing: ["I like dark mode in my editor"], incoming: "I dislike light mode in my editor", archived: [] },
  { name: "pnpm and npm", existing: ["I always use pnpm for Node projects"], incoming: "I stopped using npm for Node projects", archived: [] },
  { name: "Go and Python", existing: ["I prefer tabs for indentation in Go code"], incoming: "I don't like tabs for indentation in Python code", archived: [] },
  { name: "morning and evening", existing: ["I like coffee in the morning"], incoming: "I dislike coffee in the evening", archived: [] },
  { name: "narrower scope", existing: ["I like spicy food"], incoming: "I dislike spicy food at dinner", archived: [] },
  { name: "short and long posts", existing: ["I prefer short LinkedIn posts"], incoming: "I avoid long LinkedIn posts", archived: [] },
  { name: "someone else's habit", existing: ["I like spicy food at dinner"], incoming: "My wife and I: I dislike that she skips spicy food at dinner", archived: [] },
  { name: "topic too short to compare", existing: ["I like it"], incoming: "I dislike it", archived: [] },

  // No polarity words: a changed value or a restatement. Kept without a judge.
  { name: "home city changed", existing: ["I live in Pune"], incoming: "I live in Bangalore", archived: [], needsJudge: true },
  { name: "database changed", existing: ["Our main database is Postgres"], incoming: "Our main database is MySQL", archived: [], needsJudge: true },
  { name: "reworded reversal", existing: ["I like dark mode in my editor"], incoming: "Light themes only for me now, dark mode is out", archived: [], needsJudge: true },
  { name: "restated with one change", existing: ["Make0 Brain launch plan: Show HN post and Reddit posts"], incoming: "Make0 Brain launch plan: Show HN post and X thread", archived: [], needsJudge: true },
  { name: "same preference twice", existing: ["I like dark mode in my editor"], incoming: "I love dark mode in my editor", archived: [], needsJudge: true },
  { name: "unrelated", existing: ["My dog is named Bruno"], incoming: "I work as a product designer at Acme", archived: [] },
  { name: "same category, different fact", existing: ["I like spicy food at dinner"], incoming: "I like dark mode in my editor", archived: [] },

  // Corrections replace the single closest memory.
  { name: "correction", existing: ["My home city is Pune"], incoming: "Correction: my home city is Bangalore, not Pune", entityType: "correction", archived: ["My home city is Pune"] },
  {
    name: "correction leaves near matches alone",
    existing: ["My home city is Pune", "My home office desk is in Pune city centre", "My parents' home city is Pune"],
    incoming: "Correction: my home city is Bangalore, not Pune",
    entityType: "correction",
    archived: ["My home city is Pune"],
  },
  { name: "correction about something not saved", existing: ["My home city is Pune", "My dog is named Bruno"], incoming: "Correction: the launch moved to December 5", entityType: "correction", archived: [] },
  {
    name: "correction with a loose match",
    existing: ["Make0 Brain positioning: one AI memory for every agent you use, local SQLite over MCP"],
    incoming: "Correction: Saurabh has never onboarded a design agency partner for Make0 Brain",
    entityType: "correction",
    archived: [],
  },
];

test.each(PAIR_CASES)("no-LLM supersession: $name", async ({ existing, incoming, entityType, archived }) => {
  const brain = createTestBrain();
  const contentById = new Map<string, string>();
  for (const content of existing) {
    contentById.set((await brain.addMemory({ content, writer: "claude" }, { supersede: "none" })).memory.id, content);
  }
  const result = await brain.addMemory({ content: incoming, entityType, writer: "cursor" });
  assert.deepEqual(result.supersededIds.map((id) => contentById.get(id)).sort(), [...archived].sort());
});

function brainWith(judge: PairJudge) {
  return new Brain({ store: new BrainStore(":memory:"), embeddings: new HashingEmbeddingProvider(), llm: { judge } });
}

test("the judge sees a reworded update that shares few words", async () => {
  const store = new BrainStore(":memory:");
  const base = { category: "Personal Info", kind: "profile", entityType: "person", embeddingModel: "m", originProvider: "claude" } as const;
  const near = store.createMemory({ ...base, content: "My home city is Pune", embedding: [1, 0, 0] });
  store.createMemory({ ...base, content: "My dog is named Bruno", embedding: [0, 1, 0] });
  const incoming = store.createMemory({ ...base, content: "I'm based in Bangalore now", embedding: [0.9, 0.4, 0] });

  const seen: string[] = [];
  const result = await resolveSupersession(incoming, store.listMemories(), {
    judge: async (existingContent) => {
      seen.push(existingContent);
      return { action: "contradict" };
    },
  });
  // Cosine 0.91 reaches the judge. Cosine 0.41 with no shared words does not.
  assert.deepEqual(seen, ["My home city is Pune"]);
  assert.deepEqual(result.archiveIds, [near.id]);
});

test("vectors from another embedding model are not compared", async () => {
  const store = new BrainStore(":memory:");
  const base = { category: "Personal Info", kind: "profile", entityType: "person", originProvider: "claude" } as const;
  store.createMemory({ ...base, content: "My home city is Pune", embedding: [1, 0, 0], embeddingModel: "old-model" });
  const incoming = store.createMemory({ ...base, content: "I'm based in Bangalore now", embedding: [1, 0, 0], embeddingModel: "m" });
  let calls = 0;
  await resolveSupersession(incoming, store.listMemories(), {
    judge: async () => {
      calls += 1;
      return { action: "contradict" };
    },
  });
  assert.equal(calls, 0);
});

test("a replaced memory records what replaced it, and restore clears that", async () => {
  const brain = createTestBrain();
  const first = await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  const second = await brain.addMemory({ content: "I dislike spicy food at dinner", writer: "cursor" });

  const archived = brain.getMemory(first.memory.id, { includeArchived: true });
  assert.equal(archived?.supersededBy, second.memory.id);
  assert.equal(archived?.deletedVia, "make0");
  assert.deepEqual(buildMemoryList(brain.store).archived[0].replacedBy, {
    id: second.memory.id,
    content: "I dislike spicy food at dinner",
    updatedBy: "cursor",
    writerName: null,
    archived: false,
  });

  assert.equal(brain.restoreMemory(first.memory.id)?.supersededBy, null);
});

test("a memory deleted by hand has no replacement", async () => {
  const brain = createTestBrain();
  const { memory } = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  brain.deleteMemory(memory.id, "claude");
  assert.equal(brain.getMemory(memory.id, { includeArchived: true })?.supersededBy, null);
  assert.equal(buildMemoryList(brain.store).archived[0].replacedBy, null);
});

test("an edit that now contradicts another memory archives that one", async () => {
  const brain = createTestBrain();
  const liked = await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  const other = await brain.addMemory({ content: "I enjoy long walks", writer: "claude" });

  const result = await brain.updateMemoryWithResult(other.memory.id, { content: "I dislike spicy food at dinner" }, "cursor");
  assert.deepEqual(result?.supersededIds, [liked.memory.id]);
  assert.equal(brain.getMemory(liked.memory.id, { includeArchived: true })?.supersededBy, other.memory.id);
  assert.deepEqual(brain.store.listMemories().map((memory) => memory.content), ["I dislike spicy food at dinner"]);
});

test("an edit keeps its text when the judge says merge", async () => {
  const brain = brainWith(async () => ({ action: "merge", mergedContent: "My dog is named Bruno, a beagle" }));
  const first = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" }, { supersede: "none" });
  const second = await brain.addMemory({ content: "I enjoy long walks", writer: "claude" }, { supersede: "none" });

  const result = await brain.updateMemoryWithResult(second.memory.id, { content: "My dog Bruno is a beagle" }, "cursor");
  assert.deepEqual(result?.supersededIds, [first.memory.id]);
  assert.equal(result?.memory.content, "My dog Bruno is a beagle");
});

test("edits that leave the text alone, or opt out, archive nothing", async () => {
  const brain = createTestBrain();
  await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  const other = await brain.addMemory({ content: "I enjoy long walks", writer: "claude" });

  const category = await brain.updateMemoryWithResult(other.memory.id, { category: "Food" }, "cursor");
  assert.deepEqual(category?.supersededIds, []);
  const optedOut = await brain.updateMemoryWithResult(other.memory.id, { content: "I dislike spicy food at dinner" }, "make0", null, { supersede: "none" });
  assert.deepEqual(optedOut?.supersededIds, []);
  assert.equal(brain.store.countMemories(), 2);
});
