import { test } from "vitest";
import assert from "node:assert/strict";
import { keepRankedByThreshold } from "../src/search/threshold";

test("keeps every item above minScore and relative ratio when maxResults is omitted", () => {
  const kept = keepRankedByThreshold(
    [
      { id: "a", score: 1.0 },
      { id: "b", score: 0.92 },
      { id: "c", score: 0.86 },
      { id: "d", score: 0.7 },
      { id: "e", score: 0.5 },
      { id: "f", score: 0.2 },
    ],
    { minScore: 0.5, relativeRatio: 0.85 },
  );
  assert.deepEqual(
    kept.map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("slices after the threshold when maxResults is set", () => {
  const kept = keepRankedByThreshold(
    [
      { id: "a", score: 1.0 },
      { id: "b", score: 0.92 },
      { id: "c", score: 0.86 },
    ],
    { minScore: 0.5, relativeRatio: 0.85, maxResults: 2 },
  );
  assert.deepEqual(
    kept.map((item) => item.id),
    ["a", "b"],
  );
});

test("absolute minScore drops weak items even when they are the top hit", () => {
  const kept = keepRankedByThreshold(
    [
      { id: "a", score: 0.45 },
      { id: "b", score: 0.4 },
      { id: "c", score: 0.1 },
    ],
    { minScore: 0.5, relativeRatio: 0.85 },
  );
  assert.deepEqual(kept, []);
});
