import assert from "node:assert/strict";
import test from "node:test";
import { buildContextHistory } from "../monitor/context-history.mjs";

test("plots actual carried per-agent and all-agent context levels", () => {
  const timeline = buildContextHistory([
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
  assert.deepEqual(timeline.buckets.map((bucket) => bucket.total), [110, 160, 190, 190]);
  assert.deepEqual(timeline.buckets.at(-1).agents, [
    { agentId: "primary", total: 140 },
    { agentId: "subagent", total: 50 },
  ]);
});

test("keeps repeated snapshots flat and context reductions visible", () => {
  const timeline = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:25.000Z", cacheRead: 80 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:30.000Z",
    targetBuckets: 3,
  });

  assert.deepEqual(timeline.buckets.map((bucket) => bucket.total), [100, 100, 80, 80]);
});

test("keeps equal-total cache category transitions flat and out of history", () => {
  const timeline = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", cacheWrite: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", cacheRead: 100 },
  ], {
    startedAt: "2026-08-05T12:00:00.000Z",
    updatedAt: "2026-08-05T12:00:20.000Z",
    targetBuckets: 2,
  });

  assert.deepEqual(timeline.buckets.map((bucket) => bucket.total), [100, 100, 100]);
  assert.doesNotMatch(JSON.stringify(timeline), /cacheWrite|cacheRead|input|output/);
});

test("ignores invalid timestamps, unknown actors, and zero-valued snapshots", () => {
  const timeline = buildContextHistory([
    { actorId: "primary", timestamp: "not-a-date", input: 500 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:00.000Z", input: 0, output: 0 },
    { timestamp: "2026-08-05T12:01:00.000Z", input: 500 },
    { actorId: "primary", timestamp: "2026-08-05T12:02:00.000Z", input: Number.POSITIVE_INFINITY },
  ]);

  assert.deepEqual(timeline, { bucketMs: 0, buckets: [], boundaries: [] });
});

test("emits recognized compaction boundaries and suppresses duplicate inferred drops", () => {
  const history = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", input: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", input: 80 },
  ], {
    sessionId: "claude:private-provider-id",
    agentIds: ["primary"],
    compactions: [
      {
        actorId: "primary",
        timestamp: "2026-08-05T12:00:10.000Z",
        trigger: "auto",
        preTokens: 100,
        summary: "PRIVATE_MUST_NOT_LEAK",
      },
      {
        actorId: "primary",
        timestamp: "2026-08-05T12:00:20.000Z",
        trigger: "manual",
        preTokens: null,
      },
    ],
  });

  assert.deepEqual(history.boundaries.map(({ agentId, timestamp, kind, preTokens }) => ({ agentId, timestamp, kind, preTokens })), [
    {
      agentId: "primary",
      timestamp: "2026-08-05T12:00:10.000Z",
      kind: "automatic_compaction",
      preTokens: 100,
    },
    {
      agentId: "primary",
      timestamp: "2026-08-05T12:00:20.000Z",
      kind: "manual_compaction",
      preTokens: null,
    },
  ]);
  assert.match(history.boundaries[0].id, /^boundary-[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(history.boundaries), /private-provider-id|PRIVATE/);
});

test("bounds context boundaries to the newest 100 while returning chronological items", () => {
  const start = Date.parse("2026-08-05T12:00:00.000Z");
  const history = buildContextHistory([], {
    sessionId: "session",
    agentIds: ["primary"],
    compactions: Array.from({ length: 105 }, (_, index) => ({
      actorId: "primary",
      timestamp: new Date(start + index * 1_000).toISOString(),
      trigger: "manual",
      preTokens: null,
    })),
  });

  assert.equal(history.boundaries.length, 100);
  assert.equal(history.boundaries[0].timestamp, new Date(start + 5_000).toISOString());
  assert.equal(history.boundaries.at(-1).timestamp, new Date(start + 104_000).toISOString());
});

test("emits a deterministic snapshot-drop boundary when no compaction explains a decrease", () => {
  const history = buildContextHistory([
    { actorId: "primary", timestamp: "2026-08-05T12:00:05.000Z", input: 100 },
    { actorId: "primary", timestamp: "2026-08-05T12:00:15.000Z", input: 70 },
  ], { sessionId: "session", agentIds: ["primary"] });

  assert.deepEqual(history.boundaries.map(({ agentId, timestamp, kind, preTokens }) => ({ agentId, timestamp, kind, preTokens })), [{
    agentId: "primary",
    timestamp: "2026-08-05T12:00:15.000Z",
    kind: "snapshot_drop",
    preTokens: 100,
  }]);
});
