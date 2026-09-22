import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installSqliteExperimentalWarningFilter, MONITOR_STORE_SCHEMA_VERSION, openMonitorStore } from "../monitor/monitor-store.mjs";
import { createMonitorStoreRuntime } from "../monitor/monitor-store-runtime.mjs";

// `t.after` hooks run in registration order, so every closer (store.close/runtime.stop)
// must be registered through `onClose` *before* the directory removal below can run.
async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-monitor-store-"));
  const closers = [];
  t.after(async () => {
    for (const closer of closers) {
      try { await closer(); } catch { /* best-effort cleanup */ }
    }
    // Windows can briefly hold a WAL/-shm handle open just after close(); retry rather
    // than fail the test on that race.
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

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error("condition was not met in time");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const defaultSettings = Object.freeze({ retentionDays: 90, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 });

function fakeRetention(overrides = {}) {
  return {
    runRetention: overrides.runRetention || ((store, settings, { now }) => Object.freeze({
      prunedAt: now,
      cleanupStatus: "normal",
      databaseBytes: store.sizeBytes(),
      oldestRetainedDay: null,
      removedMinuteSessions: 0,
      removedSampleSessions: 0,
    })),
    readStorageFacts: overrides.readStorageFacts || ((store) => ({ databaseBytes: store.sizeBytes(), oldestRetainedDay: null })),
    buildStorageReadiness: overrides.buildStorageReadiness || ((input) => {
      const bytes = Number.isSafeInteger(input.databaseBytes) && input.databaseBytes >= 0 ? input.databaseBytes : null;
      return {
        readiness: input.readiness,
        databaseBytes: bytes,
        thresholdBytes: input.settings.thresholdBytes,
        percent: bytes === null ? null : Math.round((bytes / input.settings.thresholdBytes) * 100),
        oldestRetainedDay: input.oldestRetainedDay,
        lastPrunedAt: input.lastPrunedAt,
        retentionDays: input.settings.retentionDays,
        cleanupStatus: bytes === null ? null : input.cleanupStatus,
      };
    }),
  };
}

// --- monitor-store.mjs ---

test("openMonitorStore creates every table and index defined by the T07 schema", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  const names = store.database.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name").all()
    .map((row) => row.name);
  for (const expected of [
    "meta", "files", "files_repository_path", "file_paths", "file_paths_path",
    "file_changes", "file_changes_session_time", "file_changes_file_time",
    "resource_minutes", "resource_minutes_time",
    "resource_peaks", "resource_peaks_session_field",
    "resource_peak_samples", "resource_peak_samples_session_time",
  ]) {
    assert.ok(names.includes(expected), `expected schema object ${expected}`);
  }
  const versionRow = store.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(Number(versionRow.value), MONITOR_STORE_SCHEMA_VERSION);
});

test("rebuilt is false on a clean reopen of a valid store", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const first = await openMonitorStore({ directory });
  assert.equal(first.rebuilt, true, "a brand-new store counts as rebuilt (the index was missing)");
  first.close();
  const second = await openMonitorStore({ directory });
  onClose(() => second.close());
  assert.equal(second.rebuilt, false);
});

test("a corrupt database file is rebuilt", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  await writeFile(path.join(directory, "monitor.sqlite"), "not a real sqlite database, just junk bytes");
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  assert.equal(store.rebuilt, true);
  const versionRow = store.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(Number(versionRow.value), MONITOR_STORE_SCHEMA_VERSION);
});

test("a schema-version mismatch is rebuilt", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const first = await openMonitorStore({ directory });
  first.database.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("999");
  first.close();
  const second = await openMonitorStore({ directory });
  onClose(() => second.close());
  assert.equal(second.rebuilt, true);
  const versionRow = second.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(Number(versionRow.value), MONITOR_STORE_SCHEMA_VERSION);
});

test("an unrecoverable open failure throws a sanitized error without the directory", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "pomegr-monitor-store-blocked-"));
  const blockingFile = path.join(parent, "blocked");
  await writeFile(blockingFile, "not a directory");
  const impossibleDirectory = path.join(blockingFile, "nested", "monitor-store-v1");
  await assert.rejects(openMonitorStore({ directory: impossibleDirectory }), (error) => {
    assert.equal(error.message, "MONITOR_STORE_UNAVAILABLE");
    assert.ok(!error.message.includes(impossibleDirectory));
    assert.ok(!error.message.includes(parent));
    return true;
  });
  await rm(parent, { recursive: true, force: true });
});

test("transaction rolls back on throw", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  assert.throws(() => store.transaction(() => {
    store.database.prepare("INSERT INTO files (repository_id, current_path, first_seen_at) VALUES (?, ?, ?)").run("repo", "a.txt", 1);
    throw new Error("boom");
  }), /boom/);
  const count = store.database.prepare("SELECT COUNT(*) AS count FROM files").get().count;
  assert.equal(count, 0);
});

test("transaction commits and returns the callback result", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  const returned = store.transaction(() => {
    store.database.prepare("INSERT INTO files (repository_id, current_path, first_seen_at) VALUES (?, ?, ?)").run("repo", "a.txt", 1);
    return "ok";
  });
  assert.equal(returned, "ok");
  const count = store.database.prepare("SELECT COUNT(*) AS count FROM files").get().count;
  assert.equal(count, 1);
});

test("sizeBytes grows after inserts", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  const before = store.sizeBytes();
  store.transaction(() => {
    const insert = store.database.prepare("INSERT INTO files (repository_id, current_path, first_seen_at) VALUES (?, ?, ?)");
    for (let index = 0; index < 2000; index += 1) {
      insert.run("repo", `path/to/some/file-${index}-${"x".repeat(80)}.txt`, index);
    }
  });
  assert.ok(store.sizeBytes() > before, "database + WAL bytes should grow after a meaningful insert batch");
});

test("auto_vacuum is incremental", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  const row = store.database.prepare("PRAGMA auto_vacuum").get();
  assert.equal(Object.values(row)[0], 2, "2 is SQLite's incremental auto_vacuum mode");
});

test("vacuumIncremental does not throw and can run after deletes", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const store = await openMonitorStore({ directory });
  onClose(() => store.close());
  store.transaction(() => {
    const insert = store.database.prepare("INSERT INTO files (repository_id, current_path, first_seen_at) VALUES (?, ?, ?)");
    for (let index = 0; index < 50; index += 1) insert.run("repo", `f-${index}.txt`, index);
  });
  store.transaction(() => { store.database.exec("DELETE FROM files"); });
  assert.doesNotThrow(() => store.vacuumIncremental());
});

test("the SQLite ExperimentalWarning filter drops only that exact warning", async () => {
  installSqliteExperimentalWarningFilter();
  const seen = [];
  const handler = (warning) => seen.push(warning);
  process.on("warning", handler);
  try {
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("Something unrelated", "ExperimentalWarning");
    process.emitWarning("SQLite is an experimental feature and might change at any time", "OtherWarningType");
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", handler);
  }
  assert.equal(seen.filter((warning) => warning.message.startsWith("SQLite is an experimental feature")
    && warning.name === "ExperimentalWarning").length, 0, "the exact SQLite experimental warning is dropped");
  assert.ok(seen.some((warning) => warning.message === "Something unrelated"), "an unrelated ExperimentalWarning still passes through");
  assert.ok(seen.some((warning) => warning.message.startsWith("SQLite is an experimental feature") && warning.name === "OtherWarningType"),
    "the same message under a different warning type still passes through");
});

// --- monitor-store-runtime.mjs ---

test("runtime readiness is loading, then unavailable when no directory is configured", async () => {
  const runtime = createMonitorStoreRuntime({ directory: null, settings: defaultSettings, retention: fakeRetention() });
  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "unavailable");
  await runtime.start();
  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "unavailable");
  assert.equal(runtime.serveStorage(null).snapshot.value.databaseBytes, null);
  await runtime.stop();
});

test("runtime readiness moves from rebuilding to ready with zero contributors, after the first cycle", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const runtime = createMonitorStoreRuntime({ directory, settings: defaultSettings, retention: fakeRetention() });
  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "loading");
  await runtime.start();
  onClose(() => runtime.stop());
  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "rebuilding", "a fresh store has no prior cycle yet");
  runtime.afterCheckpointWrite();
  await waitFor(() => runtime.serveStorage(null).snapshot.value.readiness === "ready");
  const readiness = runtime.serveStorage(null).snapshot.value;
  assert.equal(readiness.readiness, "ready");
  assert.ok(!JSON.stringify(readiness).includes(directory), "the committed readiness never carries the store directory");
});

test("runtime readiness stays rebuilding while a registered contributor has not finished", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const runtime = createMonitorStoreRuntime({ directory, settings: defaultSettings, retention: fakeRetention() });
  let onCheckpointCalls = 0;
  runtime.registerContributor({
    name: "file-history",
    onCheckpoint: async () => { onCheckpointCalls += 1; },
    rebuildComplete: () => false,
  });
  await runtime.start();
  onClose(() => runtime.stop());
  runtime.afterCheckpointWrite();
  await waitFor(() => onCheckpointCalls > 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.serveStorage(null).snapshot.value.readiness, "rebuilding");
});

test("serveStorage answers unchanged for the currently committed revision", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const runtime = createMonitorStoreRuntime({ directory, settings: defaultSettings, retention: fakeRetention() });
  await runtime.start();
  onClose(() => runtime.stop());
  const current = runtime.serveStorage(null);
  assert.equal(runtime.serveStorage(current.revision).status, "unchanged");
  assert.notEqual(runtime.serveStorage(current.revision - 1 >= 0 ? current.revision - 1 : null).status, "unchanged");
});

test("afterCheckpointWrite called twice in a row coalesces into one cycle", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  let cycles = 0;
  // The very first cycle always takes the prune path (no prior prune timestamp yet).
  const runtime = createMonitorStoreRuntime({
    directory, settings: defaultSettings,
    retention: fakeRetention({
      runRetention: (store, settings, { now }) => {
        cycles += 1;
        return Object.freeze({ prunedAt: now, cleanupStatus: "normal", databaseBytes: store.sizeBytes(), oldestRetainedDay: null, removedMinuteSessions: 0, removedSampleSessions: 0 });
      },
    }),
  });
  await runtime.start();
  onClose(() => runtime.stop());
  runtime.afterCheckpointWrite();
  runtime.afterCheckpointWrite();
  await waitFor(() => cycles > 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cycles, 1);
});

test("a throwing contributor does not stop the cycle for other contributors or retention", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  let secondCalls = 0;
  const runtime = createMonitorStoreRuntime({ directory, settings: defaultSettings, retention: fakeRetention() });
  runtime.registerContributor({ name: "broken", onCheckpoint: async () => { throw new Error("contributor failure"); }, rebuildComplete: () => true });
  runtime.registerContributor({ name: "healthy", onCheckpoint: async () => { secondCalls += 1; }, rebuildComplete: () => true });
  await runtime.start();
  onClose(() => runtime.stop());
  runtime.afterCheckpointWrite();
  await waitFor(() => secondCalls > 0);
  await waitFor(() => runtime.serveStorage(null).snapshot.value.readiness === "ready");
});

test("runtime honors pruneMinIntervalMs before running a second retention pass", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  let prunes = 0;
  let facts = 0;
  const runtime = createMonitorStoreRuntime({
    directory, settings: defaultSettings, pruneMinIntervalMs: 60_000,
    retention: fakeRetention({
      runRetention: (store, settings, { now }) => {
        prunes += 1;
        return Object.freeze({ prunedAt: now, cleanupStatus: "normal", databaseBytes: store.sizeBytes(), oldestRetainedDay: null, removedMinuteSessions: 0, removedSampleSessions: 0 });
      },
      readStorageFacts: (store) => { facts += 1; return { databaseBytes: store.sizeBytes(), oldestRetainedDay: null }; },
    }),
  });
  await runtime.start();
  onClose(() => runtime.stop());
  runtime.afterCheckpointWrite();
  await waitFor(() => prunes === 1);
  runtime.afterCheckpointWrite();
  await waitFor(() => facts > 0);
  assert.equal(prunes, 1, "a second cycle within the prune interval must not prune again");
});

test("the real store-retention module integrates and reports numeric bytes once ready", async (t) => {
  const { directory, onClose } = await temporaryDirectory(t);
  const runtime = createMonitorStoreRuntime({ directory, settings: defaultSettings });
  await runtime.start();
  onClose(() => runtime.stop());
  runtime.afterCheckpointWrite();
  await waitFor(() => runtime.serveStorage(null).snapshot.value.readiness === "ready");
  const readiness = runtime.serveStorage(null).snapshot.value;
  assert.equal(typeof readiness.databaseBytes, "number");
  assert.equal(readiness.thresholdBytes, defaultSettings.thresholdBytes);
});

test("stop waits for an in-flight cycle before closing the store", async (t) => {
  const { directory } = await temporaryDirectory(t);
  let releaseCycle;
  const gate = new Promise((resolve) => { releaseCycle = resolve; });
  const runtime = createMonitorStoreRuntime({
    directory, settings: defaultSettings,
    // The very first cycle always runs the prune path (no prior prune timestamp yet), so
    // gate runRetention here to hold the cycle open while stop() is asserted mid-flight.
    retention: fakeRetention({
      runRetention: async (store, settings, { now }) => {
        await gate;
        return Object.freeze({ prunedAt: now, cleanupStatus: "normal", databaseBytes: store.sizeBytes(), oldestRetainedDay: null, removedMinuteSessions: 0, removedSampleSessions: 0 });
      },
    }),
  });
  await runtime.start();
  runtime.afterCheckpointWrite();
  await waitFor(() => runtime.store() !== null);
  const stopped = runtime.stop();
  let stoppedFirst = false;
  stopped.then(() => { stoppedFirst = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stoppedFirst, false, "stop must still be waiting on the in-flight cycle");
  releaseCycle();
  await stopped;
  assert.equal(stoppedFirst, true);
});
