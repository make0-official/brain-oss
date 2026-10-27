import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isTemporalQuery,
  memoryDateMatchScore,
  parseMemoryDates,
  scoreDocumentsBm25,
  tokenize,
} from "../src/search/lexical";

test("tokenize keeps meaningful two-character terms", () => {
  assert.deepEqual(tokenize("AI, JS and UK"), ["ai", "js", "and", "uk"]);
});

test("tokenize strips ordinal suffixes and keeps single-digit days", () => {
  assert.deepEqual(tokenize("March 15th 2024"), ["march", "15", "2024"]);
  assert.deepEqual(tokenize("3rd March 2024"), ["3", "march", "2024"]);
  assert.deepEqual(tokenize("5 March 2024"), ["5", "march", "2024"]);
});

test("tokenize still drops single-letter words", () => {
  assert.deepEqual(tokenize("I a job"), ["job"]);
});

test("parseMemoryDates reads ISO, prose, and numeric dates", () => {
  assert.deepEqual(parseMemoryDates("what happened on 2024-03-15"), [
    { year: 2024, month: 3, day: 15, iso: "2024-03-15" },
  ]);
  assert.equal(parseMemoryDates("married in March 2024")[0]?.month, 3);
  assert.equal(parseMemoryDates("married in March 2024")[0]?.year, 2024);
  assert.equal(parseMemoryDates("Married March 15, 2024")[0]?.iso, "2024-03-15");
  assert.equal(parseMemoryDates("Wedding date: 03/15/2024")[0]?.iso, "2024-03-15");
  assert.equal(parseMemoryDates("15 March 2024")[0]?.iso, "2024-03-15");
});

test("memoryDateMatchScore prefers a matching month over a year-only mention", () => {
  const query = "what happened on 2024-03-15";
  assert.equal(
    memoryDateMatchScore(query, "The user got married in March 2024."),
    0.7,
  );
  assert.equal(
    memoryDateMatchScore(query, "The user got married on March 15, 2024."),
    1,
  );
  assert.equal(
    memoryDateMatchScore(query, "The user visited Japan in 2024."),
    0,
  );
  assert.equal(
    memoryDateMatchScore("what do I prefer", "The user got married in March 2024."),
    0,
  );
});

test("BM25 ranks a March 2024 memory above a year-only 2024 memory for an ISO query", () => {
  const ranked = scoreDocumentsBm25("what happened on 2024-03-15", [
    {
      id: "wedding",
      text: "profile person Personal Info The user got married in March 2024.",
    },
    {
      id: "japan",
      text: "profile topic Travel The user visited Japan in 2024.",
    },
  ]);
  assert.equal(ranked[0]?.id, "wedding");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("BM25 keeps content words from a conversational marriage question", () => {
  const ranked = scoreDocumentsBm25("when did I get married", [
    {
      id: "wedding",
      text: "The user got married in March 2024.",
    },
    {
      id: "japan",
      text: "The user visited Japan in 2024.",
    },
  ]);
  assert.equal(ranked[0]?.id, "wedding");
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));
});

test("temporal when-questions boost memories that contain event dates", () => {
  assert.ok(isTemporalQuery("when did I get married"));
  assert.equal(
    memoryDateMatchScore("when did I get married", "The user got married in March 2024."),
    0.4,
  );
  assert.equal(
    memoryDateMatchScore("when did I get married", "The user prefers dark mode."),
    0,
  );
});

test("BM25 phrase terms prefer an exact two-word match", () => {
  const ranked = scoreDocumentsBm25("dark mode", [
    { id: "pref", text: "The user prefers dark mode in the editor." },
    { id: "other", text: "The user likes dark chocolate and airplane mode." },
  ]);
  assert.equal(ranked[0]?.id, "pref");
});
