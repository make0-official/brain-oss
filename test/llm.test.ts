import assert from "node:assert/strict";
import { test } from "vitest";
import { Brain } from "../src/brain";
import { HashingEmbeddingProvider, LexicalPairScorer } from "../src/embeddings/hashing";
import { parseMemoryClassification } from "../src/llm/classify";
import { LlmClient, resolveLlmConfig, samplingParams } from "../src/llm/client";
import { parseExtractedNodes } from "../src/llm/extract";
import { memoryPairMergedContentIsEntailed, parseMemoryPairVerdict, type PairJudge } from "../src/llm/judge";
import { parseMemoryKeepIds } from "../src/llm/retrieval";
import { rankMemoriesForQuery } from "../src/search/rank";
import { BrainStore } from "../src/store/store";

test("resolveLlmConfig: no key means local-only", () => {
  assert.equal(resolveLlmConfig({}), null);
});

test("resolveLlmConfig picks OpenRouter or OpenAI defaults", () => {
  const openRouter = resolveLlmConfig({ OPENROUTER_API_KEY: "sk-or-abc" })!;
  assert.equal(openRouter.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(openRouter.model, "openai/gpt-6-luna");
  const openAi = resolveLlmConfig({ OPENAI_API_KEY: "sk-abc", MAKE0_BRAIN_LLM_MODEL: "gpt-x" })!;
  assert.equal(openAi.baseUrl, "https://api.openai.com/v1");
  assert.equal(openAi.model, "gpt-x");
  const custom = resolveLlmConfig({ MAKE0_BRAIN_API_KEY: "k", MAKE0_BRAIN_BASE_URL: "http://localhost:11434/v1/" })!;
  assert.equal(custom.baseUrl, "http://localhost:11434/v1");
});

test("LlmClient sends JSON-mode chat and parses embeddings in order", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    const payload = url.endsWith("/embeddings")
      ? { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }
      : { choices: [{ message: { content: '{"ok":true}' } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new LlmClient(resolveLlmConfig({ OPENAI_API_KEY: "sk" })!, fakeFetch);
  assert.equal(await client.completeJson({ system: "s", user: "u", maxTokens: 10 }), '{"ok":true}');
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(requests[0].body.model, "gpt-6-luna");
  assert.equal(requests[0].body.reasoning_effort, "none");
  assert.equal(requests[0].body.max_completion_tokens, 10);
  assert.equal("temperature" in requests[0].body, false);
  assert.deepEqual(await client.embed(["a", "b"], 384), [[1], [2]]);
  assert.equal(requests[1].body.dimensions, 384);
});

test("non-GPT-6 models keep max_tokens and temperature 0", () => {
  assert.deepEqual(samplingParams("gpt-4.1-mini", 50), { max_tokens: 50, temperature: 0 });
  assert.deepEqual(samplingParams("llama3.1:8b", 50), { max_tokens: 50, temperature: 0 });
  assert.deepEqual(samplingParams("openai/gpt-6-luna", 50), { max_completion_tokens: 50, reasoning_effort: "none" });
});

test("LlmClient surfaces API errors", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })) as unknown as typeof fetch;
  const client = new LlmClient(resolveLlmConfig({ OPENAI_API_KEY: "sk" })!, fakeFetch);
  await assert.rejects(client.completeJson({ system: "s", user: "u", maxTokens: 10 }), /bad key/);
});

test("pair verdict keeps merged text only when every word comes from the inputs", () => {
  const a = "The user has a dog named Bruno";
  const b = "Bruno is the user's beagle";
  assert.equal(memoryPairMergedContentIsEntailed(a, b, "The user has a beagle named Bruno"), true);
  assert.equal(memoryPairMergedContentIsEntailed(a, b, "The user has a beagle named Bruno from Pune"), false);
  assert.deepEqual(parseMemoryPairVerdict('```json\n{"action":"contradict"}\n```', a, b), { action: "contradict" });
  assert.deepEqual(parseMemoryPairVerdict('{"action":"merge","mergedContent":"Bruno from Pune is a cat"}', a, b), {
    action: "merge",
  });
  assert.equal(parseMemoryPairVerdict('{"action":"maybe"}', a, b), null);
});

test("classification and keep-list parsers match cloud rules", () => {
  assert.deepEqual(parseMemoryClassification('{"category":"Food","kind":"work","entityType":"preference"}'), {
    category: "Food",
    kind: "profile",
    entityType: "preference",
  });
  assert.equal(parseMemoryClassification('{"kind":"x"}'), null);
  assert.deepEqual(parseMemoryKeepIds('{"keep":[2,"c",9]}', new Set(["a", "b", "c"]), ["a", "b", "c"]), ["b", "c"]);
});

test("extracted nodes drop fragments, low confidence, and assistant chatter", () => {
  const nodes = parseExtractedNodes(
    JSON.stringify({
      nodes: [
        { content: "The user prefers pnpm over npm for every project.", category: "Tools", entityType: "preference", confidence: 90 },
        { content: "Prefers pnpm over npm for every project.", confidence: 90 },
        { content: "The user maybe likes tabs over spaces in code.", confidence: 40 },
        { content: "The assistant should always answer briefly.", confidence: 95 },
      ],
    }),
  );
  assert.deepEqual(nodes.map((node) => node.content), ["The user prefers pnpm over npm for every project."]);
});

function brainWith(judge: PairJudge) {
  return new Brain({
    store: new BrainStore(":memory:"),
    embeddings: new HashingEmbeddingProvider(),
    pairScorer: new LexicalPairScorer(),
    llm: { judge },
  });
}

test("pair judge merges a restated memory into one", async () => {
  const brain = brainWith(async () => ({ action: "merge", mergedContent: "My dog is named Bruno, a beagle" }));
  const first = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude" });
  const second = await brain.addMemory({ content: "My dog Bruno is a beagle", writer: "cursor" });
  assert.deepEqual(second.supersededIds, [first.memory.id]);
  assert.equal(second.memory.content, "My dog is named Bruno, a beagle");
  assert.equal(second.memory.lastWrittenVia, "make0");
  assert.equal(second.memory.originProvider, "cursor");
  assert.equal(brain.getVersions(second.memory.id).length, 2);
});

test("a distinct verdict overrides the heuristic", async () => {
  const brain = brainWith(async () => ({ action: "distinct" }));
  await brain.addMemory({ content: "I like spicy food at dinner", writer: "claude" });
  const second = await brain.addMemory({ content: "I dislike spicy food at dinner", writer: "claude" });
  assert.deepEqual(second.supersededIds, []);
});

test("an LLM classifier fills category when the caller omits it", async () => {
  const brain = new Brain({
    store: new BrainStore(":memory:"),
    embeddings: new HashingEmbeddingProvider(),
    llm: { classify: async () => ({ category: "Pets", kind: "profile", entityType: "topic" }) },
  });
  const { memory } = await brain.addMemory({ content: "My dog is named Bruno", writer: "claude", entityType: "person" });
  assert.equal(memory.category, "Pets");
  assert.equal(memory.entityType, "person");
});

test("LLM filter drops candidates it does not keep; failure falls back", async () => {
  const memories = [
    { id: "a", text: "My dog is named Bruno", embedding: null },
    { id: "b", text: "My dog walker is Sam", embedding: null },
  ];
  const kept = await rankMemoriesForQuery("dog name", memories, {
    queryEmbedding: null,
    minResults: 0,
    llmHooks: { filterKeepIds: async () => ["a"], rerank: async () => null },
  });
  assert.deepEqual(kept.map((item) => item.id), ["a"]);

  const fallback = await rankMemoriesForQuery("dog", memories, {
    queryEmbedding: null,
    minResults: 0,
    minScore: 0,
    relativeRatio: 0,
    llmHooks: {
      filterKeepIds: async () => {
        throw new Error("down");
      },
      rerank: async () => null,
    },
  });
  assert.equal(fallback.length, 2);
});
