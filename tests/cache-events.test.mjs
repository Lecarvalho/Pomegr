import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheEvents, CACHE_EVENT_RULES } from "../monitor/cache-events.mjs";

const agent = { id: "primary", label: "Primary agent", kind: "orchestrator" };

function snapshot(id, timestamp, { input = 0, cacheRead = 0, cacheWrite = 0, model = "model", group = 0 } = {}) {
  return {
    dedupeId: id,
    actorId: "primary",
    timestamp,
    input,
    output: 10,
    cacheRead,
    cacheWrite,
    model,
    comparisonGroup: group,
    cacheComparable: true,
  };
}

test("emits a bounded refill to first-reuse pair and an explicit miss-refill", () => {
  const feed = buildCacheEvents({
    sessionId: "codex:thread",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("refill", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheWrite: 8_000 }),
      snapshot("reuse", "2026-08-10T10:05:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("extra-reuse", "2026-08-10T10:06:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("miss", "2026-08-10T10:36:00.000Z", { input: 1_000, cacheRead: 500, cacheWrite: 8_500 }),
    ],
  });

  assert.equal(feed.status, "ready");
  assert.deepEqual(feed.items.map((event) => event.kind), ["miss_refill", "reuse", "refill"]);
  const [miss, reuse, refill] = feed.items;
  assert.equal(miss.promptInputTokens, 10_000);
  assert.equal(miss.cacheReadPercent, 5);
  assert.equal(miss.previousCacheReadPercent, 90);
  assert.equal(miss.gapMs, 30 * 60 * 1_000);
  assert.equal(reuse.relatedEventId, refill.id);
  assert.equal(reuse.gapMs, 5 * 60 * 1_000);
  assert.match(refill.id, /^cache-[a-f0-9]{16}$/);
  assert.doesNotMatch(JSON.stringify(feed), /codex:thread|dedupeId|model/);
});

test("does not infer a miss without a recorded large refill", () => {
  const feed = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [
      snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_000, cacheRead: 9_000 }),
      snapshot("after", "2026-08-10T10:30:00.000Z", { input: 9_500, cacheRead: 500, cacheWrite: 7_999 }),
    ],
  });
  assert.deepEqual(feed, { status: "ready", items: [] });
});

test("enforces comparison boundaries and cache event thresholds", () => {
  const base = snapshot("before", "2026-08-10T10:00:00.000Z", { input: 1_600, cacheRead: 6_400 });
  const qualifying = snapshot("after", "2026-08-10T10:30:00.000Z", { input: 100, cacheRead: 800, cacheWrite: 8_000 });
  const valid = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [base, qualifying] });
  assert.equal(valid.items[0].kind, "miss_refill");
  for (const current of [
    { ...qualifying, timestamp: "2026-08-10T10:29:59.999Z" },
    { ...qualifying, model: "other" },
    { ...qualifying, comparisonGroup: 1 },
  ]) {
    const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots: [base, current] });
    assert.equal(feed.items.some((event) => event.kind === "miss_refill"), false);
  }
  const compacted = buildCacheEvents({
    sessionId: "session",
    agents: [agent],
    enabled: true,
    usageSnapshots: [base, qualifying],
    compactions: [{ actorId: "primary", timestamp: "2026-08-10T10:15:00.000Z", trigger: "manual" }],
  });
  assert.equal(compacted.items.some((event) => event.kind === "miss_refill"), false);
  assert.equal(CACHE_EVENT_RULES.maximumSessionEvents, 20);
});

test("returns unavailable without classifiable evidence and caps newest session events", () => {
  assert.deepEqual(buildCacheEvents({ agents: [agent], enabled: false }), { status: "unavailable", items: [] });
  assert.deepEqual(buildCacheEvents({ agents: [agent], enabled: true, usageSnapshots: [
    { ...snapshot("bad", "2026-08-10T10:00:00.000Z", { cacheWrite: 8_000 }), cacheComparable: false },
  ] }), { status: "unavailable", items: [] });

  const usageSnapshots = Array.from({ length: 25 }, (_, index) => snapshot(
    `refill-${index}`,
    new Date(Date.parse("2026-08-10T10:00:00.000Z") + index * 1_000).toISOString(),
    { input: 1_000, cacheWrite: 8_000 },
  ));
  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.equal(feed.items.length, 20);
  assert.equal(feed.items[0].observedAt, usageSnapshots.at(-1).timestamp);
});

test("never retains a reuse whose related refill falls outside the event cap", () => {
  const startedAt = Date.parse("2026-08-10T10:00:00.000Z");
  const usageSnapshots = [
    snapshot("paired-refill", new Date(startedAt).toISOString(), { input: 1_000, cacheWrite: 8_000 }),
    snapshot("paired-reuse", new Date(startedAt + 60_000).toISOString(), { input: 1_000, cacheRead: 9_000 }),
    ...Array.from({ length: 19 }, (_, index) => snapshot(
      `later-refill-${index}`,
      new Date(startedAt + (index + 2) * 60_000).toISOString(),
      { input: 1_000, cacheWrite: 8_000 },
    )),
  ];

  const feed = buildCacheEvents({ sessionId: "session", agents: [agent], enabled: true, usageSnapshots });
  assert.equal(feed.items.length, 19);
  assert.equal(feed.items.some((event) => event.kind === "reuse"), false);
  assert.equal(feed.items.every((event) => (
    event.kind !== "reuse" || feed.items.some((related) => related.id === event.relatedEventId)
  )), true);
});
