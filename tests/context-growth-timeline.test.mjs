import assert from "node:assert/strict";
import test from "node:test";
import { buildContextGrowthTimeline } from "../monitor/context-growth-timeline.mjs";

test("plots changes between carried agent snapshots instead of summing snapshots", () => {
  const timeline = buildContextGrowthTimeline([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", input: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:08.000Z", input: 110 },
    { actorId: "subagent", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 50 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:25.000Z", input: 140 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:30.000Z",
    targetBuckets: 3,
  });

  assert.equal(timeline.bucketMs, 10_000);
  assert.deepEqual(timeline.buckets.map((bucket) => bucket.total), [110, 50, 30, 0]);
});

test("does not treat repeated snapshots or context reductions as new context", () => {
  const timeline = buildContextGrowthTimeline([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:25.000Z", cacheRead: 80 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:30.000Z",
    targetBuckets: 3,
  });

  assert.deepEqual(timeline.buckets.map((bucket) => bucket.total), [100, 0, 0, 0]);
});

test("offsets category transitions before attributing context growth", () => {
  const timeline = buildContextGrowthTimeline([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheWrite: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 110 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:20.000Z",
    targetBuckets: 2,
  });

  assert.deepEqual(timeline.buckets[1], {
    start: "2026-08-05T12:00:10.000Z",
    end: "2026-08-05T12:00:20.000Z",
    total: 10,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 10,
  });
});

test("ignores invalid timestamps, unknown actors, and zero-valued snapshots", () => {
  const timeline = buildContextGrowthTimeline([
    { actorId: "primary", timestamp: "not-a-date", input: 500 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:00.000Z", input: 0, output: 0 },
    { timestamp: "2026-08-05T12:01:00.000Z", input: 500 },
    { actorId: "primary", timestamp: "2026-08-05T12:02:00.000Z", input: Number.POSITIVE_INFINITY },
  ]);

  assert.deepEqual(timeline, { bucketMs: 0, buckets: [] });
});
