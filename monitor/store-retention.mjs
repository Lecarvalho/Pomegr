// Monitor SQLite store retention: settings resolution, the age/size prune cycle, and the
// read-only facts and readiness projection. Runs only after checkpoint writes; never inside
// a GET, IPC, or HTTP handler. The only tables this module deletes from are resource_minutes
// and resource_peak_samples; resource_peaks, file_changes, files, file_paths, and meta are
// never touched here.

export const RETENTION_DAY_CHOICES = Object.freeze([30, 90, 180, 365, null]);
export const STORE_THRESHOLD_MB_CHOICES = Object.freeze([250, 500, 1024, 2048]);
export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_THRESHOLD_MB = 500;

const MS_PER_DAY = 86_400_000;
const STORAGE_READINESS_VALUES = new Set(["loading", "rebuilding", "ready", "unavailable"]);

function validChoice(value, choices) {
  return choices.includes(value) ? value : undefined;
}

function parseEnvRetentionDays(raw) {
  if (raw === "all") return null;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  return validChoice(Number(raw), [30, 90, 180, 365]);
}

function parseEnvThresholdMb(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  return validChoice(Number(raw), STORE_THRESHOLD_MB_CHOICES);
}

export function resolveRetentionSettings({ environment = process.env, desktop = null } = {}) {
  let retentionDays;
  let thresholdMb;
  if (desktop && typeof desktop === "object") {
    // Desktop settings win over environment entirely; each field is still validated against
    // the recognized choices before use, falling back to the default when it is not one of them.
    retentionDays = validChoice(desktop.retentionDays, RETENTION_DAY_CHOICES);
    thresholdMb = validChoice(desktop.thresholdMb, STORE_THRESHOLD_MB_CHOICES);
  } else {
    retentionDays = parseEnvRetentionDays(environment?.POMEGR_RETENTION_DAYS);
    thresholdMb = parseEnvThresholdMb(environment?.POMEGR_STORE_MAX_MB);
  }
  const resolvedRetentionDays = retentionDays === undefined ? DEFAULT_RETENTION_DAYS : retentionDays;
  const resolvedThresholdMb = thresholdMb === undefined ? DEFAULT_THRESHOLD_MB : thresholdMb;
  return Object.freeze({
    retentionDays: resolvedRetentionDays,
    thresholdMb: resolvedThresholdMb,
    thresholdBytes: resolvedThresholdMb * 1024 * 1024,
  });
}

function oldestSessionIds(database, table, column, limit) {
  return database.prepare(
    `SELECT session_id AS sessionId FROM ${table} GROUP BY session_id ORDER BY MIN(${column}) ASC LIMIT ?`,
  ).all(limit).map((row) => row.sessionId);
}

function findStaleSessionIds(database, cutoff) {
  const withMinutes = database.prepare(
    "SELECT session_id AS sessionId, MAX(minute_start) AS latest FROM resource_minutes GROUP BY session_id",
  ).all();
  const sampleOnly = database.prepare(`
    SELECT session_id AS sessionId, MAX(observed_at) AS latest
    FROM resource_peak_samples
    WHERE session_id NOT IN (SELECT DISTINCT session_id FROM resource_minutes)
    GROUP BY session_id
  `).all();
  const stale = [];
  for (const row of [...withMinutes, ...sampleOnly]) {
    if (typeof row.latest === "number" && row.latest < cutoff) stale.push(row.sessionId);
  }
  return stale;
}

function hasRemainingPrunableRows(database) {
  const row = database.prepare(
    "SELECT (EXISTS(SELECT 1 FROM resource_minutes) OR EXISTS(SELECT 1 FROM resource_peak_samples)) AS present",
  ).get();
  return Boolean(row?.present);
}

export function runRetention(store, settings, { now = Date.now(), maxSessionsPerCycle = 50 } = {}) {
  const database = store.database;
  let removedMinuteSessions = 0;
  let removedSampleSessions = 0;

  // 1. Age: drop resource_minutes and resource_peak_samples for sessions whose latest
  // observation is older than the retention window. Keep-all (`retentionDays === null`)
  // skips this entirely.
  if (settings.retentionDays !== null) {
    const cutoff = now - settings.retentionDays * MS_PER_DAY;
    const staleSessionIds = findStaleSessionIds(database, cutoff);
    if (staleSessionIds.length > 0) {
      store.transaction(() => {
        const deleteMinutes = database.prepare("DELETE FROM resource_minutes WHERE session_id = ?");
        const deleteSamples = database.prepare("DELETE FROM resource_peak_samples WHERE session_id = ?");
        const recordRemoval = database.prepare(
          "INSERT OR IGNORE INTO resource_curve_removals (session_id, reason, removed_at) VALUES (?, 'age_retention', ?)",
        );
        for (const sessionId of staleSessionIds) {
          if (deleteMinutes.run(sessionId).changes > 0) {
            removedMinuteSessions += 1;
            recordRemoval.run(sessionId, now);
          }
          if (deleteSamples.run(sessionId).changes > 0) removedSampleSessions += 1;
        }
      });
    }
  }

  // 2. Size: while the store is at or above the soft threshold, remove the oldest sessions'
  // resource_minutes first, then resource_peak_samples once no resource_minutes remain, up to
  // maxSessionsPerCycle sessions total.
  let databaseBytes = store.sizeBytes();
  if (databaseBytes >= settings.thresholdBytes) {
    store.vacuumIncremental();
    databaseBytes = store.sizeBytes();
  }
  let sessionsProcessed = 0;
  while (databaseBytes >= settings.thresholdBytes && sessionsProcessed < maxSessionsPerCycle) {
    const batchSize = Math.min(10, maxSessionsPerCycle - sessionsProcessed);
    const minuteSessionIds = oldestSessionIds(database, "resource_minutes", "minute_start", batchSize);
    if (minuteSessionIds.length > 0) {
      store.transaction(() => {
        const deleteMinutes = database.prepare("DELETE FROM resource_minutes WHERE session_id = ?");
        const recordRemoval = database.prepare(
          "INSERT OR IGNORE INTO resource_curve_removals (session_id, reason, removed_at) VALUES (?, 'size_cleanup', ?)",
        );
        for (const sessionId of minuteSessionIds) {
          deleteMinutes.run(sessionId);
          recordRemoval.run(sessionId, now);
        }
      });
      removedMinuteSessions += minuteSessionIds.length;
      sessionsProcessed += minuteSessionIds.length;
    } else {
      const sampleSessionIds = oldestSessionIds(database, "resource_peak_samples", "observed_at", batchSize);
      if (sampleSessionIds.length === 0) break;
      store.transaction(() => {
        const deleteSamples = database.prepare("DELETE FROM resource_peak_samples WHERE session_id = ?");
        for (const sessionId of sampleSessionIds) deleteSamples.run(sessionId);
      });
      removedSampleSessions += sampleSessionIds.length;
      sessionsProcessed += sampleSessionIds.length;
    }
    store.vacuumIncremental();
    databaseBytes = store.sizeBytes();
  }

  const facts = readStorageFacts(store);
  const cleanupStatus = facts.databaseBytes < settings.thresholdBytes
    ? "normal"
    : hasRemainingPrunableRows(database) ? "cleanup_pending" : "protected_excess";

  return Object.freeze({
    prunedAt: now,
    cleanupStatus,
    databaseBytes: facts.databaseBytes,
    oldestRetainedDay: facts.oldestRetainedDay,
    removedMinuteSessions,
    removedSampleSessions,
  });
}

export function readStorageFacts(store) {
  const databaseBytes = store.sizeBytes();
  const row = store.database.prepare("SELECT MIN(minute_start) AS earliest FROM resource_minutes").get();
  const oldestRetainedDay = typeof row?.earliest === "number"
    ? new Date(row.earliest).toISOString().slice(0, 10)
    : null;
  return { databaseBytes, oldestRetainedDay };
}

function safeDay(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function safeTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export function buildStorageReadiness({
  readiness,
  settings,
  databaseBytes = null,
  oldestRetainedDay = null,
  lastPrunedAt = null,
  cleanupStatus = null,
}) {
  const bytes = Number.isSafeInteger(databaseBytes) && databaseBytes >= 0 ? databaseBytes : null;
  return {
    readiness: STORAGE_READINESS_VALUES.has(readiness) ? readiness : "unavailable",
    databaseBytes: bytes,
    thresholdBytes: settings.thresholdBytes,
    // Floor so 99.5% never reads "100%" while the status is still normal.
    percent: bytes === null ? null : Math.floor((bytes / settings.thresholdBytes) * 100),
    oldestRetainedDay: safeDay(oldestRetainedDay),
    lastPrunedAt: safeTimestamp(lastPrunedAt),
    retentionDays: settings.retentionDays,
    cleanupStatus: bytes === null ? null : cleanupStatus,
  };
}
