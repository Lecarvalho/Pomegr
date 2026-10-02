import assert from "node:assert/strict";
import test from "node:test";
import { sessionEvents } from "../../../../server/sessions/domain/session-events.mjs";
import {
  createSessionEventRecorder, createSessionEventRecording, derivedSessionEventRecord, mergeSessionEventRecord, normalizeSessionEventRecord, SESSION_EVENT_RECORD_LIMIT,
} from "../../../../server/sessions/domain/session-event-record.mjs";

const READY = { core: "ready", agentEvidence: "ready", activityEvidence: "ready" };

function at(minute, second = 0, millisecond = 0) {
  return new Date(Date.UTC(2026, 8, 30, 10, minute, second, millisecond)).toISOString();
}

test("a recorded refill or compaction outlives the evidence window that derived it", () => {
  const agents = [{ id: "primary", label: "Primary agent", status: "active" }];
  const feedOf = (...times) => ({ status: "ready", items: [], possibleFullRefills: [{ agentId: "primary", count: times.length, occurrences: times.map((observedAt) => ({ observedAt })) }] });
  const early = derivedSessionEventRecord({ cacheEvents: feedOf(at(1), at(2)), contextBoundaries: [{ agentId: "primary", timestamp: at(3), kind: "automatic_compaction" }] });
  // The window slid: the first refill and the compaction are no longer derived, a new refill is.
  const later = mergeSessionEventRecord(early, derivedSessionEventRecord({ cacheEvents: feedOf(at(2), at(8)), contextBoundaries: [] }));
  assert.deepEqual(sessionEvents({ readiness: READY, agents, eventRecord: later }).items.map((item) => [item.kind, item.at]),
    [["cache_refill", at(8)], ["context_compacted", at(3)], ["cache_refill", at(2)], ["cache_refill", at(1)]]);
  // An unavailable feed derives nothing and withdraws nothing.
  const quiet = mergeSessionEventRecord(later, derivedSessionEventRecord({ cacheEvents: { status: "unavailable" } }));
  assert.equal(quiet, later, "an unchanged union is the same object");
  // The same agent and time keeps one entry, with the later kind.
  const reclassified = mergeSessionEventRecord(later, { version: 1, refills: [{ at: at(8), agentId: "primary", kind: "lifetime_elapsed" }], compactions: [] });
  assert.deepEqual(reclassified.refills.map((item) => [item.at, item.kind]), [[at(1), "possible_full"], [at(2), "possible_full"], [at(8), "lifetime_elapsed"]]);
  // Each list keeps its newest entries.
  const many = derivedSessionEventRecord({ cacheEvents: feedOf(...Array.from({ length: SESSION_EVENT_RECORD_LIMIT + 20 }, (_, index) => new Date(Date.UTC(2026, 8, 30, 11, 0, index)).toISOString())) });
  assert.equal(many.refills.length, SESSION_EVENT_RECORD_LIMIT);
  assert.equal(many.refills[0].at, new Date(Date.UTC(2026, 8, 30, 11, 0, 20)).toISOString());
});

test("a persisted event record is validated as a whole and holds only times, agent IDs, and fixed kinds", () => {
  const valid = { version: 1, refills: [{ at: at(1), agentId: "primary", kind: "possible_full" }], compactions: [{ at: at(2), agentId: "agent-a", trigger: "manual" }] };
  assert.deepEqual(normalizeSessionEventRecord(valid), valid);
  const invalid = [
    null, [], { ...valid, version: 2 }, { ...valid, extra: 1 }, { version: 1, refills: [] },
    { ...valid, refills: [{ at: at(1), agentId: "primary", kind: "tools_changed" }] },
    { ...valid, refills: [{ at: at(1), agentId: "primary", kind: "possible_full", reason: "PRIVATE" }] },
    { ...valid, refills: [{ at: "2026-09-30T10:01:00Z", agentId: "primary", kind: "possible_full" }] },
    { ...valid, refills: [{ at: at(1), agentId: "C:\\private\\path", kind: "possible_full" }] },
    { ...valid, compactions: [{ at: at(2), agentId: "agent-a", trigger: "snapshot_drop" }] },
    { ...valid, compactions: [{ at: "soon", agentId: "agent-a", trigger: "manual" }] },
    { ...valid, refills: Array.from({ length: SESSION_EVENT_RECORD_LIMIT + 1 }, (_, index) => ({ at: new Date(Date.UTC(2026, 8, 30, 11, 0, index)).toISOString(), agentId: "primary", kind: "possible_full" })) },
  ];
  for (const value of invalid) assert.equal(normalizeSessionEventRecord(value), null, JSON.stringify(value)?.slice(0, 120));
});

test("the recorder merges into the sidecar on disk, never over it", async () => {
  const disk = new Map([["claude:kept", { version: 1, refills: [{ at: at(1), agentId: "primary", kind: "possible_full" }], compactions: [] }]]);
  let writes = 0;
  const store = {
    loadSessionEventRecord: async (providerId, localSessionId) => normalizeSessionEventRecord(disk.get(`${providerId}:${localSessionId}`)),
    writeSessionEventRecord: async (providerId, localSessionId, record) => { writes += 1; disk.set(`${providerId}:${localSessionId}`, structuredClone(record)); },
  };
  const recorder = createSessionEventRecorder({ store });
  assert.equal(recorder.recorded("claude:kept"), null, "not read yet");
  assert.equal(recorder.has("claude:kept"), false);
  // A record derived before the sidecar was read does not replace it.
  const derived = { version: 1, refills: [{ at: at(5), agentId: "primary", kind: "provider_diagnosed" }], compactions: [] };
  assert.equal(await recorder.record("claude:kept", derived), true);
  assert.deepEqual(disk.get("claude:kept").refills.map((item) => item.at), [at(1), at(5)]);
  assert.deepEqual(recorder.recorded("claude:kept").refills.map((item) => item.at), [at(1), at(5)]);
  assert.equal(await recorder.record("claude:kept", derived), false, "nothing new, nothing written");
  assert.equal(writes, 1);
  assert.equal(await recorder.record("claude:kept", { version: 1, refills: [{ at: at(6), agentId: "primary", kind: "PRIVATE_KIND" }], compactions: [] }), false, "an invalid record is never written");
  assert.equal(await recorder.record("claude:empty", { version: 1, refills: [], compactions: [] }), false, "an empty record writes no file");
  assert.equal(await recorder.ensure("claude:empty"), false);
  assert.equal(await recorder.record("no-provider", derived), false);
  assert.equal(writes, 1);
  const failing = createSessionEventRecorder({ store: { loadSessionEventRecord: async () => { throw new Error("PRIVATE"); }, writeSessionEventRecord: async () => { throw new Error("PRIVATE"); } } });
  assert.equal(await failing.record("claude:kept", derived), false, "a failed write never rejects");
});

test("the recording hooks read a sidecar off the projection path and recommit only when something changed", async () => {
  const disk = new Map([["claude:kept", { version: 1, refills: [{ at: at(1), agentId: "primary", kind: "possible_full" }], compactions: [] }]]);
  const store = {
    loadSessionEventRecord: async (providerId, localSessionId) => normalizeSessionEventRecord(disk.get(`${providerId}:${localSessionId}`)),
    writeSessionEventRecord: async (providerId, localSessionId, record) => { disk.set(`${providerId}:${localSessionId}`, structuredClone(record)); },
  };
  const commits = [];
  let active = true;
  const hooks = createSessionEventRecording({ store, isActive: () => active, commit: (sessionId) => commits.push(sessionId) });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hooks.eventRecordForSession("claude:kept"), null, "the first projection never waits on disk");
  await settle();
  assert.deepEqual(commits, ["claude:kept"]);
  assert.deepEqual(hooks.eventRecordForSession("claude:kept").refills.map((item) => item.at), [at(1)]);
  assert.equal(hooks.eventRecordForSession("claude:absent"), null);
  await settle();
  assert.deepEqual(commits, ["claude:kept"], "a session without a sidecar recommits nothing");

  const grown = { version: 1, refills: [{ at: at(1), agentId: "primary", kind: "possible_full" }, { at: at(4), agentId: "primary", kind: "possible_full" }], compactions: [] };
  hooks.onEventRecord("claude:kept", grown);
  await settle();
  assert.deepEqual(commits, ["claude:kept", "claude:kept"]);
  hooks.onEventRecord("claude:kept", grown);
  await settle();
  assert.equal(commits.length, 2, "an unchanged record writes and recommits nothing");
  active = false;
  hooks.onEventRecord("claude:kept", { ...grown, compactions: [{ at: at(6), agentId: "primary", trigger: "manual" }] });
  await settle();
  assert.equal(disk.get("claude:kept").compactions.length, 0, "a stopped runtime records nothing");

  // A checkpoint store without event sidecars leaves both hooks inert.
  const inert = createSessionEventRecording({ store: {}, isActive: () => true, commit: () => assert.fail("no recommit") });
  assert.equal(inert.eventRecordForSession("claude:kept"), null);
  inert.onEventRecord("claude:kept", grown);
  assert.equal(createSessionEventRecording({ store: null, isActive: () => true, commit: () => {} }).eventRecordForSession("claude:kept"), null);
});
