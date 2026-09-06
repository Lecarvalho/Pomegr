import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestModelObservations, buildRequestSnapshots } from "../monitor/request-snapshots.mjs";
import { WORK_KINDS } from "../monitor/work-kind.mjs";

const agents = [{ id: "primary" }, { id: "child" }];

test("sanitizes request work again at projection and derives association labels from surviving counts", () => {
  const evidence = snapshot("one", "primary", "2026-08-10T10:00:00.000Z", { input: 1 });
  evidence.precedingWork = [
    { kind: "read", count: 800, input: "PRIVATE_INPUT" }, { kind: "read", count: 400 },
    { kind: "test", count: 2, tool: "PRIVATE_TOOL_NAME" }, { kind: "PRIVATE_KIND", count: 5 },
    ...[0, -1, 1.5, "2", NaN, Infinity].map((count) => ({ kind: "shell", count })), null,
  ];
  evidence.issuedWork = WORK_KINDS.map((kind, index) => ({ kind, count: index + 1 }));
  const item = buildRequestSnapshots({ agents, usageSnapshots: [evidence] }).items[0];
  assert.deepEqual(item.precedingWork, [{ kind: "read", count: 999 }, { kind: "test", count: 2 }]);
  assert.equal(item.precedingAssociation, "transcript_adjacency");
  assert.equal(item.issuedAssociation, "recorded_link");
  assert.deepEqual(item.issuedWork, evidence.issuedWork.slice(-8).reverse());
  assert.doesNotMatch(JSON.stringify(item), /PRIVATE|"tool":|"input":/);
  evidence.precedingWork = [{ kind: "unknown", count: 1 }];
  evidence.issuedWork = "PRIVATE_RAW_CONTENT";
  const empty = buildRequestSnapshots({ agents, usageSnapshots: [evidence] }).items[0];
  assert.deepEqual(empty.precedingWork, []);
  assert.deepEqual(empty.issuedWork, []);
  assert.equal(empty.precedingAssociation, null);
  assert.equal(empty.issuedAssociation, null);
});

function snapshot(dedupeId, actorId, timestamp, parts = {}) {
  return {
    dedupeId,
    actorId,
    timestamp,
    input: parts.input ?? 0,
    cacheWrite: parts.cacheWrite ?? 0,
    cacheRead: parts.cacheRead ?? 0,
    output: parts.output ?? 0,
    model: "PRIVATE_MODEL_MUST_NOT_LEAK",
    comparisonGroup: 7,
    totalTokens: 999_999_999,
    cacheLifetime: parts.cacheLifetime,
    privateProviderField: "PRIVATE_MUST_NOT_LEAK",
  };
}

test("normalizes independent chronological request snapshots with only recomputed request-local totals", () => {
  const feed = buildRequestSnapshots({
    sessionId: "provider:PRIVATE_SESSION_ID",
    agents,
    usageSnapshots: [
      snapshot("PRIVATE_PROVIDER_EVENT_TWO", "child", "2026-08-10T10:02:00-04:00", {
        input: 2_000, cacheWrite: 3_000, cacheRead: 4_000, output: 500, cacheLifetime: "5m",
      }),
      snapshot("PRIVATE_PROVIDER_EVENT_ONE", "primary", "2026-08-10T14:01:00.000Z", {
        input: 1_000, cacheWrite: 2_000, cacheRead: 3_000, output: 400, cacheLifetime: "mixed",
      }),
    ],
  });

  assert.equal(feed.status, "ready");
  assert.deepEqual(feed.items.map(({ agentId, observedAt, uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, totalTokens }) => ({
    agentId, observedAt, uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, totalTokens,
  })), [
    {
      agentId: "primary",
      observedAt: "2026-08-10T14:01:00.000Z",
      uncachedInputTokens: 1_000,
      cacheWriteTokens: 2_000,
      cacheReadTokens: 3_000,
      outputTokens: 400,
      totalTokens: 6_400,
    },
    {
      agentId: "child",
      observedAt: "2026-08-10T14:02:00.000Z",
      uncachedInputTokens: 2_000,
      cacheWriteTokens: 3_000,
      cacheReadTokens: 4_000,
      outputTokens: 500,
      totalTokens: 9_500,
    },
  ]);
  assert.equal(feed.items.every((item) => /^request-[a-f0-9]{16}$/.test(item.id)), true);
  assert.deepEqual(feed.items.map(({ cacheLifetime }) => cacheLifetime), ["mixed", "5m"]);
  assert.deepEqual(buildRequestSnapshots({
    sessionId: "provider:PRIVATE_SESSION_ID",
    agents,
    usageSnapshots: [snapshot("PRIVATE_PROVIDER_EVENT_ONE", "primary", "2026-08-10T14:01:00.000Z", { input: 1 })],
  }).items[0].id, buildRequestSnapshots({
    sessionId: "provider:PRIVATE_SESSION_ID",
    agents,
    usageSnapshots: [snapshot("PRIVATE_PROVIDER_EVENT_ONE", "primary", "2026-08-10T14:01:00.000Z", { input: 1 })],
  }).items[0].id);
  assert.doesNotMatch(JSON.stringify(feed), /PRIVATE|dedupeId|model|comparisonGroup|privateProviderField|999999999/);
});

test("exposes only allowlisted request cache lifetimes", () => {
  const usageSnapshots = [
    snapshot("five", "primary", "2026-08-10T10:00:00.000Z", { input: 1, cacheLifetime: "5m" }),
    snapshot("hour", "primary", "2026-08-10T10:01:00.000Z", { input: 1, cacheLifetime: "1h" }),
    snapshot("mixed", "child", "2026-08-10T10:02:00.000Z", { input: 1, cacheLifetime: "mixed" }),
    snapshot("minimum", "primary", "2026-08-10T10:02:30.000Z", { input: 1, cacheLifetime: "30m+" }),
    snapshot("private", "child", "2026-08-10T10:03:00.000Z", { input: 1, cacheLifetime: "PRIVATE_TTL" }),
  ];
  assert.deepEqual(
    buildRequestSnapshots({ sessionId: "session", agents, usageSnapshots }).items.map(({ cacheLifetime }) => cacheLifetime),
    ["5m", "1h", "mixed", "30m+", null],
  );
});

test("keeps model observations monitor-private and aligned to opaque request IDs", () => {
  const usageSnapshots = [snapshot("PRIVATE_PROVIDER_EVENT", "primary", "2026-08-10T14:01:00.000Z", { input: 1 })];
  const requestFeed = buildRequestSnapshots({ sessionId: "provider:session", agents, usageSnapshots });
  const modelObservations = buildRequestModelObservations({ sessionId: "provider:session", agents, usageSnapshots });

  assert.equal(modelObservations.length, 1);
  assert.equal(modelObservations[0].id, requestFeed.items[0].id);
  assert.equal(modelObservations[0].observedAt, requestFeed.items[0].observedAt);
  assert.equal(modelObservations[0].model, "PRIVATE_MODEL_MUST_NOT_LEAK");
  assert.doesNotMatch(JSON.stringify(requestFeed), /PRIVATE|model/i);
});

test("deduplicates internally and keeps the latest 100 valid snapshots per agent", () => {
  const start = Date.parse("2026-08-10T10:00:00.000Z");
  const usageSnapshots = agents.flatMap((agent) => Array.from({ length: 105 }, (_, index) => snapshot(
    `${agent.id}-${index}`,
    agent.id,
    new Date(start + index * 1_000 + (agent.id === "child" ? 1 : 0)).toISOString(),
    { input: index + 1 },
  )));
  usageSnapshots.push(snapshot("primary-104", "primary", "2026-08-10T11:00:00.000Z", { input: 777 }));

  const feed = buildRequestSnapshots({ sessionId: "session", agents, usageSnapshots });
  assert.equal(feed.items.filter((item) => item.agentId === "primary").length, 100);
  assert.equal(feed.items.filter((item) => item.agentId === "child").length, 100);
  assert.equal(feed.items.find((item) => item.agentId === "primary")?.uncachedInputTokens, 6);
  assert.equal(feed.items.at(-1)?.uncachedInputTokens, 777);
});

test("rejects invalid, all-zero, unknown-agent, and provider-cumulative-only evidence", () => {
  const feed = buildRequestSnapshots({
    sessionId: "session",
    agents,
    usageSnapshots: [
      snapshot("unknown", "unknown", "2026-08-10T10:00:00.000Z", { input: 1 }),
      snapshot("invalid-time", "primary", "not-a-date", { input: 1 }),
      snapshot("negative", "primary", "2026-08-10T10:00:00.000Z", { input: -1 }),
      snapshot("zero", "primary", "2026-08-10T10:00:00.000Z"),
      { actorId: "primary", timestamp: "2026-08-10T10:00:00.000Z", input: 1, cacheWrite: 0, cacheRead: 0, output: 0 },
      { dedupeId: "cumulative-only", actorId: "primary", timestamp: "2026-08-10T10:00:00.000Z", total_token_usage: 999_999 },
    ],
  });

  assert.deepEqual(feed, { status: "unavailable", items: [] });
});
