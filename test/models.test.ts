import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { localModelsFor } from "../src/config";
import type { ModelProgressCallback, WarmableModel } from "../src/embeddings/local";
import { isModelCached, prefetchModels } from "../src/init/models";

function fakeModel(model: string, behavior: "download" | "cached" | "fail"): WarmableModel {
  return {
    model,
    async warmUp(onProgress?: ModelProgressCallback) {
      if (behavior === "fail") throw new Error("network down");
      const total = 23_000_000;
      for (const loaded of [0, 6_000_000, 12_000_000, 18_000_000, total]) {
        onProgress?.({ model, loaded, total, downloading: behavior === "download" });
      }
    },
  };
}

test("prefetch reports download progress, cache hits, and failures without throwing", async () => {
  const lines: string[] = [];
  const result = await prefetchModels(
    [
      fakeModel("Xenova/all-MiniLM-L6-v2", "download"),
      fakeModel("Xenova/ms-marco-MiniLM-L-6-v2", "cached"),
      fakeModel("other/model", "fail"),
    ],
    "/tmp/models",
    { log: (line) => lines.push(line) },
    { retryDelayMs: 0 },
  );
  assert.deepEqual(result, {
    ready: ["Xenova/all-MiniLM-L6-v2", "Xenova/ms-marco-MiniLM-L-6-v2"],
    failed: ["other/model"],
  });
  const text = lines.join("\n");
  assert.match(text, /Downloading local models to \/tmp\/models/);
  assert.match(text, /↓ Embedding model \(MiniLM\)  0%/);
  assert.match(text, /↓ Embedding model \(MiniLM\)  100%/);
  assert.match(text, /✓ Embedding model \(MiniLM\)  downloaded 23\.0 MB in/);
  assert.match(text, /✓ Reranker \(ms-marco MiniLM\)  already downloaded/);
  assert.doesNotMatch(text, /↓ Reranker/);
  assert.match(text, /… other\/model  network down; retrying \(2\/3\)/);
  assert.match(text, /… other\/model  network down; retrying \(3\/3\)/);
  assert.match(text, /✗ other\/model  could not download: network down/);
  assert.match(text, /try again on first use/);
});

test("prefetch on a TTY rewrites one progress line", async () => {
  const writes: string[] = [];
  await prefetchModels([fakeModel("Xenova/all-MiniLM-L6-v2", "download")], "/m", {
    log: () => {},
    write: (text) => writes.push(text),
  });
  assert.ok(writes.some((text) => text.startsWith("\r  ↓ Embedding model (MiniLM)  12.0 MB / 23.0 MB  52%")));
  assert.equal(writes.at(-1), "\r\x1b[2K");
});

test("prefetch with no models prints nothing", async () => {
  const lines: string[] = [];
  await prefetchModels([], "/m", { log: (line) => lines.push(line) });
  assert.deepEqual(lines, []);
});

test("localModelsFor matches the configured embedder", () => {
  assert.deepEqual(localModelsFor({}, "/m").map((model) => model.model), [
    "Xenova/all-MiniLM-L6-v2",
    "Xenova/ms-marco-MiniLM-L-6-v2",
  ]);
  assert.deepEqual(localModelsFor({ MAKE0_BRAIN_EMBEDDINGS: "api" }, "/m").map((model) => model.model), [
    "Xenova/ms-marco-MiniLM-L-6-v2",
  ]);
  assert.deepEqual(localModelsFor({ MAKE0_BRAIN_EMBEDDINGS: "hashing" }, "/m"), []);
});

test("files already on disk count as downloaded, even if the loader says download", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "make0-models-"));
  const model = "Xenova/all-MiniLM-L6-v2";
  assert.equal(isModelCached(dir, model), false);
  for (const file of ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"]) {
    fs.mkdirSync(path.dirname(path.join(dir, model, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, model, file), "x");
  }
  assert.equal(isModelCached(dir, model), true);
  const lines: string[] = [];
  await prefetchModels([fakeModel(model, "download")], dir, { log: (line) => lines.push(line) });
  assert.match(lines.join("\n"), /Checking local models/);
  assert.match(lines.join("\n"), /✓ Embedding model \(MiniLM\)  already downloaded/);
  assert.doesNotMatch(lines.join("\n"), /↓/);
});

test("a transient download failure is retried and then succeeds", async () => {
  let attempts = 0;
  const flaky: WarmableModel = {
    model: "Xenova/ms-marco-MiniLM-L-6-v2",
    async warmUp(onProgress) {
      attempts += 1;
      if (attempts === 1) throw new Error("fetch failed");
      onProgress?.({ model: this.model, loaded: 23_900_000, total: 23_900_000, downloading: true });
    },
  };
  const lines: string[] = [];
  const result = await prefetchModels([flaky], "/m", { log: (line) => lines.push(line) }, { retryDelayMs: 0 });
  assert.equal(attempts, 2);
  assert.deepEqual(result.failed, []);
  assert.match(lines.join("\n"), /fetch failed; retrying \(2\/3\)/);
  assert.match(lines.join("\n"), /✓ Reranker \(ms-marco MiniLM\)  downloaded 23\.9 MB/);
});
