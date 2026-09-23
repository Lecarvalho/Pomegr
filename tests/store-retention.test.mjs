import assert from "node:assert/strict";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEFAULT_RETENTION_DAYS,
  DEFAULT_THRESHOLD_MB,
  RETENTION_DAY_CHOICES,
  STORE_THRESHOLD_MB_CHOICES,
  buildStorageReadiness,
  readStorageFacts,
  resolveRetentionSettings,
  runRetention,
} from "../monitor/store-retention.mjs";
import { createRequestHandler } from "../monitor/request-handler.mjs";
import { createCommittedResponseCache } from "../monitor/committed-response-cache.mjs";
import { startLanGateway } from "../desktop/lan-gateway.mjs";

const MS_PER_DAY = 86_400_000;
const RESOURCE_FIELDS = ["cpu_cores", "cpu_machine_percent", "memory_bytes", "read_bps", "write_bps"];

function resourceMinuteColumns() {
  return RESOURCE_FIELDS.map((field) => `${field}_min REAL, ${field}_avg REAL, ${field}_max REAL, ${field}_max_at INTEGER`).join(", ");
}

/** A fake store over a real in-memory node:sqlite database, matching the plan DDL. */
function createFakeStore({ bytesPerRow = 100, baseBytes = 0 } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE files (
      id INTEGER PRIMARY KEY,
      repository_id TEXT NOT NULL,
      current_path TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE file_changes (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      session_id TEXT,
      agent_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'deleted', 'moved')),
      observed_at INTEGER NOT NULL,
      request_number INTEGER
    );
    CREATE TABLE resource_minutes (
      session_id TEXT NOT NULL,
      minute_start INTEGER NOT NULL,
      ${resourceMinuteColumns()},
      PRIMARY KEY (session_id, minute_start)
    ) WITHOUT ROWID;
    CREATE TABLE resource_peaks (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      field TEXT NOT NULL CHECK (field IN ('cpu_cores', 'cpu_machine_percent', 'memory_bytes', 'read_bps', 'write_bps')),
      observed_at INTEGER NOT NULL,
      value REAL NOT NULL,
      matched_task_ids TEXT NOT NULL DEFAULT '[]',
      matched_request_number INTEGER
    );
    CREATE TABLE resource_peak_samples (
      session_id TEXT NOT NULL,
      peak_id INTEGER NOT NULL REFERENCES resource_peaks(id) ON DELETE CASCADE,
      observed_at INTEGER NOT NULL,
      cpu_cores REAL, cpu_machine_percent REAL, memory_bytes REAL, read_bps REAL, write_bps REAL,
      PRIMARY KEY (peak_id, observed_at)
    ) WITHOUT ROWID;
  `);
  const rowCount = () => {
    const minutes = database.prepare("SELECT COUNT(*) AS n FROM resource_minutes").get().n;
    const samples = database.prepare("SELECT COUNT(*) AS n FROM resource_peak_samples").get().n;
    return minutes + samples;
  };
  return {
    database,
    transaction(fn) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* best-effort rollback */ }
        throw error;
      }
    },
    sizeBytes() { return baseBytes + rowCount() * bytesPerRow; },
    vacuumIncremental() { /* no-op: this fake derives size from live row counts */ },
    close() { database.close(); },
  };
}

function insertMinute(store, sessionId, minuteStart) {
  store.database.prepare("INSERT INTO resource_minutes (session_id, minute_start) VALUES (?, ?)").run(sessionId, minuteStart);
}

function insertPeak(store, { id, sessionId, field = "cpu_cores", observedAt, value = 1 }) {
  store.database.prepare(
    "INSERT INTO resource_peaks (id, session_id, field, observed_at, value) VALUES (?, ?, ?, ?, ?)",
  ).run(id, sessionId, field, observedAt, value);
}

function insertSample(store, sessionId, peakId, observedAt) {
  store.database.prepare(
    "INSERT INTO resource_peak_samples (session_id, peak_id, observed_at) VALUES (?, ?, ?)",
  ).run(sessionId, peakId, observedAt);
}

function insertFileChangeFixture(store) {
  store.database.exec("INSERT INTO files (id, repository_id, current_path, first_seen_at) VALUES (1, 'repo-fixture', 'src/index.ts', 0)");
  store.database.exec("INSERT INTO file_changes (id, file_id, session_id, kind, observed_at) VALUES (1, 1, 'any-session', 'edited', 0)");
}

function distinctSessionIds(store, table) {
  return store.database.prepare(`SELECT DISTINCT session_id AS sessionId FROM ${table} ORDER BY sessionId`).all().map((row) => row.sessionId);
}

test("resolveRetentionSettings: environment parsing, keep-all, junk fallback, and desktop precedence", () => {
  assert.deepEqual(resolveRetentionSettings({ environment: {} }), {
    retentionDays: DEFAULT_RETENTION_DAYS, thresholdMb: DEFAULT_THRESHOLD_MB, thresholdBytes: DEFAULT_THRESHOLD_MB * 1024 * 1024,
  });
  assert.deepEqual(resolveRetentionSettings({ environment: { POMEGR_RETENTION_DAYS: "180", POMEGR_STORE_MAX_MB: "1024" } }), {
    retentionDays: 180, thresholdMb: 1024, thresholdBytes: 1024 * 1024 * 1024,
  });
  assert.equal(resolveRetentionSettings({ environment: { POMEGR_RETENTION_DAYS: "all" } }).retentionDays, null);
  const junk = resolveRetentionSettings({ environment: { POMEGR_RETENTION_DAYS: "45", POMEGR_STORE_MAX_MB: "999" } });
  assert.equal(junk.retentionDays, DEFAULT_RETENTION_DAYS);
  assert.equal(junk.thresholdMb, DEFAULT_THRESHOLD_MB);
  assert.deepEqual(resolveRetentionSettings({
    environment: { POMEGR_RETENTION_DAYS: "30", POMEGR_STORE_MAX_MB: "250" },
    desktop: { retentionDays: 365, thresholdMb: 2048 },
  }), { retentionDays: 365, thresholdMb: 2048, thresholdBytes: 2048 * 1024 * 1024 });
  assert.equal(resolveRetentionSettings({ desktop: { retentionDays: null, thresholdMb: 500 } }).retentionDays, null);
  const desktopJunk = resolveRetentionSettings({
    environment: { POMEGR_RETENTION_DAYS: "30", POMEGR_STORE_MAX_MB: "250" },
    desktop: { retentionDays: 999, thresholdMb: "lots" },
  });
  assert.equal(desktopJunk.retentionDays, DEFAULT_RETENTION_DAYS, "desktop wins over environment even when its own field is invalid");
  assert.equal(desktopJunk.thresholdMb, DEFAULT_THRESHOLD_MB);
  assert.deepEqual(RETENTION_DAY_CHOICES, [30, 90, 180, 365, null]);
  assert.deepEqual(STORE_THRESHOLD_MB_CHOICES, [250, 500, 1024, 2048]);
});

test("runRetention: age deletion removes only sessions whose latest evidence predates the cutoff", () => {
  const store = createFakeStore();
  const now = 1_000 * MS_PER_DAY;
  insertMinute(store, "fresh", now - 10 * MS_PER_DAY);
  insertMinute(store, "stale", now - 400 * MS_PER_DAY);
  insertPeak(store, { id: 1, sessionId: "fresh-samples", observedAt: now - 5 * MS_PER_DAY });
  insertSample(store, "fresh-samples", 1, now - 5 * MS_PER_DAY);
  insertPeak(store, { id: 2, sessionId: "stale-samples", observedAt: now - 500 * MS_PER_DAY });
  insertSample(store, "stale-samples", 2, now - 500 * MS_PER_DAY);
  const settings = { retentionDays: 90, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 };
  const result = runRetention(store, settings, { now, maxSessionsPerCycle: 50 });
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), ["fresh"]);
  assert.deepEqual(distinctSessionIds(store, "resource_peak_samples"), ["fresh-samples"]);
  assert.equal(result.removedMinuteSessions, 1);
  assert.equal(result.removedSampleSessions, 1);
  assert.equal(result.cleanupStatus, "normal");
});

test("runRetention: retentionDays null (keep all) never deletes by age", () => {
  const store = createFakeStore();
  insertMinute(store, "ancient", 0);
  const settings = { retentionDays: null, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 };
  runRetention(store, settings, { now: 1_000 * MS_PER_DAY });
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), ["ancient"]);
});

test("runRetention: size cleanup removes resource_minutes across full sessions before ever touching resource_peak_samples", () => {
  const store = createFakeStore({ bytesPerRow: 100 });
  for (let index = 0; index < 12; index += 1) insertMinute(store, `m${index}`, index);
  insertPeak(store, { id: 1, sessionId: "s0", observedAt: 0 });
  insertSample(store, "s0", 1, 0);
  const settings = { retentionDays: null, thresholdMb: 500, thresholdBytes: 150 };
  const result = runRetention(store, settings, { now: Date.now() });
  assert.equal(result.removedMinuteSessions, 12);
  assert.equal(result.removedSampleSessions, 0);
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), []);
  assert.deepEqual(distinctSessionIds(store, "resource_peak_samples"), ["s0"]);
});

test("runRetention: size cleanup falls through to resource_peak_samples once no resource_minutes rows remain", () => {
  const store = createFakeStore({ bytesPerRow: 100 });
  insertPeak(store, { id: 1, sessionId: "s0", observedAt: 0 });
  insertSample(store, "s0", 1, 0);
  insertPeak(store, { id: 2, sessionId: "s1", observedAt: 1 });
  insertSample(store, "s1", 2, 1);
  insertPeak(store, { id: 3, sessionId: "s2", observedAt: 2 });
  insertSample(store, "s2", 3, 2);
  const settings = { retentionDays: null, thresholdMb: 500, thresholdBytes: 150 };
  const result = runRetention(store, settings, { now: Date.now() });
  assert.equal(result.removedMinuteSessions, 0);
  assert.equal(result.removedSampleSessions, 3);
  assert.equal(result.databaseBytes, 0);
  assert.equal(result.cleanupStatus, "normal");
});

test("runRetention: cleanup_pending when the per-cycle session cap stops the cleanup short", () => {
  const store = createFakeStore({ bytesPerRow: 100 });
  for (let index = 0; index < 5; index += 1) insertMinute(store, `m${index}`, index);
  const settings = { retentionDays: null, thresholdMb: 500, thresholdBytes: 100 };
  const result = runRetention(store, settings, { now: Date.now(), maxSessionsPerCycle: 2 });
  assert.equal(result.removedMinuteSessions, 2);
  assert.equal(result.cleanupStatus, "cleanup_pending");
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), ["m2", "m3", "m4"]);
});

test("runRetention: protected_excess when only protected tables keep bytes above threshold", () => {
  const store = createFakeStore({ bytesPerRow: 100, baseBytes: 1_000 });
  insertMinute(store, "m0", 0);
  insertPeak(store, { id: 1, sessionId: "s0", observedAt: 0 });
  insertSample(store, "s0", 1, 0);
  const settings = { retentionDays: null, thresholdMb: 500, thresholdBytes: 500 };
  const result = runRetention(store, settings, { now: Date.now() });
  assert.equal(result.databaseBytes, 1_000);
  assert.equal(result.cleanupStatus, "protected_excess");
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), []);
  assert.deepEqual(distinctSessionIds(store, "resource_peak_samples"), []);
});

test("resource_peaks, file_changes, and files survive age deletion, size cleanup, and protected_excess", () => {
  const store = createFakeStore({ bytesPerRow: 100, baseBytes: 1_000 });
  insertFileChangeFixture(store);
  insertPeak(store, { id: 1, sessionId: "s0", observedAt: 0 });
  insertSample(store, "s0", 1, 0);
  for (let index = 0; index < 5; index += 1) insertMinute(store, `m${index}`, index * MS_PER_DAY);
  const settings = { retentionDays: 30, thresholdMb: 500, thresholdBytes: 500 };
  const result = runRetention(store, settings, { now: 200 * MS_PER_DAY });
  assert.equal(result.cleanupStatus, "protected_excess");
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM resource_peaks").get().n, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM file_changes").get().n, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM resource_minutes").get().n, 0);
  assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM resource_peak_samples").get().n, 0);
});

test("readStorageFacts is read-only and reports the min(minute_start) day or null", () => {
  const store = createFakeStore();
  assert.deepEqual(readStorageFacts(store), { databaseBytes: 0, oldestRetainedDay: null });
  insertMinute(store, "s0", Date.UTC(2026, 0, 15));
  insertMinute(store, "s1", Date.UTC(2026, 2, 1));
  const facts = readStorageFacts(store);
  assert.equal(facts.oldestRetainedDay, "2026-01-15");
  assert.equal(facts.databaseBytes, store.sizeBytes());
  assert.deepEqual(distinctSessionIds(store, "resource_minutes"), ["s0", "s1"], "read-only: nothing was deleted");
});

test("buildStorageReadiness: percent rounding over 100, null bytes, and the exact allowed key set", () => {
  const settings = resolveRetentionSettings({ environment: { POMEGR_STORE_MAX_MB: "500" } });
  const ready = buildStorageReadiness({
    readiness: "ready", settings, databaseBytes: 550 * 1024 * 1024,
    oldestRetainedDay: "2026-01-01", lastPrunedAt: "2026-09-22T00:00:00.000Z", cleanupStatus: "cleanup_pending",
  });
  assert.equal(ready.percent, 110);
  const almost = buildStorageReadiness({ readiness: "ready", settings, databaseBytes: Math.ceil(settings.thresholdBytes * 0.995), cleanupStatus: "normal" });
  assert.equal(almost.percent, 99, "below the threshold never reads 100%");
  const allowedKeys = ["cleanupStatus", "databaseBytes", "lastPrunedAt", "oldestRetainedDay", "percent", "readiness", "retentionDays", "thresholdBytes"];
  assert.deepEqual(Object.keys(ready).sort(), allowedKeys);
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(ready))).sort(), allowedKeys);

  const unavailable = buildStorageReadiness({ readiness: "unavailable", settings });
  assert.equal(unavailable.databaseBytes, null);
  assert.equal(unavailable.percent, null);
  assert.equal(unavailable.cleanupStatus, null, "cleanupStatus is null whenever bytes are unknown, regardless of input");
});

test("buildStorageReadiness never spreads arbitrary input", () => {
  const settings = { retentionDays: 90, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 };
  const result = buildStorageReadiness({
    readiness: "ready", settings, databaseBytes: 10, oldestRetainedDay: "2026-01-01", lastPrunedAt: "2026-01-01T00:00:00.000Z",
    cleanupStatus: "normal", secretPath: "C:\\private\\monitor-store-v1\\monitor.sqlite", extra: 1,
  });
  assert.equal(result.secretPath, undefined);
  assert.equal(result.extra, undefined);
  assert.equal(buildStorageReadiness({ readiness: "not-a-real-readiness", settings }).readiness, "unavailable");
});

test("HTTP /api/storage serves only committed responses with revisions; POST is 405; a throw is 503 unavailable", async (t) => {
  const settings = { retentionDays: 90, thresholdMb: 500, thresholdBytes: 500 * 1024 * 1024 };
  const cache = createCommittedResponseCache({ includeRevision: true });
  cache.commit(buildStorageReadiness({ readiness: "ready", settings, databaseBytes: 10, cleanupStatus: "normal" }));

  const server = http.createServer(createRequestHandler({ runtime: { serveStorage: cache.read } }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/storage`;

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const revision = response.headers.get("x-pomegr-revision");
  assert.ok(revision);
  const body = await response.json();
  assert.equal(body.readiness, "ready");
  assert.equal(body.revision, Number(revision));

  assert.equal((await fetch(`${url}?revision=${revision}`)).status, 204);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  const postResponse = await fetch(url, { method: "POST" });
  assert.equal(postResponse.headers.get("allow"), "GET");

  const throwingServer = http.createServer(createRequestHandler({ runtime: { serveStorage: () => { throw new Error("boom"); } } }));
  await new Promise((resolve) => throwingServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { throwingServer.closeAllConnections(); throwingServer.close(resolve); }));
  const throwingUrl = `http://127.0.0.1:${throwingServer.address().port}/api/storage`;
  const failed = await fetch(throwingUrl);
  assert.equal(failed.status, 503);
  const failedBody = await failed.json();
  assert.equal(failedBody.readiness, "unavailable");
  assert.equal(failedBody.databaseBytes, null);

  const unwiredServer = http.createServer(createRequestHandler({ runtime: {} }));
  await new Promise((resolve) => unwiredServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { unwiredServer.closeAllConnections(); unwiredServer.close(resolve); }));
  const unwiredResponse = await fetch(`http://127.0.0.1:${unwiredServer.address().port}/api/storage`);
  assert.equal(unwiredResponse.status, 200);
  const unwiredBody = await unwiredResponse.json();
  assert.equal(unwiredBody.readiness, "unavailable");
});

test("LAN gateway forwards only GET/HEAD for /api/storage; POST is rejected before reaching retention", async (t) => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ readiness: "ready" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const loopbackTestNetwork = Object.freeze({
    isBindHostAllowed: (host, mask) => host === "127.0.0.1" && mask === "255.255.255.0",
    isClientAddressAllowed: (address) => address === "127.0.0.1",
  });
  const gateway = await startLanGateway({
    host: "127.0.0.1", subnetMask: "255.255.255.0", upstreamOrigin,
    authorizationToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    isNetworkAllowed: async () => true, networkPolicy: loopbackTestNetwork,
  });
  t.after(() => gateway.close());
  const created = gateway.createPairing();
  const secret = new URL(created.url).hash.slice(1);
  const paired = await fetch(`${gateway.origin}/__pomegr/pair`, {
    method: "POST", headers: { Origin: gateway.origin, "Content-Type": "application/json" }, body: JSON.stringify({ secret }),
  });
  const cookie = paired.headers.get("set-cookie").split(";", 1)[0];

  const get = await fetch(`${gateway.origin}/api/storage`, { headers: { Cookie: cookie } });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { readiness: "ready" });

  const post = await fetch(`${gateway.origin}/api/storage`, { method: "POST", headers: { Cookie: cookie } });
  assert.equal(post.status, 405);
});
