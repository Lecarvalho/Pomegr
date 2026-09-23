import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMonitorStore } from "../monitor/monitor-store.mjs";
import { attachResourceHistory, createResourceHistoryContributor, createResourceHistoryQueries } from "../monitor/resource-history.mjs";

// `t.after` hooks run in registration order, so the store must close before its
// directory is removed. Mirrors tests/monitor-store.test.mjs's helper.
async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-resource-history-"));
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

/** A minimal fake sampler: samplesSince(sessionId, sinceMs) over test-appended samples. */
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
  return {
    timestamp,
    cpuCores: null,
    cpuMachinePercent: null,
    memoryBytes: null,
    readBytesPerSecond: null,
    writeBytesPerSecond: null,
    ...overrides,
  };
}

function task(id, startedAtMs, finishedAtMs = null, requestNumber = null) {
  return { id, startedAtMs, finishedAtMs, requestNumber };
}

function minuteRow(store, sessionId, minuteStart) {
  return store.database.prepare("SELECT * FROM resource_minutes WHERE session_id = ? AND minute_start = ?")
    .get(sessionId, minuteStart);
}

function peakRows(store, sessionId, field) {
  return store.database.prepare("SELECT * FROM resource_peaks WHERE session_id = ? AND field = ? ORDER BY value DESC")
    .all(sessionId, field);
}

test("aggregates a minute's samples into min/avg/max with the exact max timestamp, nulling untouched fields", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const minuteStart = Date.parse("2026-09-22T12:00:00.000Z");
  sampler.add("s1", sample("2026-09-22T12:00:05.000Z", { memoryBytes: 100 }));
  sampler.add("s1", sample("2026-09-22T12:00:10.000Z", { memoryBytes: 300 }));
  sampler.add("s1", sample("2026-09-22T12:00:15.000Z", { memoryBytes: 200 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId: "s1", tasks: [], latestObservationMs: minuteStart + 20_000 }],
  });

  await contributor.onCheckpoint(store, { now: minuteStart + 20_000 });

  const row = minuteRow(store, "s1", minuteStart);
  assert.ok(row, "minute row is written");
  assert.equal(row.memory_bytes_min, 100);
  assert.equal(row.memory_bytes_avg, 200);
  assert.equal(row.memory_bytes_max, 300);
  assert.equal(row.memory_bytes_max_at, Date.parse("2026-09-22T12:00:10.000Z"));
  assert.equal(row.cpu_cores_min, null);
  assert.equal(row.cpu_cores_avg, null);
  assert.equal(row.cpu_cores_max, null);
  assert.equal(row.cpu_cores_max_at, null);

  const peaks = peakRows(store, "s1", "memory_bytes");
  assert.equal(peaks.length, 1, "exactly one peak candidate per field per minute");
  assert.equal(peaks[0].value, 300);
  assert.equal(peaks[0].observed_at, Date.parse("2026-09-22T12:00:10.000Z"));
});

test("an all-null minute is not written and produces no peak candidate", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  sampler.add("s1", sample("2026-09-22T12:00:05.000Z"));
  sampler.add("s1", sample("2026-09-22T12:00:10.000Z"));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId: "s1", tasks: [], latestObservationMs: null }],
  });

  await contributor.onCheckpoint(store, { now: 0 });

  const count = store.database.prepare("SELECT COUNT(*) AS count FROM resource_minutes WHERE session_id = ?").get("s1").count;
  assert.equal(count, 0);
  const peakCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_peaks WHERE session_id = ?").get("s1").count;
  assert.equal(peakCount, 0);
});

test("re-upserts the partial current minute across cycles, keeping the same peak row", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const minuteStart = Date.parse("2026-09-22T12:00:00.000Z");
  sampler.add("s1", sample("2026-09-22T12:00:05.000Z", { memoryBytes: 100 }));
  sampler.add("s1", sample("2026-09-22T12:00:10.000Z", { memoryBytes: 200 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId: "s1", tasks: [], latestObservationMs: minuteStart + 60_000 }],
  });

  await contributor.onCheckpoint(store, { now: minuteStart + 12_000 });
  const first = minuteRow(store, "s1", minuteStart);
  assert.equal(first.memory_bytes_max, 200);
  const firstPeak = peakRows(store, "s1", "memory_bytes")[0];

  // More samples land in the same (still-current) minute before it rolls over.
  sampler.add("s1", sample("2026-09-22T12:00:20.000Z", { memoryBytes: 500 }));
  await contributor.onCheckpoint(store, { now: minuteStart + 22_000 });

  const second = minuteRow(store, "s1", minuteStart);
  assert.equal(second.memory_bytes_min, 100);
  assert.equal(second.memory_bytes_max, 500);
  assert.equal(second.memory_bytes_max_at, Date.parse("2026-09-22T12:00:20.000Z"));

  const peaksAfter = peakRows(store, "s1", "memory_bytes");
  assert.equal(peaksAfter.length, 1, "the same minute never produces a second peak row");
  assert.equal(peaksAfter[0].id, firstPeak.id, "the existing minute's peak row is replaced in place, not duplicated");
  assert.equal(peaksAfter[0].value, 500);
});

test("keeps only the top ten peaks per field and deletes evicted sample windows", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks: [], latestObservationMs: null }],
  });

  const base = Date.parse("2026-09-22T00:00:00.000Z");
  for (let minuteIndex = 0; minuteIndex < 12; minuteIndex += 1) {
    const minuteStart = base + minuteIndex * 60_000;
    sampler.add(sessionId, sample(new Date(minuteStart + 10_000).toISOString(), { memoryBytes: 1_000 + minuteIndex }));
    await contributor.onCheckpoint(store, { now: minuteStart + 30_000 });
  }

  const peaks = peakRows(store, sessionId, "memory_bytes");
  assert.equal(peaks.length, 10, "only the top ten peaks are retained");
  const values = peaks.map((peak) => peak.value).sort((left, right) => left - right);
  assert.deepEqual(values, [1_002, 1_003, 1_004, 1_005, 1_006, 1_007, 1_008, 1_009, 1_010, 1_011], "the two lowest values were evicted");

  const retainedIds = new Set(peaks.map((peak) => peak.id));
  const orphanSamples = store.database.prepare(
    "SELECT DISTINCT peak_id FROM resource_peak_samples WHERE session_id = ?",
  ).all(sessionId).map((row) => row.peak_id).filter((peakId) => !retainedIds.has(peakId));
  assert.deepEqual(orphanSamples, [], "no sample-window rows remain for an evicted peak");
});

test("fills a peak's sample window across two cycles and respects the two-minute bound", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const peakAt = Date.parse("2026-09-22T12:00:10.000Z");
  sampler.add(sessionId, sample(new Date(peakAt - 5_000).toISOString(), { memoryBytes: 50 }));
  sampler.add(sessionId, sample(new Date(peakAt).toISOString(), { memoryBytes: 900 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks: [], latestObservationMs: peakAt + 200_000 }],
  });

  await contributor.onCheckpoint(store, { now: peakAt + 5_000 });
  const peak = peakRows(store, sessionId, "memory_bytes")[0];
  const firstWindowCount = store.database.prepare(
    "SELECT COUNT(*) AS count FROM resource_peak_samples WHERE peak_id = ?",
  ).get(peak.id).count;
  assert.ok(firstWindowCount >= 2, "the before-window samples are captured in the first cycle");

  // Second cycle: one more sample inside the +/-120s window, one clearly outside it.
  sampler.add(sessionId, sample(new Date(peakAt + 60_000).toISOString(), { memoryBytes: 10 }));
  sampler.add(sessionId, sample(new Date(peakAt + 200_000).toISOString(), { memoryBytes: 5 }));
  await contributor.onCheckpoint(store, { now: peakAt + 210_000 });

  const rows = store.database.prepare(
    "SELECT observed_at FROM resource_peak_samples WHERE peak_id = ? ORDER BY observed_at ASC",
  ).all(peak.id);
  assert.ok(rows.length > firstWindowCount, "the after-window fills over the later cycle");
  for (const row of rows) {
    assert.ok(row.observed_at >= peakAt - 120_000 && row.observed_at <= peakAt + 120_000, "every captured sample stays within the two-minute bound");
  }
  assert.ok(!rows.some((row) => row.observed_at === peakAt + 200_000), "a sample outside the bound is never written");
});

test("writes matched task IDs and request number for a retained peak, recomputed every cycle", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const peakAt = Date.parse("2026-09-22T12:00:10.000Z");
  sampler.add(sessionId, sample(new Date(peakAt - 30_000).toISOString(), { memoryBytes: 10 }));
  sampler.add(sessionId, sample(new Date(peakAt).toISOString(), { memoryBytes: 900 }));

  let running = true;
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{
      sessionId,
      tasks: [task("toolu_a", peakAt - 20_000, running ? null : peakAt + 1_000, 42)],
      latestObservationMs: peakAt + 5_000,
    }],
  });

  await contributor.onCheckpoint(store, { now: peakAt + 5_000 });
  let peak = peakRows(store, sessionId, "memory_bytes")[0];
  assert.deepEqual(JSON.parse(peak.matched_task_ids), ["toolu_a"]);
  assert.equal(peak.matched_request_number, 42);

  // The task finishes later; the next cycle's re-match reflects the update even
  // though no new sample changes the minute or the peak's own value.
  running = false;
  sampler.add(sessionId, sample(new Date(peakAt + 90_000).toISOString(), { memoryBytes: 1 }));
  await contributor.onCheckpoint(store, { now: peakAt + 95_000 });
  peak = peakRows(store, sessionId, "memory_bytes")[0];
  assert.deepEqual(JSON.parse(peak.matched_task_ids), ["toolu_a"]);
  assert.equal(peak.matched_request_number, 42);
});

test("a session absent from sessionInputs, or with no in-memory samples, writes nothing", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler(); // "ghost" has no samples ever added
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId: "ghost", tasks: [], latestObservationMs: null }],
  });

  await contributor.onCheckpoint(store, { now: 0 });

  for (const table of ["resource_minutes", "resource_peaks", "resource_peak_samples"]) {
    const count = store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
    assert.equal(count, 0, `${table} stays empty`);
  }
});

test("a failing session is skipped without affecting the others", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  sampler.add("ok", sample("2026-09-22T12:00:05.000Z", { memoryBytes: 1 }));
  // Force a failure while processing "bad" by handing it a non-array tasks value that
  // blows up inside matchResourcePeak's caller (a Proxy that throws on any property read).
  const explodingTasks = new Proxy([], { get() { throw new Error("boom"); } });
  sampler.add("bad", sample("2026-09-22T12:00:05.000Z", { memoryBytes: 1 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [
      { sessionId: "bad", tasks: explodingTasks, latestObservationMs: null },
      { sessionId: "ok", tasks: [], latestObservationMs: null },
    ],
  });

  await contributor.onCheckpoint(store, { now: 0 });

  const okCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_minutes WHERE session_id = 'ok'").get().count;
  assert.equal(okCount, 1, "the healthy session still gets its writes");
  const badCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_minutes WHERE session_id = 'bad'").get().count;
  assert.equal(badCount, 0, "the failing session's transaction rolled back entirely, with no partial writes");
});

test("createResourceHistoryQueries exposes camelCase curves, ordered peaks, and sample windows", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const minuteStart = Date.parse("2026-09-22T12:00:00.000Z");
  sampler.add(sessionId, sample(new Date(minuteStart + 5_000).toISOString(), { memoryBytes: 100, cpuCores: 0.5 }));
  sampler.add(sessionId, sample(new Date(minuteStart + 10_000).toISOString(), { memoryBytes: 300, cpuCores: 1.5 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks: [task("toolu_x", minuteStart, minuteStart + 15_000, 3)], latestObservationMs: minuteStart + 20_000 }],
  });
  await contributor.onCheckpoint(store, { now: minuteStart + 20_000 });

  const queries = createResourceHistoryQueries(store);

  const curves = queries.sessionResourceCurves(sessionId);
  assert.equal(curves.length, 1);
  assert.deepEqual(Object.keys(curves[0]).sort(), [
    "cpuCoresAvg", "cpuCoresMax", "cpuCoresMaxAt", "cpuCoresMin",
    "cpuMachinePercentAvg", "cpuMachinePercentMax", "cpuMachinePercentMaxAt", "cpuMachinePercentMin",
    "memoryBytesAvg", "memoryBytesMax", "memoryBytesMaxAt", "memoryBytesMin",
    "minuteStart", "readBpsAvg", "readBpsMax", "readBpsMaxAt", "readBpsMin",
    "sessionId", "writeBpsAvg", "writeBpsMax", "writeBpsMaxAt", "writeBpsMin",
  ].sort());
  assert.equal(curves[0].memoryBytesMax, 300);
  assert.equal(curves[0].cpuCoresMax, 1.5);

  const curvesBounded = queries.sessionResourceCurves(sessionId, { fromMs: minuteStart + 60_000, toMs: minuteStart + 120_000 });
  assert.deepEqual(curvesBounded, [], "an out-of-range window returns no rows");

  const peaks = queries.sessionResourcePeaks(sessionId);
  assert.ok(peaks.length >= 1);
  const memoryPeak = peaks.find((peak) => peak.field === "memory_bytes");
  assert.deepEqual(Object.keys(memoryPeak).sort(), [
    "field", "id", "matchedRequestNumber", "matchedTaskIds", "observedAtMs", "sessionId", "value",
  ].sort());
  assert.deepEqual(memoryPeak.matchedTaskIds, ["toolu_x"]);
  assert.equal(memoryPeak.matchedRequestNumber, 3);
  assert.equal(memoryPeak.value, 300);
  const fieldOrder = peaks.map((peak) => peak.field);
  assert.deepEqual(fieldOrder, [...fieldOrder].sort());

  const window = queries.peakSampleWindow(memoryPeak.id);
  assert.ok(Array.isArray(window) && window.length > 0);
  assert.deepEqual(Object.keys(window[0]).sort(), [
    "cpuCores", "cpuMachinePercent", "memoryBytes", "observedAtMs", "readBps", "writeBps",
  ].sort());
  const ascending = window.every((row, index) => index === 0 || row.observedAtMs >= window[index - 1].observedAtMs);
  assert.ok(ascending, "sample window rows are ordered by time");

  assert.equal(queries.peakSampleWindow(-1), null, "an unknown peak has no window");
});

test("no committed row anywhere exposes a forbidden key such as pid, path, or command", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "s1";
  const minuteStart = Date.parse("2026-09-22T12:00:00.000Z");
  sampler.add(sessionId, sample(new Date(minuteStart + 5_000).toISOString(), { memoryBytes: 111, readBytesPerSecond: 222 }));
  sampler.add(sessionId, sample(new Date(minuteStart + 10_000).toISOString(), { memoryBytes: 999, readBytesPerSecond: 333 }));
  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks: [task("toolu_forbidden_check", minuteStart, minuteStart + 15_000, 9)], latestObservationMs: minuteStart + 20_000 }],
  });
  await contributor.onCheckpoint(store, { now: minuteStart + 20_000 });

  const queries = createResourceHistoryQueries(store);
  const payload = JSON.stringify({
    curves: queries.sessionResourceCurves(sessionId),
    peaks: queries.sessionResourcePeaks(sessionId),
    window: queries.peakSampleWindow(queries.sessionResourcePeaks(sessionId)[0].id),
  });
  assert.doesNotMatch(payload, /pid|processStart|parentPid|cwd|command|"path"|label|C:\\|\/home\//i);
});

test("measures growth for one synthetic session-hour at 5-second samples with about 40 tasks", async (t) => {
  const store = await openStore(t);
  const sampler = createFakeSampler();
  const sessionId = "growth-session";
  const hourStart = Date.parse("2026-09-22T00:00:00.000Z");
  const SAMPLE_INTERVAL_MS = 5_000;
  const SAMPLE_COUNT = (60 * 60_000) / SAMPLE_INTERVAL_MS; // 720

  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const timestamp = hourStart + index * SAMPLE_INTERVAL_MS;
    sampler.add(sessionId, sample(new Date(timestamp).toISOString(), {
      cpuCores: 0.1 + (index % 7) * 0.05,
      cpuMachinePercent: ((0.1 + (index % 7) * 0.05) / 4) * 100,
      memoryBytes: 50_000_000 + (index % 97) * 123_456,
      readBytesPerSecond: (index % 13) * 4_096,
      writeBytesPerSecond: (index % 11) * 2_048,
    }));
  }

  const tasks = [];
  for (let index = 0; index < 40; index += 1) {
    const startedAtMs = hourStart + index * 90_000;
    const finishedAtMs = index % 5 === 0 ? null : startedAtMs + 20_000;
    tasks.push(task(`toolu_growth_${index}`, startedAtMs, finishedAtMs, index % 3 === 0 ? null : (index % 6) + 1));
  }

  const contributor = createResourceHistoryContributor({
    sampler,
    sessionInputs: () => [{ sessionId, tasks, latestObservationMs: hourStart + 60 * 60_000 }],
  });

  const beforeBytes = store.sizeBytes();
  await contributor.onCheckpoint(store, { now: hourStart + 60 * 60_000 });
  const afterBytes = store.sizeBytes();

  const minuteCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_minutes WHERE session_id = ?").get(sessionId).count;
  const peakCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_peaks WHERE session_id = ?").get(sessionId).count;
  const sampleWindowCount = store.database.prepare("SELECT COUNT(*) AS count FROM resource_peak_samples WHERE session_id = ?").get(sessionId).count;

  assert.equal(minuteCount, 60, "one row per minute of the synthetic hour");
  assert.ok(peakCount > 0 && peakCount <= 50, "at most ten peaks per field across five fields");
  assert.ok(sampleWindowCount > 0);

  t.diagnostic(`resource-history growth for one synthetic session-hour (5s samples, 40 tasks): `
    + `sizeBytes delta = ${afterBytes - beforeBytes} bytes (before ${beforeBytes}, after ${afterBytes}); `
    + `resource_minutes rows = ${minuteCount}; resource_peaks rows = ${peakCount}; resource_peak_samples rows = ${sampleWindowCount}`);
});

test("attached resource history schedules a store cycle at most once a minute while sessions are sampled", async () => {
  let clock = 1_000_000;
  let cycles = 0;
  const contributors = [];
  const monitorStoreRuntime = {
    registerContributor: (contributor) => contributors.push(contributor.name),
    afterCheckpointWrite: () => { cycles += 1; },
  };
  const sampler = { sample: async () => "sampled", samplesSince: () => [], get: () => null };
  const history = attachResourceHistory({ monitorStoreRuntime, sampler, observationStore: { entries: () => [] }, now: () => clock });
  assert.deepEqual(contributors, ["resource-history"]);

  assert.equal(await history.sampleAndSchedule([]), "sampled");
  assert.equal(cycles, 0, "no sampled sessions, no store cycle");
  await history.sampleAndSchedule([{ sessionId: "claude:a" }]);
  clock += 59_999;
  await history.sampleAndSchedule([{ sessionId: "claude:a" }]);
  assert.equal(cycles, 1);
  clock += 1;
  await history.sampleAndSchedule([{ sessionId: "claude:a" }]);
  assert.equal(cycles, 2);

  let disabledCycles = 0;
  const disabled = attachResourceHistory({
    enabled: false,
    monitorStoreRuntime: { registerContributor: () => assert.fail("must not register"), afterCheckpointWrite: () => { disabledCycles += 1; } },
    sampler,
    observationStore: { entries: () => [] },
  });
  assert.equal(await disabled.sampleAndSchedule([{ sessionId: "claude:a" }]), "sampled");
  assert.equal(disabledCycles, 0);
});
