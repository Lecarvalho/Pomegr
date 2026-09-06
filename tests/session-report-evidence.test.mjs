import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheEvidence } from "../monitor/cache-events.mjs";
import { buildSessionReportEvidence } from "../monitor/session-report-evidence.mjs";
import { buildRequestSnapshots } from "../monitor/request-snapshots.mjs";

const start = Date.parse("2026-08-28T00:00:00.000Z");
const agents = [{ id: "primary" }, { id: "child" }];
function usage(index, overrides = {}) {
  return {
    actorId: "primary", dedupeId: "PRIVATE-request-" + index,
    timestamp: new Date(start + index * 1_000).toISOString(),
    input: 2, output: 3, cacheRead: 20_000, cacheWrite: 100,
    precedingWork: [{ kind: "read", count: 2 }], issuedWork: [{ kind: "test", count: 1 }],
    cacheComparable: true, cacheLifetime: "5m", comparisonGroup: 1,
    model: "PRIVATE-model", diagnostics: "PRIVATE-diagnostics", ...overrides,
  };
}
function report(usageSnapshots, { compactions = [], enabled = true, supported = true } = {}) {
  const cacheEvidence = buildCacheEvidence({ sessionId: "PRIVATE-session", agents, usageSnapshots, compactions, enabled });
  return {
    evidence: buildSessionReportEvidence({
      sessionId: "PRIVATE-session", agents, usageSnapshots, compactions,
      cacheEvidence, capabilities: { automaticCompactions: supported },
    }),
    feed: cacheEvidence.feed,
  };
}

test("report preserves exact request evidence before UI caps and includes a non-comparable next request", () => {
  const snapshots = [
    usage(0),
    usage(1, { cacheRead: 0, cacheWrite: 21_000, cacheMissReason: "messages_changed", cacheMessageChangeSequence: "post_tool_task_notification_resume" }),
    usage(2, { cacheComparable: false, cacheRead: 0, cacheWrite: 7 }),
    ...Array.from({ length: 120 }, (_, i) => usage(i + 3)),
    usage(1, { actorId: "child", input: 9 }),
  ];
  const { evidence, feed } = report(snapshots);
  assert.equal(buildRequestSnapshots({ agents, usageSnapshots: snapshots }).items.filter(x => x.agentId === "primary").length, 100);
  assert.equal(evidence.requestCount, 124);
  assert.equal(evidence.cache.possibleFullRefills, 1);
  const event = evidence.cache.transitions[0];
  assert.equal(event.requests.previous.observedAt, snapshots[0].timestamp);
  assert.equal(event.requests.current.observedAt, snapshots[1].timestamp);
  assert.equal(event.requests.next.observedAt, snapshots[2].timestamp);
  assert.equal(event.requests.next.cacheWriteTokens, 7);
  assert.equal(event.reason, "messages_changed");
  assert.equal(event.messageChangeSequence, "post_tool_task_notification_resume");
  assert.deepEqual(evidence.limits, { refillTransitions: 100, contextBoundaries: 100 });
  assert.equal(feed.possibleFullRefills[0].count, 1);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|dedupeId|comparisonGroup|diagnostics|cacheLifetimeInference|toolChangeAttribution/);
  for (const snapshot of Object.values(event.requests)) {
    assert.deepEqual(Object.keys(snapshot).sort(), ["agentId", "cacheLifetime", "cacheReadTokens", "cacheWriteTokens", "id", "observedAt", "outputTokens", "totalTokens", "uncachedInputTokens"]);
    assert.equal(snapshot.totalTokens, snapshot.uncachedInputTokens + snapshot.cacheReadTokens + snapshot.cacheWriteTokens + snapshot.outputTokens);
    assert.equal(Object.hasOwn(snapshot, "precedingWork"), false);
    assert.equal(Object.hasOwn(snapshot, "issuedWork"), false);
    assert.equal(Object.hasOwn(snapshot, "precedingAssociation"), false);
    assert.equal(Object.hasOwn(snapshot, "issuedAssociation"), false);
  }
});

test("report counts all retained events while bounding newest transition and boundary details", () => {
  const snapshots = Array.from({ length: 220 }, (_, i) => usage(i, i % 2 ? { cacheRead: 0, cacheWrite: 20_100 } : {}));
  const compactions = Array.from({ length: 105 }, (_, i) => ({
    actorId: "child", timestamp: new Date(start + i * 1000).toISOString(),
    trigger: "manual", preTokens: 50_000, summary: "PRIVATE-summary",
  }));
  const { evidence, feed } = report(snapshots, { compactions });
  assert.equal(evidence.cache.possibleFullRefills, 110);
  assert.equal(evidence.cache.refills, 110);
  assert.equal(evidence.cache.reuses, 109);
  assert.equal(evidence.cache.transitions.length, 100);
  assert.equal(evidence.cache.transitions[0].observedAt, snapshots[21].timestamp);
  assert.equal(evidence.context.manualCompactions, 105);
  assert.equal(evidence.context.boundaries.length, 100);
  assert.equal(evidence.context.boundaries[0].timestamp, compactions[5].timestamp);
  assert.equal(feed.items.length <= 20, true);
  assert.equal(evidence.context.boundaries.every(x => x.current === null), true);
  assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE|summary/);
});

test("unavailable and unsupported evidence are not represented as zero events", () => {
  const { evidence: empty } = report([]);
  assert.equal(empty.cache.status, "unavailable");
  assert.equal(empty.cache.refills, null);
  assert.equal(empty.context.automaticCompactions, null);
  assert.equal(empty.context.snapshotDrops, null);
  const { evidence: unsupported } = report([usage(0)], { enabled: false, supported: false });
  assert.equal(unsupported.cache.possibleFullRefills, null);
  assert.equal(unsupported.context.automaticCompactions, null);
  assert.equal(unsupported.context.manualCompactions, null);
  assert.equal(unsupported.context.snapshotDrops, 0);
  const { evidence: supported } = report([usage(0)]);
  assert.equal(supported.cache.possibleFullRefills, 0);
  assert.equal(supported.context.automaticCompactions, 0);
});

test("automatic/manual compactions suppress duplicate drops and retain only measured current levels", () => {
  const snapshots = [usage(0, { cacheRead: 100 }), usage(2, { cacheRead: 80 }), usage(4, { cacheRead: 60 }), usage(6, { cacheRead: 50 })];
  const compactions = [
    { actorId: "primary", timestamp: new Date(start + 1000).toISOString(), trigger: "auto", preTokens: 500, content: "PRIVATE" },
    { actorId: "primary", timestamp: new Date(start + 3000).toISOString(), trigger: "manual", preTokens: null },
  ];
  const { evidence } = report(snapshots, { compactions });
  assert.equal(evidence.context.automaticCompactions, 1);
  assert.equal(evidence.context.manualCompactions, 1);
  assert.equal(evidence.context.snapshotDrops, 1);
  assert.deepEqual(evidence.context.boundaries.map(x => x.kind), ["automatic_compaction", "manual_compaction", "snapshot_drop"]);
  assert.equal(evidence.context.boundaries[0].current, null);
  assert.equal(evidence.context.boundaries[1].preTokens, null);
  assert.equal(evidence.context.boundaries[2].current.observedAt, snapshots[3].timestamp);
  assert.doesNotMatch(JSON.stringify(evidence), /precedingWork|issuedWork|precedingAssociation|issuedAssociation/);
});

test("duplicate request identities use the newest normalized observation and do not leak invalid output", () => {
  const baseline = usage(0);
  const old = usage(1, { cacheRead: 0, cacheWrite: 25_000 });
  const newer = { ...old, timestamp: new Date(start + 2000).toISOString(), output: 17 };
  const { evidence } = report([baseline, old, newer]);
  assert.equal(evidence.requestCount, 2);
  assert.equal(evidence.cache.transitions.length, 1);
  assert.equal(evidence.cache.transitions[0].requests.current.outputTokens, 17);
  assert.equal(evidence.cache.transitions[0].requests.next, null);
  const { evidence: invalid } = report([baseline, usage(1, { cacheRead: 0, cacheWrite: 25_000, output: -1 })]);
  assert.equal(invalid.requestCount, 1);
  assert.equal(invalid.cache.transitions[0].requests.current, null);
});

test("equal timestamp successors do not invent ordering", () => {
  const snapshots = [usage(0), usage(1, { cacheRead: 0, cacheWrite: 25_000 }), usage(2), usage(3, { timestamp: usage(2).timestamp })];
  const { evidence } = report(snapshots);
  assert.equal(evidence.cache.transitions[0].requests.next, null);
});

test("report aggregate counts precede the UI per-agent counter cap while report detail stays bounded", () => {
  const snapshots = Array.from({ length: 2105 }, (_, i) => usage(i, i % 2 ? { cacheRead: 0, cacheWrite: 20_100 } : {}));
  const { evidence, feed } = report(snapshots);
  assert.equal(feed.possibleFullRefills[0].count, 999);
  assert.equal(evidence.cache.possibleFullRefills, 1052);
  assert.equal(evidence.cache.transitions.length, 100);
  assert.equal(evidence.cache.transitions.at(-1).observedAt, snapshots[2103].timestamp);
});

test("exact normalized request identity survives cloned classifier inputs", () => {
  const snapshots = [usage(0), usage(1, { cacheRead: 0, cacheWrite: 21_000 }), usage(2)];
  const cacheEvidence = buildCacheEvidence({ sessionId: "session", agents, usageSnapshots: structuredClone(snapshots), enabled: true });
  const evidence = buildSessionReportEvidence({
    sessionId: "session", agents, usageSnapshots: snapshots, compactions: [],
    cacheEvidence, capabilities: { automaticCompactions: true },
  });
  assert.equal(evidence.cache.transitions[0].requests.current.cacheWriteTokens, 21_000);
  assert.equal(evidence.cache.transitions[0].requests.previous.cacheReadTokens, 20_000);
  assert.equal(evidence.cache.transitions[0].requests.next.observedAt, snapshots[2].timestamp);
});
