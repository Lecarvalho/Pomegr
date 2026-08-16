import assert from "node:assert/strict";
import test from "node:test";
import { buildContextHistory } from "../monitor/context-history.mjs";

test("carries actual per-agent context levels and exposes their all-agent sum", () => {
  const history = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", input: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:08.000Z", input: 110 },
    { actorId: "subagent", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 50 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:25.000Z", input: 140 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:30.000Z",
    targetBuckets: 3,
  });

  assert.equal(history.bucketMs, 10_000);
  assert.deepEqual(history.buckets.map((bucket) => bucket.total), [110, 160, 190, 190]);
  assert.deepEqual(history.buckets.at(-1).agents, [
    { agentId: "primary", total: 140 },
    { agentId: "subagent", total: 50 },
  ]);
});

test("shows repeated snapshots as flat levels and context reductions as decreases", () => {
  const history = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:25.000Z", cacheRead: 80 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:30.000Z",
    targetBuckets: 3,
  });

  assert.deepEqual(history.buckets.map((bucket) => bucket.total), [100, 100, 80, 80]);
});

test("keeps equal-total cache category transitions flat and omits category history", () => {
  const history = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheWrite: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 100 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:20.000Z",
    targetBuckets: 2,
  });

  assert.deepEqual(history.buckets.map((bucket) => bucket.total), [100, 100, 100]);
  assert.doesNotMatch(JSON.stringify(history), /cacheRead|cacheWrite|input|output/);
});

test("ignores invalid observations", () => {
  assert.deepEqual(buildContextHistory([
    { actorId: "primary", timestamp: "not-a-date", input: 500 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:00.000Z", input: 0 },
    { timestamp: "2026-08-05T12:01:00.000Z", input: 500 },
  ]), { bucketMs: 0, buckets: [], boundaries: [] });
});
