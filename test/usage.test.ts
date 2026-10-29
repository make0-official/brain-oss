import assert from "node:assert/strict";
import { test } from "vitest";
import { BrainStore } from "../src/store/store";
import { buildViewUsage } from "../src/view/usage";

test("usage adds up per client, brain, and UTC day", () => {
  let now = new Date("2026-10-28T23:30:00Z");
  const store = new BrainStore(":memory:", { now: () => now });
  const work = store.createBrain({ name: "Work" });

  store.recordUsage({ clientId: "cursor", brainId: "personal", reads: 3, tokensOut: 120 });
  store.recordUsage({ clientId: "cursor", brainId: "personal", reads: 2, tokensOut: 30 });
  store.recordUsage({ clientId: "claude-code", brainId: work.id, writes: 1, tokensIn: 40 });
  store.recordUsage({ clientId: "cursor", brainId: "missing", reads: 9 });
  store.recordUsage({ clientId: "cursor", brainId: "personal" });
  now = new Date("2026-10-29T08:00:00Z");
  store.recordUsage({ clientId: "cursor", brainId: "personal", reads: 1, tokensOut: 10 });

  assert.deepEqual(
    store.listUsage("2026-10-01").map((row) => [row.day, row.clientId, row.brainId, row.reads, row.writes, row.tokensOut]),
    [
      ["2026-10-28", "claude-code", work.id, 0, 1, 0],
      ["2026-10-28", "cursor", "personal", 5, 0, 150],
      ["2026-10-29", "cursor", "personal", 1, 0, 10],
    ],
  );

  const usage = buildViewUsage(store, 7, now);
  assert.equal(usage.days.length, 7);
  assert.equal(usage.days.at(-1), "2026-10-29");
  assert.deepEqual(usage.month, { reads: 6, writes: 1, tokensIn: 40, tokensOut: 160 });
  assert.deepEqual(usage.total.at(-1), { day: "2026-10-29", reads: 1, writes: 0, tokensIn: 0, tokensOut: 10 });
  assert.equal(usage.clients.find((client) => client.id === "cursor")?.name, "Cursor");
  assert.equal(usage.brains[work.id].month.writes, 1);
  assert.deepEqual(
    usage.series.map((entry) => [entry.clientId, entry.brainId, entry.points.reduce((sum, point) => sum + point.reads, 0)]),
    [
      ["claude-code", work.id, 0],
      ["cursor", "personal", 6],
    ],
  );
  store.close();
});
