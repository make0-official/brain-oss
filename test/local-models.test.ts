import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { LocalCrossEncoder, LocalEmbeddingProvider } from "../src/embeddings/local";
import { cosineSimilarity } from "../src/embeddings/provider";

// Downloads ~50MB of models on first run. Opt in with MAKE0_BRAIN_LOCAL_MODELS=1.
describe.skipIf(process.env.MAKE0_BRAIN_LOCAL_MODELS !== "1")("local models", () => {
  test("MiniLM embeddings put related text closer", { timeout: 240_000 }, async () => {
    const provider = new LocalEmbeddingProvider();
    const [a, b, c] = await provider.embed([
      "I prefer dark mode in every editor",
      "The user likes dark themes",
      "My dog is named Bruno",
    ]);
    assert.equal(a?.length, 384);
    assert.ok(cosineSimilarity(a!, b!) > cosineSimilarity(a!, c!));
  });

  test("cross-encoder ranks the relevant pair higher", { timeout: 240_000 }, async () => {
    const scorer = new LocalCrossEncoder();
    const [relevant, unrelated] = await scorer.score("what theme does the user like?", [
      "The user likes dark themes",
      "My dog is named Bruno",
    ]);
    assert.ok(relevant > unrelated);
    assert.ok(relevant >= 0 && relevant <= 1);
  });
});
