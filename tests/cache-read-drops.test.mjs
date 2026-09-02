import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheReadDrops } from "../monitor/cache-read-drops.mjs";
import { mergeCodexContextSnapshot, parseCodexContextRecords } from "../monitor/providers/codex-context.mjs";

const agents = [
  { id: "primary", label: "Primary", role: "orchestrator" },
  { id: "fork", label: "Fork", role: "fork" },
];

function usage(id, timestamp, {
  actorId = "primary",
  input = 1_000,
  cacheRead = 9_000,
  cacheWrite = 0,
  output = 10,
  model = "gpt-5.6-sol",
  comparisonGroup = 0,
  cacheReadComparable = true,
  cacheReadPreviousAt = null,
  ...extra
} = {}) {
  return {
    dedupeId: id,
    actorId,
    timestamp,
    input,
    output,
    cacheRead,
    cacheWrite,
    model,
    comparisonGroup,
    cacheReadComparable,
    cacheReadPreviousAt,
    ...extra,
  };
}

function pair(options = {}) {
  const beforeAt = options.beforeAt || "2026-09-02T10:00:00.000Z";
  const afterAt = options.afterAt || "2026-09-02T10:05:00.000Z";
  return [
    usage("before", beforeAt, options.before),
    usage("after", afterAt, {
      ...options.after,
      cacheReadPreviousAt: Object.hasOwn(options.after || {}, "cacheReadPreviousAt")
        ? options.after.cacheReadPreviousAt
        : beforeAt,
    }),
  ];
}

function drops(usageSnapshots, options = {}) {
  return buildCacheReadDrops({
    sessionId: "codex-read-drop-test",
    agents,
    usageSnapshots,
    ...options,
  });
}

function codexTokenCount(timestamp, lastTokenUsage, eventId) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      event_id: eventId,
      info: {
        last_token_usage: lastTokenUsage,
        total_token_usage: { input_tokens: 900_000, output_tokens: 80_000, total_tokens: 980_000 },
      },
    },
  };
}

test("cold start has no inferred drop, while a complete read-zero pair does", () => {
  const cold = drops([usage("only", "2026-09-02T10:00:00.000Z")]);
  assert.equal(cold.status, "ready");
  assert.deepEqual(cold.items, []);

  const result = drops(pair({
    after: { input: 10_000, cacheRead: 0 },
  }));
  assert.equal(result.status, "ready");
  assert.equal(result.items[0].agentId, "primary");
  assert.equal(result.items[0].count, 1);
  assert.equal(result.items[0].occurrences[0].previousCacheReadPercent, 90);
  assert.equal(result.items[0].occurrences[0].cacheReadPercent, 0);
  assert.equal(result.items[0].occurrences[0].gapMs, 5 * 60_000);
});

test("counts both severe read drops when the second retains partial reuse above ten percent", () => {
  const times = ["2026-09-02T10:00:00.000Z", "2026-09-02T10:05:00.000Z", "2026-09-02T10:10:00.000Z", "2026-09-02T10:15:00.000Z"];
  const result = drops([
    usage("high-1", times[0], { input: 932, cacheRead: 118_528 }),
    usage("low-1", times[1], { input: 118_014, cacheRead: 3_840, cacheReadPreviousAt: times[0] }),
    usage("high-2", times[2], { input: 798, cacheRead: 133_888, cacheReadPreviousAt: times[1] }),
    usage("low-2", times[3], { input: 125_312, cacheRead: 17_792, cacheReadPreviousAt: times[2] }),
  ]);
  assert.equal(result.items[0].count, 2);
  assert.deepEqual(result.items[0].occurrences.map(({ previousCacheReadPercent, cacheReadPercent }) => (
    [previousCacheReadPercent, cacheReadPercent]
  )), [[99.2, 3.2], [99.4, 12.4]]);
});

test("includes the twenty-percent ceiling while preserving the cached-token collapse requirement", () => {
  for (const [cacheRead, expectedCount] of [[1_999, 1], [2_000, 1], [2_001, 0]]) {
    const result = drops(pair({
      before: { input: 0, cacheRead: 10_000 },
      after: { input: 10_000 - cacheRead, cacheRead },
    }));
    assert.equal(result.items[0]?.count ?? 0, expectedCount, String(cacheRead));
  }
  const insufficientCollapse = drops(pair({
    after: { input: 10_000, cacheRead: 2_000 },
  }));
  assert.deepEqual(insufficientCollapse.items, [], "a share below twenty percent still needs an eighty-percent cached-token collapse");
});

test("missing or false provenance markers reset the per-agent baseline", () => {
  const missing = usage("missing", "2026-09-02T10:05:00.000Z", {
    input: 9_000,
    cacheRead: 0,
    cacheReadComparable: undefined,
  });
  delete missing.cacheReadComparable;
  const falseMarker = usage("false", "2026-09-02T10:10:00.000Z", {
    input: 9_000,
    cacheRead: 0,
    cacheReadComparable: false,
  });
  const result = drops([usage("before", "2026-09-02T10:00:00.000Z"), missing, falseMarker]);
  assert.equal(result.status, "ready");
  assert.deepEqual(result.items, []);
  const legacyBefore = usage("legacy-before", "2026-09-02T10:00:00.000Z", { cacheComparable: true });
  const legacyAfter = usage("legacy-after", "2026-09-02T10:05:00.000Z", { input: 10_000, cacheRead: 0, cacheComparable: true, cacheReadPreviousAt: "2026-09-02T10:00:00.000Z" });
  delete legacyBefore.cacheReadComparable;
  delete legacyAfter.cacheReadComparable;
  assert.equal(drops([legacyBefore, legacyAfter]).status, "unavailable");
});

test("requires an actual cached-token drop, not only a diluted read percentage", () => {
  const diluted = drops(pair({
    after: { input: 90_000, cacheRead: 9_000 },
  }));
  assert.deepEqual(diluted.items, []);

  const threshold = drops(pair({
    before: { input: 1_000, cacheRead: 9_000 },
    after: { input: 16_200, cacheRead: 1_800 },
  }));
  assert.equal(threshold.items[0].count, 1);
  assert.equal(threshold.items[0].occurrences[0].cacheReadPercent, 10);
});

test("requires matching model, comparison group, adjacency proof, and no context boundary", () => {
  const cases = [
    { name: "model", after: { input: 10_000, cacheRead: 0, model: "gpt-5.5" } },
    { name: "empty model", after: { input: 10_000, cacheRead: 0, model: "" } },
    { name: "comparison group", after: { input: 10_000, cacheRead: 0, comparisonGroup: 1 } },
    { name: "missing predecessor", after: { input: 10_000, cacheRead: 0, cacheReadPreviousAt: null } },
    { name: "wrong predecessor", after: { input: 10_000, cacheRead: 0, cacheReadPreviousAt: "2026-09-02T09:59:00.000Z" } },
  ];
  for (const item of cases) assert.deepEqual(drops(pair(item)).items, [], item.name);
  const control = drops(pair({ beforeAt: "2026-09-02T10:00:00.000Z", afterAt: "2026-09-02T10:05:00.000Z", after: { input: 10_000, cacheRead: 0 } }));
  assert.equal(control.items[0].count, 1, "a clean high-to-low pair is eligible");
  const [sameBefore, sameAfter] = pair({
    afterAt: "2026-09-02T10:00:00.000Z",
    after: { input: 10_000, cacheRead: 0, cacheReadPreviousAt: "2026-09-02T10:00:00.000Z" },
  });
  assert.deepEqual(drops([sameBefore, sameAfter]).items, [], "same timestamp");
  const [reverseBefore, reverseAfter] = pair({
    beforeAt: "2026-09-02T10:05:00.000Z",
    afterAt: "2026-09-02T10:00:00.000Z",
    after: { input: 10_000, cacheRead: 0, cacheReadPreviousAt: "2026-09-02T10:05:00.000Z" },
  });
  assert.deepEqual(drops([reverseBefore, reverseAfter]).items, [], "reverse timestamp");

  const beforeAt = "2026-09-02T10:00:00.000Z";
  const afterAt = "2026-09-02T10:05:00.000Z";
  for (const boundary of [
    { agentId: "primary", timestamp: "2026-09-02T10:02:00.000Z", kind: "automatic_compaction" },
    { agentId: "primary", timestamp: "2026-09-02T10:02:00.000Z", kind: "snapshot_drop" },
  ]) {
    assert.deepEqual(drops(pair({ beforeAt, afterAt }), { boundaries: [boundary] }).items, [], boundary.kind);
  }
  assert.deepEqual(drops(pair({ beforeAt, afterAt }), {
    compactions: [{ actorId: "primary", timestamp: "2026-09-02T10:02:00.000Z", trigger: "auto" }],
  }).items, []);
  assert.deepEqual(drops(pair({ beforeAt, afterAt, after: { input: 9_000, cacheRead: 0 } })).items, [], "derived context reduction suppresses the comparison");
});

test("parser marks explicit zero reads, preserves context normalization, and resets adjacency on bad evidence", () => {
  const records = [
    { timestamp: "2026-09-02T09:00:00.000Z", type: "turn_context", payload: { turn_id: "read-drop", model: "gpt-5.6-sol" } },
    codexTokenCount("2026-09-02T09:00:01.000Z", { input_tokens: 1_000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 10 }, "explicit-before"),
    codexTokenCount("2026-09-02T09:00:02.000Z", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }, "explicit-zero"),
    codexTokenCount("2026-09-02T09:00:03.000Z", { input_tokens: 1_000, output_tokens: 10 }, "missing-read"),
    codexTokenCount("2026-09-02T09:00:04.000Z", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }, "after-missing"),
    codexTokenCount("2026-09-02T09:00:05.000Z", { input_tokens: 1_000, cached_input_tokens: 5_000, cache_write_input_tokens: 0, output_tokens: 10 }, "clamped-read"),
    codexTokenCount("2026-09-02T09:00:06.000Z", { input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: "not-a-token-count", output_tokens: 10 }, "malformed-write"),
    codexTokenCount("2026-09-02T09:00:07.000Z", { input_tokens: 1_000, cached_input_tokens: 900, output_tokens: 10 }, "missing-write"),
  ];
  const snapshots = parseCodexContextRecords(records, { actorId: "primary", sourceKey: "read-drop" }).usageSnapshots;
  assert.equal(snapshots.length, 7);
  assert.equal(snapshots[0].cacheReadComparable, true);
  assert.equal(snapshots[0].cacheReadPreviousAt, null);
  assert.equal(snapshots[1].cacheReadComparable, true);
  assert.equal(snapshots[1].cacheReadPreviousAt, snapshots[0].timestamp);
  assert.equal(snapshots[2].cacheReadComparable, false);
  assert.equal(snapshots[2].cacheRead, 0);
  assert.equal(snapshots[2].cacheReadPreviousAt, null);
  assert.equal(snapshots[3].cacheReadComparable, true);
  assert.equal(snapshots[3].cacheReadPreviousAt, null);
  assert.equal(snapshots[4].cacheReadComparable, false);
  assert.equal(snapshots[4].cacheRead, 1_000, "context normalization still clamps an overlarge cached count");
  assert.equal(snapshots[4].totalTokens > 0, true);
  assert.equal(snapshots[5].cacheReadComparable, false, "malformed write evidence cannot fake a zero write");
  assert.equal(snapshots[5].cacheWrite, 0);
  assert.equal(snapshots[6].cacheReadComparable, false, "missing write evidence cannot fake a zero write");
});

test("requires an original provider timestamp for read-comparable evidence", () => {
  const snapshots = parseCodexContextRecords([
    { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
    codexTokenCount(undefined, { input_tokens: 1_000, cached_input_tokens: 900, cache_write_input_tokens: 0, output_tokens: 10 }, "fallback-time"),
  ], { actorId: "primary", sourceKey: "fallback-time", fallbackTimestamp: "2026-09-02T09:00:00.000Z" }).usageSnapshots;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].timestamp, "2026-09-02T09:00:00.000Z");
  assert.equal(snapshots[0].cacheComparable, true);
  assert.equal(snapshots[0].cacheReadComparable, false);
  assert.equal(snapshots[0].cacheReadPreviousAt, null);
});

test("seeds only a verified live-tail overlap and never inherits an unproven model", () => {
  const initial = parseCodexContextRecords([
    { timestamp: "2026-09-02T09:00:00.000Z", type: "turn_context", payload: { turn_id: "tail", model: "gpt-5.6-sol" } },
    codexTokenCount("2026-09-02T09:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, cache_write_input_tokens: 0, output_tokens: 10 }, "anchor"),
  ], { actorId: "primary", sourceKey: "tail" });
  const anchor = initial.usageSnapshots[0];
  const tail = parseCodexContextRecords([
    codexTokenCount("2026-09-02T09:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, cache_write_input_tokens: 0, output_tokens: 10 }, "anchor"),
    codexTokenCount("2026-09-02T09:00:02.000Z", { input_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }, "new-low"),
  ], { actorId: "primary", sourceKey: "tail", priorUsageSnapshots: [anchor] });
  assert.equal(tail.usageSnapshots.at(-1).model, anchor.model);
  assert.equal(tail.usageSnapshots.at(-1).cacheReadPreviousAt, anchor.timestamp);
  assert.equal(drops(tail.usageSnapshots).items[0].count, 1);

  const noAnchor = parseCodexContextRecords([
    codexTokenCount("2026-09-02T09:00:02.000Z", { input_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }, "new-low"),
  ], { actorId: "primary", sourceKey: "tail-no-anchor" });
  assert.equal(drops(noAnchor.usageSnapshots).status, "unavailable");

  for (const modelRecord of [
    { model: null },
    { model: "gpt-5.5" },
  ]) {
    const defeated = parseCodexContextRecords([
      codexTokenCount("2026-09-02T09:00:01.000Z", { input_tokens: 10_000, cached_input_tokens: 9_000, cache_write_input_tokens: 0, output_tokens: 10 }, "anchor"),
      { timestamp: "2026-09-02T09:00:01.500Z", type: "turn_context", payload: modelRecord },
      codexTokenCount("2026-09-02T09:00:02.000Z", { input_tokens: 10_000, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 }, "new-low"),
    ], { actorId: "primary", sourceKey: "tail-defeated", priorUsageSnapshots: [anchor] });
    assert.deepEqual(drops(defeated.usageSnapshots).items, [], `explicit model ${String(modelRecord.model)} defeats inherited context`);
  }
});

test("retains proven read metadata when a live tail rereads an immutable request without context fields", () => {
  const previous = {
    dedupeId: "request-1", actorId: "primary", timestamp: "2026-09-02T09:00:02.000Z",
    input: 100, output: 10, cacheRead: 900, cacheWrite: 0, model: "gpt-5.6-sol", comparisonGroup: 3,
    cacheComparable: true, cacheReadComparable: true, cacheReadPreviousAt: "2026-09-02T08:59:01.000Z", cacheLifetime: "30m+",
  };
  const reread = { ...previous, model: "", comparisonGroup: 0, cacheReadPreviousAt: null };
  const merged = mergeCodexContextSnapshot(previous, reread);
  assert.equal(merged.model, previous.model);
  assert.equal(merged.comparisonGroup, previous.comparisonGroup);
  assert.equal(merged.cacheReadPreviousAt, previous.cacheReadPreviousAt);
  assert.equal(merged.cacheComparable, true);
  assert.equal(merged.cacheReadComparable, true);
});

test("invalid timestamps and numeric data are ineligible without an inferred drop", () => {
  const invalid = [
    usage("bad-time", "not-a-date"),
    usage("bad-input", "2026-09-02T10:05:00.000Z", { input: "9000" }),
    usage("bad-read", "2026-09-02T10:06:00.000Z", { cacheRead: -1 }),
    usage("bad-write", "2026-09-02T10:07:00.000Z", { cacheWrite: Number.NaN }),
  ];
  const result = drops([usage("before", "2026-09-02T10:00:00.000Z"), ...invalid, ...pair({
    beforeAt: "2026-09-02T10:10:00.000Z",
    afterAt: "2026-09-02T10:15:00.000Z",
    after: { input: 10_000, cacheRead: 0 },
  })]);
  assert.deepEqual(result.items, []);
});

test("deduplicates replayed requests and counts each new high-to-low transition once", () => {
  const [before, after] = pair({ after: { input: 10_000, cacheRead: 0 } });
  const result = drops([before, after, { ...after }, { ...after }]);
  assert.equal(result.items[0].count, 1);
  assert.equal(result.items[0].occurrences.length, 1);
});

test("counts distinct high-to-low transitions after reuse returns, but rejects conflicting same-time evidence", () => {
  const times = ["2026-09-02T10:00:00.000Z", "2026-09-02T10:05:00.000Z", "2026-09-02T10:10:00.000Z", "2026-09-02T10:15:00.000Z", "2026-09-02T10:20:00.000Z"];
  const snapshots = [
    usage("high-1", times[0]),
    usage("low-1", times[1], { input: 10_000, cacheRead: 0, cacheReadPreviousAt: times[0] }),
    usage("low-2", times[2], { input: 10_000, cacheRead: 0, cacheReadPreviousAt: times[1] }),
    usage("high-2", times[3], { cacheReadPreviousAt: times[2] }),
    usage("low-3", times[4], { input: 10_000, cacheRead: 0, cacheReadPreviousAt: times[3] }),
  ];
  assert.equal(drops(snapshots).items[0].count, 2);

  const [before, after] = pair({ after: { input: 10_000, cacheRead: 0 } });
  const conflicting = { ...after, dedupeId: "conflicting", cacheRead: 1_000, cacheReadPreviousAt: before.timestamp };
  assert.deepEqual(drops([before, after, conflicting]).items, [], "same-time conflicting evidence fails closed");
});

test("keeps baselines independent for visible agents and forks", () => {
  const result = drops([
    usage("primary-before", "2026-09-02T10:00:00.000Z", { actorId: "primary" }),
    usage("fork-low", "2026-09-02T10:02:00.000Z", { actorId: "fork", input: 9_000, cacheRead: 0, cacheReadPreviousAt: null }),
    usage("primary-after", "2026-09-02T10:05:00.000Z", { actorId: "primary", input: 10_000, cacheRead: 0, cacheReadPreviousAt: "2026-09-02T10:00:00.000Z" }),
  ]);
  assert.deepEqual(result.items.map(({ agentId, count }) => ({ agentId, count })), [{ agentId: "primary", count: 1 }]);
});

test("never labels a positive cache write as an inferred read drop", () => {
  for (const cacheWrite of [1, 8_000]) {
    const result = drops(pair({ after: { input: 10_000, cacheRead: 0, cacheWrite } }));
    assert.deepEqual(result.items, [], `cache write ${cacheWrite}`);
  }
});

test("caps each agent at 999 occurrences", () => {
  const snapshots = [];
  for (let index = 0; index < 1_005; index += 1) {
    const beforeAt = new Date(Date.parse("2026-09-02T10:00:00.000Z") + index * 2 * 60_000).toISOString();
    const afterAt = new Date(Date.parse(beforeAt) + 60_000).toISOString();
    snapshots.push(usage(`before-${index}`, beforeAt));
    snapshots.push(usage(`after-${index}`, afterAt, { input: 10_000, cacheRead: 0, cacheReadPreviousAt: beforeAt }));
  }
  const result = drops(snapshots);
  assert.equal(result.items[0].count, 999);
  assert.equal(result.items[0].occurrences.length, 999);
});
