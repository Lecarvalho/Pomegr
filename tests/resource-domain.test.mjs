import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMonitorStore } from "../monitor/monitor-store.mjs";
import { createResourceHistoryContributor, createResourceHistoryQueries } from "../monitor/resource-history.mjs";
import { createResourceDomainSource } from "../monitor/resource-domain.mjs";
import { projectSessionDomains } from "../monitor/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

// --- shared store/test scaffolding, mirroring tests/resource-history.test.mjs ---

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-resource-domain-"));
  const closers = [];
  t.after(async () => {
    for (const closer of closers) {
      try { await closer(); } catch { /* best-effort cleanup */ }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { directory, onClose: (closer) => closers.push(closer) };
}

async function openStore(t) {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  return store;
}

function createFakeSampler() {
  const bySession = new Map();
  return {
    add(sessionId, sample) {
      if (!bySession.has(sessionId)) bySession.set(sessionId, []);
      bySession.get(sessionId).push(sample);
    },
    samplesSince(sessionId, sinceMs) {
      const list = bySession.get(sessionId) || [];
      const cutoff = Number.isFinite(sinceMs) ? sinceMs : Number.NEGATIVE_INFINITY;
      return list.filter((sample) => Date.parse(sample.timestamp) > cutoff).map((sample) => ({ ...sample }));
    },
  };
}

function sample(timestamp, overrides = {}) {
  return { timestamp, cpuCores: null, cpuMachinePercent: null, memoryBytes: null, readBytesPerSecond: null, writeBytesPerSecond: null, ...overrides };
}

function task(id, startedAtMs, finishedAtMs = null, requestNumber = null) {
  return { id, startedAtMs, finishedAtMs, requestNumber };
}

function insertMinuteRow(store, sessionId, minuteStart, overrides = {}) {
  const columns = ["session_id", "minute_start"];
  const values = [sessionId, minuteStart];
  for (const [key, value] of Object.entries(overrides)) { columns.push(key); values.push(value); }
  store.database.prepare(`INSERT INTO resource_minutes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

function insertPeakRow(store, { id, sessionId, field = "memory_bytes", observedAt, value = 1, matchedTaskIds = [], matchedRequestNumber = null }) {
  store.database.prepare(
    "INSERT INTO resource_peaks (id, session_id, field, observed_at, value, matched_task_ids, matched_request_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, sessionId, field, observedAt, value, JSON.stringify(matchedTaskIds), matchedRequestNumber);
}

function insertSampleRow(store, { sessionId, peakId, observedAt, cpuCores = null, cpuMachinePercent = null, memoryBytes = null, readBps = null, writeBps = null }) {
  store.database.prepare(
    "INSERT INTO resource_peak_samples (session_id, peak_id, observed_at, cpu_cores, cpu_machine_percent, memory_bytes, read_bps, write_bps) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(sessionId, peakId, observedAt, cpuCores, cpuMachinePercent, memoryBytes, readBps, writeBps);
}

function insertRemovalRow(store, sessionId, reason, removedAt) {
  store.database.prepare("INSERT INTO resource_curve_removals (session_id, reason, removed_at) VALUES (?, ?, ?)").run(sessionId, reason, removedAt);
}

/** A controllable monitorStoreRuntime stand-in that captures the registered contributor. */
function createStubRuntime({ store = null, storageReadiness = "ready" } = {}) {
  let contributor = null;
  let afterCheckpointWriteCalls = 0;
  const runtime = Object.freeze({
    registerContributor: (registered) => { contributor = registered; },
    store: () => store,
    serveStorage: () => ({ snapshot: { value: { readiness: storageReadiness } } }),
    afterCheckpointWrite: () => { afterCheckpointWriteCalls += 1; },
  });
  return {
    runtime,
    runCycle: (cycleStore = store) => contributor.onCheckpoint(cycleStore),
    afterCheckpointWriteCalls: () => afterCheckpointWriteCalls,
    setStore: (next) => { store = next; },
    setStorageReadiness: (value) => { storageReadiness = value; },
  };
}

// --- resource-domain.mjs: contributor + retained()/request() ---

test("createResourceDomainSource requires a real monitor store runtime and demand/change hooks", () => {
  assert.throws(() => createResourceDomainSource({}), TypeError);
  assert.throws(() => createResourceDomainSource({ monitorStoreRuntime: {} }), TypeError);
  const stub = createStubRuntime();
  assert.throws(() => createResourceDomainSource({ monitorStoreRuntime: stub.runtime }), TypeError);
});

test("retained() is loading before the first fill, fills from a real temp store with epoch-ms normalized to ISO, and notifies onChange", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const minuteStart = Date.parse("2026-09-22T12:00:00.000Z");
  sampler.add(sessionId, sample(new Date(minuteStart + 5_000).toISOString(), { memoryBytes: 100 }));
  sampler.add(sessionId, sample(new Date(minuteStart + 10_000).toISOString(), { memoryBytes: 300 }));
  const historyContributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks: [task("toolu_x", minuteStart, minuteStart + 15_000, null)], latestObservationMs: minuteStart + 20_000 }],
  });
  await historyContributor.onCheckpoint(store, { now: minuteStart + 20_000 });

  const stub = createStubRuntime({ store });
  const changed = [];
  const source = createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => [sessionId],
    onChange: (id) => changed.push(id),
  });

  assert.deepEqual(source.retained(sessionId), { readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] });

  await stub.runCycle();

  const block = source.retained(sessionId);
  assert.equal(block.readiness, "ready");
  assert.equal(block.minutes.length, 1);
  assert.match(block.minutes[0].minuteStart, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(block.minutes[0].memoryBytes.max, 300);
  assert.match(block.minutes[0].memoryBytes.maxAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(block.peaks.length >= 1);
  const memoryPeak = block.peaks.find((peak) => peak.field === "memory_bytes");
  assert.match(memoryPeak.id, /^p\d+$/);
  assert.match(memoryPeak.observedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(memoryPeak.matchedTaskIds, ["toolu_x"]);
  assert.equal(memoryPeak.matchedTaskCount, 1);
  assert.deepEqual(changed, [sessionId]);

  // A second cycle over unchanged data does not re-notify.
  await stub.runCycle();
  assert.deepEqual(changed, [sessionId]);
});

test("retained(): unavailable when the store is null, rebuilding when storage readiness is rebuilding, never a synchronous SQLite read", async () => {
  const unavailableStub = createStubRuntime({ store: null });
  const unavailableSource = createResourceDomainSource({
    monitorStoreRuntime: unavailableStub.runtime,
    demandedSessionIds: () => [],
    onChange: () => {},
  });
  assert.equal(unavailableSource.retained("any").readiness, "unavailable");

  // A store stub whose `.database` getter throws if ever touched: retained() must never read it.
  const guardedStore = {};
  Object.defineProperty(guardedStore, "database", { get() { throw new Error("retained() must not read SQLite"); } });
  const rebuildingStub = createStubRuntime({ store: guardedStore, storageReadiness: "rebuilding" });
  const rebuildingSource = createResourceDomainSource({
    monitorStoreRuntime: rebuildingStub.runtime,
    demandedSessionIds: () => [],
    onChange: () => {},
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(rebuildingSource.retained("any").readiness, "rebuilding");
  }
  rebuildingStub.setStorageReadiness("ready");
  assert.equal(rebuildingSource.retained("any").readiness, "loading", "no block yet, but no longer rebuilding");
});

test("request(): nudges afterCheckpointWrite once per session (coalesced) and stops once a block exists", async (t) => {
  const store = await openStore(t);
  const stub = createStubRuntime({ store });
  const source = createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => ["s1"],
    onChange: () => {},
  });

  source.request("s1");
  source.request("s1");
  source.request("s1");
  assert.equal(stub.afterCheckpointWriteCalls(), 1, "repeated requests for the same unfilled session coalesce into one nudge");

  await stub.runCycle();
  assert.equal(source.retained("s1").readiness, "ready");

  source.request("s1");
  assert.equal(stub.afterCheckpointWriteCalls(), 1, "a session with a block never nudges again");
});

test("peak windows never cross sessions: only IDs from this session's own sessionResourcePeaks are read", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");
  insertMinuteRow(store, "session-a", base, { memory_bytes_min: 10, memory_bytes_avg: 10, memory_bytes_max: 10, memory_bytes_max_at: base });
  insertPeakRow(store, { id: 1, sessionId: "session-a", field: "memory_bytes", observedAt: base, value: 10 });
  insertSampleRow(store, { sessionId: "session-a", peakId: 1, observedAt: base, memoryBytes: 10 });
  insertMinuteRow(store, "session-b", base, { memory_bytes_min: 20, memory_bytes_avg: 20, memory_bytes_max: 20, memory_bytes_max_at: base });
  insertPeakRow(store, { id: 2, sessionId: "session-b", field: "memory_bytes", observedAt: base, value: 20 });
  insertSampleRow(store, { sessionId: "session-b", peakId: 2, observedAt: base, memoryBytes: 20 });

  const stub = createStubRuntime({ store });
  const source = createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => ["session-a", "session-b"],
    onChange: () => {},
  });
  await stub.runCycle();

  const blockA = source.retained("session-a");
  const blockB = source.retained("session-b");
  assert.equal(blockA.peaks.length, 1);
  assert.equal(blockA.peaks[0].id, "p1");
  assert.equal(blockA.peaks[0].value, 10);
  assert.equal(blockB.peaks.length, 1);
  assert.equal(blockB.peaks[0].id, "p2");
  assert.equal(blockB.peaks[0].value, 20);
});

test("peaks: top 3 per display field, 12 max, sorted by observedAt desc, cpu_machine_percent dropped entirely", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");
  const sessionId = "multi";
  const memoryPeaks = [
    { id: 1, value: 100, at: base + 1_000 },
    { id: 2, value: 200, at: base + 2_000 },
    { id: 3, value: 300, at: base + 3_000 },
    { id: 4, value: 400, at: base + 4_000 },
    { id: 5, value: 500, at: base + 5_000 },
  ];
  for (const peak of memoryPeaks) {
    insertPeakRow(store, { id: peak.id, sessionId, field: "memory_bytes", observedAt: peak.at, value: peak.value });
  }
  const cpuPeaks = [
    { id: 6, value: 10, at: base + 6_000 },
    { id: 7, value: 30, at: base + 8_000 },
    { id: 8, value: 50, at: base + 10_000 },
  ];
  for (const peak of cpuPeaks) {
    insertPeakRow(store, { id: peak.id, sessionId, field: "cpu_cores", observedAt: peak.at, value: peak.value });
  }
  insertPeakRow(store, { id: 9, sessionId, field: "cpu_machine_percent", observedAt: base + 20_000, value: 999 });

  const stub = createStubRuntime({ store });
  const source = createResourceDomainSource({ monitorStoreRuntime: stub.runtime, demandedSessionIds: () => [sessionId], onChange: () => {} });
  await stub.runCycle();

  const block = source.retained(sessionId);
  assert.equal(block.peaks.length, 6, "top 3 memory_bytes + top 3 cpu_cores, cpu_machine_percent excluded");
  assert.ok(block.peaks.every((peak) => peak.field !== "cpu_machine_percent"));
  assert.deepEqual(block.peaks.map((peak) => peak.id), ["p8", "p7", "p6", "p5", "p4", "p3"], "sorted by observedAt desc across fields");
  assert.deepEqual(block.peaks.map((peak) => peak.value), [50, 30, 10, 500, 400, 300]);
});

test("peak window: retained carries only the peak's own field; not_retained falls back to the containing minute", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");
  const sessionId = "windows";

  // Retained window: a memory_bytes peak whose sample row also carries an unrelated
  // cpuCores value; only memoryBytes may surface as the window's `value`.
  insertMinuteRow(store, sessionId, base, { memory_bytes_min: 900, memory_bytes_avg: 900, memory_bytes_max: 900, memory_bytes_max_at: base });
  insertPeakRow(store, { id: 1, sessionId, field: "memory_bytes", observedAt: base, value: 900 });
  insertSampleRow(store, { sessionId, peakId: 1, observedAt: base, memoryBytes: 900, cpuCores: 7 });

  // not_retained: a peak with a minute row but no resource_peak_samples rows at all.
  const secondMinute = base + 120_000;
  insertMinuteRow(store, sessionId, secondMinute, { read_bps_min: 50, read_bps_avg: 50, read_bps_max: 50, read_bps_max_at: secondMinute });
  insertPeakRow(store, { id: 2, sessionId, field: "read_bps", observedAt: secondMinute, value: 50 });

  const stub = createStubRuntime({ store });
  const source = createResourceDomainSource({ monitorStoreRuntime: stub.runtime, demandedSessionIds: () => [sessionId], onChange: () => {} });
  await stub.runCycle();

  const block = source.retained(sessionId);
  const retainedPeak = block.peaks.find((peak) => peak.id === "p1");
  assert.equal(retainedPeak.window.status, "retained");
  assert.equal(retainedPeak.window.minute, null);
  assert.equal(retainedPeak.window.samples.length, 1);
  assert.equal(retainedPeak.window.samples[0].value, 900, "only the peak's own field (memoryBytes), never cpuCores");

  const notRetainedPeak = block.peaks.find((peak) => peak.id === "p2");
  assert.equal(notRetainedPeak.window.status, "not_retained");
  assert.deepEqual(notRetainedPeak.window.samples, []);
  assert.ok(notRetainedPeak.window.minute, "falls back to the minute row containing the peak");
  assert.equal(notRetainedPeak.window.minute.readBytesPerSecond.max, 50);
});

test("curveRemoval: a recorded reason wins, not_recorded only when minutes are empty but peaks exist, null when both are empty", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");

  insertRemovalRow(store, "recorded", "age_retention", base);

  insertPeakRow(store, { id: 1, sessionId: "unrecorded", field: "memory_bytes", observedAt: base, value: 1 });
  // No resource_minutes row for "unrecorded": minutes empty, peaks exist, no removal row.

  // "neither" has no minutes, no peaks, and no removal row.

  const stub = createStubRuntime({ store });
  const source = createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => ["recorded", "unrecorded", "neither"],
    onChange: () => {},
  });
  await stub.runCycle();

  assert.deepEqual(source.retained("recorded").curveRemoval, { reason: "age_retention", removedAt: new Date(base).toISOString() });
  assert.deepEqual(source.retained("unrecorded").curveRemoval, { reason: "not_recorded", removedAt: null });
  assert.equal(source.retained("neither").curveRemoval, null);
});

test("last-known-good: a failed build for one session keeps its previous block and skips onChange", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");
  insertMinuteRow(store, "s1", base, { memory_bytes_min: 1, memory_bytes_avg: 1, memory_bytes_max: 1, memory_bytes_max_at: base });

  const stub = createStubRuntime({ store });
  const changed = [];
  const source = createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => ["s1"],
    onChange: (id) => changed.push(id),
  });
  await stub.runCycle();
  const firstBlock = source.retained("s1");
  assert.equal(firstBlock.minutes.length, 1);
  assert.deepEqual(changed, ["s1"]);

  const brokenStore = {
    get database() { throw new Error("simulated read failure"); },
  };
  await stub.runCycle(brokenStore);

  assert.deepEqual(source.retained("s1"), firstBlock, "the previous block is untouched by the failed cycle");
  assert.deepEqual(changed, ["s1"], "onChange is not called again for the failed session");
});

test("demanded sessions are bounded per cycle", async (t) => {
  const store = await openStore(t);
  const ids = Array.from({ length: 40 }, (_, index) => `s${index}`);
  const stub = createStubRuntime({ store });
  const changed = [];
  createResourceDomainSource({
    monitorStoreRuntime: stub.runtime,
    demandedSessionIds: () => ids,
    onChange: (id) => changed.push(id),
  });
  await stub.runCycle();
  assert.equal(changed.length, 32, "at most 32 demanded sessions are processed in one cycle");
});

test("sessionResourceCurvesRecent: newest-N with a truncated flag, ascending order preserved", async (t) => {
  const store = await openStore(t);
  const base = Date.parse("2026-09-22T12:00:00.000Z");
  for (let index = 0; index < 5; index += 1) insertMinuteRow(store, "s1", base + index * 60_000);
  const queries = createResourceHistoryQueries(store);

  const bounded = queries.sessionResourceCurvesRecent("s1", { limit: 3 });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.rows.length, 3);
  assert.deepEqual(bounded.rows.map((row) => row.minuteStart), [base + 2 * 60_000, base + 3 * 60_000, base + 4 * 60_000], "newest 3, ascending order");

  const notTruncated = queries.sessionResourceCurvesRecent("s1", { limit: 10 });
  assert.equal(notTruncated.truncated, false);
  assert.equal(notTruncated.rows.length, 5);
});

// --- session-domain-projection.mjs integration: privacy/serialization and hasData ---

function minimalState(overrides = {}) {
  const state = createEmptyMonitorState({ connected: true, source: "Codex", view: "history" });
  return { ...state, ...overrides };
}

function projectResources(state, readinessOverrides, retainedResources) {
  const snapshot = {
    publicState: state,
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "loading", usageLimits: "ready", ...readinessOverrides },
    observedAt: "2026-09-22T12:00:00.000Z",
  };
  const { domains } = projectSessionDomains("codex:s1", snapshot, { retainedResources });
  return domains.get("resources");
}

test("serialization: the resources domain carries no process-identity keys and only the documented fields", () => {
  const matchedTask = {
    id: "toolu_matched", label: "npm test", kind: "shell", workKind: "test", status: "completed",
    background: false, backgroundId: null, startedAt: "2026-09-22T11:59:55.000Z", finishedAt: "2026-09-22T12:00:00.000Z",
    exitCode: 0, failureCause: null, signal: null,
  };
  const state = minimalState({ executionTasks: [matchedTask] });
  const retainedResources = {
    readiness: "ready",
    minutes: [{
      minuteStart: "2026-09-22T12:00:00.000Z",
      cpuCores: { min: 1, avg: 1.5, max: 2, maxAt: "2026-09-22T12:00:30.000Z" },
      memoryBytes: null,
      readBytesPerSecond: null,
      writeBytesPerSecond: null,
    }],
    minutesTruncated: false,
    curveRemoval: null,
    peaks: [{
      id: "p1",
      field: "cpu_cores",
      observedAt: "2026-09-22T12:00:30.000Z",
      value: 2,
      matchedTaskIds: ["toolu_matched", "toolu_missing"],
      matchedTaskCount: 2,
      window: { status: "retained", samples: [{ at: "2026-09-22T12:00:29.000Z", value: 1.8 }], minute: null },
    }],
  };

  const resources = projectResources(state, {}, retainedResources);

  assert.deepEqual(Object.keys(resources).sort(), ["domain", "live", "observedAt", "readiness", "retained", "sessionId", "source", "view"]);
  assert.deepEqual(Object.keys(resources.retained).sort(), ["curveRemoval", "minutes", "minutesTruncated", "peaks", "readiness"]);
  const [peak] = resources.retained.peaks;
  assert.deepEqual(Object.keys(peak).sort(), ["field", "id", "matchedTaskCount", "observedAt", "request", "tasks", "value", "window"]);
  assert.equal(peak.request, null, "request stays null in this part");
  assert.equal(peak.matchedTaskCount, 2, "unresolved IDs still count toward matchedTaskCount");
  assert.equal(peak.tasks.length, 1, "an unresolved task ID is dropped from tasks");
  assert.deepEqual(Object.keys(peak.tasks[0]).sort(), ["durationMs", "finishedAt", "id", "label", "startedAt", "workKind"]);
  assert.equal(peak.tasks[0].id, "toolu_matched");
  assert.equal(peak.tasks[0].durationMs, 5_000);
  assert.deepEqual(Object.keys(peak.window).sort(), ["minute", "samples", "status"]);
  const [minute] = resources.retained.minutes;
  assert.deepEqual(Object.keys(minute).sort(), ["cpuCores", "memoryBytes", "minuteStart", "readBytesPerSecond", "writeBytesPerSecond"]);
  assert.deepEqual(Object.keys(minute.cpuCores).sort(), ["avg", "max", "maxAt", "min"]);

  const serialized = JSON.stringify(resources);
  assert.doesNotMatch(serialized, /"pid"|"processId"|"command"|"cwd"|"exe"|processStartIdentity/i);
});

test("hasData truth table: true when either side has data, false only when both resolve empty, null while either is still loading", () => {
  const readyEmptyRetained = { readiness: "ready", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] };
  const loadingRetained = { readiness: "loading", minutes: [], minutesTruncated: false, curveRemoval: null, peaks: [] };
  const readyRetainedWithData = { readiness: "ready", minutes: [{ minuteStart: "2026-09-22T12:00:00.000Z", cpuCores: null, memoryBytes: null, readBytesPerSecond: null, writeBytesPerSecond: null }], minutesTruncated: false, curveRemoval: null, peaks: [] };

  function hasDataFor(resourcesReadiness, resourcesMetrics, retainedResources) {
    const state = minimalState({ metrics: { ...createEmptyMonitorState().metrics, resources: resourcesMetrics } });
    const snapshot = {
      publicState: state,
      readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: resourcesReadiness, usageLimits: "ready" },
      observedAt: "2026-09-22T12:00:00.000Z",
    };
    const { domains } = projectSessionDomains("codex:s1", snapshot, { retainedResources });
    return domains.get("session-summary").resourceAvailability.hasData;
  }

  // Live has samples: true regardless of retained.
  assert.equal(hasDataFor("ready", { status: "ready", reason: null, current: null, samples: [{ timestamp: "2026-09-22T12:00:00.000Z" }] }, null), true);
  // Retained has minutes: true regardless of live.
  assert.equal(hasDataFor("unavailable", null, readyRetainedWithData), true);
  // Both resolved and empty: false.
  assert.equal(hasDataFor("ready", { status: "ready", reason: null, current: null, samples: [] }, readyEmptyRetained), false);
  // Live still loading: null even if retained already resolved empty.
  assert.equal(hasDataFor("loading", null, readyEmptyRetained), null);
  // Retained still loading: null even if live already resolved empty.
  assert.equal(hasDataFor("ready", { status: "ready", reason: null, current: null, samples: [] }, loadingRetained), null);
  // No retained block at all (null) never counts as "resolved empty": null while unresolved live-only.
  assert.equal(hasDataFor("unavailable", null, null), null);
});
