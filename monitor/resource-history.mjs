// Per-session resource history: minute aggregates with exact max timestamps, the
// top-ten peaks per field, raw sample windows around each peak, and deterministic
// peak-to-task/request matching. See docs/METRICS.md ("Resource history") and
// docs/OBSERVATION_CACHE.md for the persisted contract and checkpoint cadence.
//
// Privacy: rows persisted here carry only a normalized session ID, execution-task
// IDs, request numbers, timestamps, and numeric measurements. No PIDs, process
// identities, paths, command text, labels, or raw provider evidence.

import { matchResourcePeak } from "./resource-peak-matching.mjs";

const MINUTE_MS = 60_000;
const TOP_PEAKS_PER_FIELD = 10;
const PEAK_WINDOW_MS = 120_000; // two minutes each side of the peak sample

// Ordered pairing of a resource_minutes/resource_peaks column prefix (snake_case,
// matches the fixed DDL in monitor/monitor-store.mjs) to the sampler's camelCase
// measurement field.
const FIELDS = Object.freeze([
  { column: "cpu_cores", field: "cpu_cores", sampleKey: "cpuCores" },
  { column: "cpu_machine_percent", field: "cpu_machine_percent", sampleKey: "cpuMachinePercent" },
  { column: "memory_bytes", field: "memory_bytes", sampleKey: "memoryBytes" },
  { column: "read_bps", field: "read_bps", sampleKey: "readBytesPerSecond" },
  { column: "write_bps", field: "write_bps", sampleKey: "writeBytesPerSecond" },
]);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function sampleTimeMs(sample) {
  const parsed = Date.parse(sample?.timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function minuteStartOf(timeMs) {
  return Math.floor(timeMs / MINUTE_MS) * MINUTE_MS;
}

/**
 * Aggregates one minute's samples into { field -> { min, avg, max, maxAtMs } }.
 * Non-null values only; a field with no non-null sample in the minute is entirely
 * null. Ties on max value are won by the earliest sample timestamp.
 */
function aggregateMinute(samples) {
  const aggregates = {};
  let anyField = false;
  for (const { field, sampleKey } of FIELDS) {
    let min = null;
    let max = null;
    let maxAtMs = null;
    let sum = 0;
    let count = 0;
    for (const sample of samples) {
      const value = sample[sampleKey];
      if (!isFiniteNumber(value)) continue;
      const timeMs = sample.__timeMs;
      if (min === null || value < min) min = value;
      if (max === null || value > max || (value === max && timeMs < maxAtMs)) {
        max = value;
        maxAtMs = timeMs;
      }
      sum += value;
      count += 1;
    }
    if (count > 0) {
      anyField = true;
      aggregates[field] = { min, avg: sum / count, max, maxAtMs };
    } else {
      aggregates[field] = { min: null, avg: null, max: null, maxAtMs: null };
    }
  }
  return anyField ? aggregates : null;
}

function upsertMinuteRow(store, sessionId, minuteStart, aggregates) {
  const columns = ["session_id", "minute_start"];
  const values = [sessionId, minuteStart];
  const placeholders = ["?", "?"];
  for (const { column } of FIELDS) {
    const stats = aggregates[column];
    columns.push(`${column}_min`, `${column}_avg`, `${column}_max`, `${column}_max_at`);
    values.push(stats.min, stats.avg, stats.max, stats.maxAtMs);
    placeholders.push("?", "?", "?", "?");
  }
  store.database.prepare(
    `INSERT OR REPLACE INTO resource_minutes (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`,
  ).run(...values);
}

/** Finds (or creates) the single peak row for this session/field/minute and writes its value. */
function upsertPeakCandidate(store, sessionId, field, minuteStart, observedAtMs, value) {
  const existing = store.database.prepare(
    "SELECT id FROM resource_peaks WHERE session_id = ? AND field = ? AND observed_at >= ? AND observed_at < ?",
  ).get(sessionId, field, minuteStart, minuteStart + MINUTE_MS);
  if (existing) {
    store.database.prepare("UPDATE resource_peaks SET observed_at = ?, value = ? WHERE id = ?")
      .run(observedAtMs, value, existing.id);
    return;
  }
  store.database.prepare(
    "INSERT INTO resource_peaks (session_id, field, observed_at, value, matched_task_ids, matched_request_number) VALUES (?, ?, ?, ?, '[]', NULL)",
  ).run(sessionId, field, observedAtMs, value);
}

/** Evicts every peak past the top ten (by value desc, earlier observed_at wins ties) per field. */
function evictExcessPeaks(store, sessionId) {
  for (const { field } of FIELDS) {
    const rows = store.database.prepare(
      "SELECT id FROM resource_peaks WHERE session_id = ? AND field = ? ORDER BY value DESC, observed_at ASC",
    ).all(sessionId, field);
    const evictable = rows.slice(TOP_PEAKS_PER_FIELD);
    for (const row of evictable) {
      store.database.prepare("DELETE FROM resource_peak_samples WHERE peak_id = ?").run(row.id);
      store.database.prepare("DELETE FROM resource_peaks WHERE id = ?").run(row.id);
    }
  }
}

function retainedPeaks(store, sessionId) {
  return store.database.prepare(
    "SELECT id, field, observed_at AS observedAt FROM resource_peaks WHERE session_id = ?",
  ).all(sessionId);
}

/** The latest in-memory sample strictly before `beforeMs`, or null when none is retained. */
function precedingSampleMs(sortedSamples, beforeMs) {
  let preceding = null;
  for (const sample of sortedSamples) {
    if (sample.__timeMs < beforeMs) preceding = sample.__timeMs;
    else break;
  }
  return preceding;
}

function updatePeakMatch(store, peakId, taskIds, requestNumber) {
  store.database.prepare("UPDATE resource_peaks SET matched_task_ids = ?, matched_request_number = ? WHERE id = ?")
    .run(JSON.stringify([...taskIds].sort()), requestNumber, peakId);
}

function writeSampleWindow(store, sessionId, peakId, observedAtMs, sortedSamples) {
  const lower = observedAtMs - PEAK_WINDOW_MS;
  const upper = observedAtMs + PEAK_WINDOW_MS;
  const statement = store.database.prepare(
    `INSERT OR IGNORE INTO resource_peak_samples
       (session_id, peak_id, observed_at, cpu_cores, cpu_machine_percent, memory_bytes, read_bps, write_bps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const sample of sortedSamples) {
    if (sample.__timeMs < lower || sample.__timeMs > upper) continue;
    statement.run(
      sessionId,
      peakId,
      sample.__timeMs,
      isFiniteNumber(sample.cpuCores) ? sample.cpuCores : null,
      isFiniteNumber(sample.cpuMachinePercent) ? sample.cpuMachinePercent : null,
      isFiniteNumber(sample.memoryBytes) ? sample.memoryBytes : null,
      isFiniteNumber(sample.readBytesPerSecond) ? sample.readBytesPerSecond : null,
      isFiniteNumber(sample.writeBytesPerSecond) ? sample.writeBytesPerSecond : null,
    );
  }
}

function processSession(store, sessionId, allSamples, cursorMs, tasks, latestObservationMs) {
  const timed = allSamples
    .map((sample) => ({ ...sample, __timeMs: sampleTimeMs(sample) }))
    .filter((sample) => sample.__timeMs !== null)
    .sort((left, right) => left.__timeMs - right.__timeMs);
  if (timed.length === 0) return cursorMs;

  const sinceFilter = cursorMs === null ? Number.NEGATIVE_INFINITY : cursorMs - 1;
  const relevant = timed.filter((sample) => sample.__timeMs > sinceFilter);
  if (relevant.length === 0) return cursorMs;

  const byMinute = new Map();
  for (const sample of relevant) {
    const minuteStart = minuteStartOf(sample.__timeMs);
    if (!byMinute.has(minuteStart)) byMinute.set(minuteStart, []);
    byMinute.get(minuteStart).push(sample);
  }
  const minuteStarts = [...byMinute.keys()].sort((left, right) => left - right);

  store.transaction(() => {
    for (const minuteStart of minuteStarts) {
      const aggregates = aggregateMinute(byMinute.get(minuteStart));
      if (!aggregates) continue; // all-null minute: not written, no peak candidate
      upsertMinuteRow(store, sessionId, minuteStart, aggregates);
      for (const { column, field } of FIELDS) {
        const stats = aggregates[column];
        if (stats.max === null) continue;
        upsertPeakCandidate(store, sessionId, field, minuteStart, stats.maxAtMs, stats.max);
      }
    }

    evictExcessPeaks(store, sessionId);

    for (const peak of retainedPeaks(store, sessionId)) {
      const toMs = peak.observedAt;
      const fromMsCandidate = precedingSampleMs(timed, toMs);
      const fromMs = fromMsCandidate === null ? toMs : fromMsCandidate;
      const { taskIds, requestNumber } = matchResourcePeak({ fromMs, toMs, tasks, latestObservationMs });
      updatePeakMatch(store, peak.id, taskIds, requestNumber);
      writeSampleWindow(store, sessionId, peak.id, toMs, timed);
    }
  });

  return minuteStarts[minuteStarts.length - 1];
}

/**
 * Returns a monitor-store contributor that persists resource history on the
 * checkpoint cadence. Resource history cannot be rebuilt from anything else, so a
 * rebuilt (empty) database is immediately ready.
 */
export function createResourceHistoryContributor({ sampler, sessionInputs } = {}) {
  if (!sampler || typeof sampler.samplesSince !== "function" || typeof sessionInputs !== "function") {
    throw new TypeError("Resource history contributor requires a sampler and sessionInputs()");
  }
  const minuteCursors = new Map();

  async function onCheckpoint(store) {
    let inputs;
    try {
      inputs = await sessionInputs();
    } catch {
      return; // no session inputs this cycle; nothing to persist
    }
    if (!Array.isArray(inputs)) return;
    for (const input of inputs) {
      const sessionId = input?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      try {
        const samples = sampler.samplesSince(sessionId, Number.NEGATIVE_INFINITY);
        if (!Array.isArray(samples) || samples.length === 0) continue;
        const tasks = Array.isArray(input.tasks) ? input.tasks : [];
        const latestObservationMs = isFiniteNumber(input.latestObservationMs) ? input.latestObservationMs : null;
        const cursor = minuteCursors.has(sessionId) ? minuteCursors.get(sessionId) : null;
        const nextCursor = processSession(store, sessionId, samples, cursor, tasks, latestObservationMs);
        if (nextCursor !== null && nextCursor !== undefined) minuteCursors.set(sessionId, nextCursor);
      } catch {
        // A failure for one session skips that session only; other sessions and
        // the checkpoint cycle itself continue.
      }
    }
  }

  return Object.freeze({
    name: "resource-history",
    onCheckpoint,
    rebuildComplete: () => true,
  });
}

function camelizeMinuteRow(row) {
  const out = { sessionId: row.session_id, minuteStart: row.minute_start };
  for (const { column } of FIELDS) {
    const camel = column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    out[`${camel}Min`] = row[`${column}_min`];
    out[`${camel}Avg`] = row[`${column}_avg`];
    out[`${camel}Max`] = row[`${column}_max`];
    out[`${camel}MaxAt`] = row[`${column}_max_at`];
  }
  return out;
}

function parseMatchedTaskIds(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Pure, synchronous read interface over the committed resource-history tables.
 * Never acquires provider evidence; safe to call from a serving-side GET.
 */
export function createResourceHistoryQueries(store) {
  return Object.freeze({
    sessionResourceCurves(sessionId, { fromMs, toMs } = {}) {
      const clauses = ["session_id = ?"];
      const params = [sessionId];
      if (isFiniteNumber(fromMs)) { clauses.push("minute_start >= ?"); params.push(fromMs); }
      if (isFiniteNumber(toMs)) { clauses.push("minute_start <= ?"); params.push(toMs); }
      const rows = store.database.prepare(
        `SELECT * FROM resource_minutes WHERE ${clauses.join(" AND ")} ORDER BY minute_start ASC`,
      ).all(...params);
      return rows.map(camelizeMinuteRow);
    },

    sessionResourcePeaks(sessionId) {
      const rows = store.database.prepare(
        "SELECT id, field, observed_at AS observedAtMs, value, matched_task_ids AS matchedTaskIds, matched_request_number AS matchedRequestNumber "
        + "FROM resource_peaks WHERE session_id = ? ORDER BY field ASC, value DESC",
      ).all(sessionId);
      return rows.map((row) => ({
        id: row.id,
        sessionId,
        field: row.field,
        observedAtMs: row.observedAtMs,
        value: row.value,
        matchedTaskIds: parseMatchedTaskIds(row.matchedTaskIds),
        matchedRequestNumber: row.matchedRequestNumber,
      }));
    },

    peakSampleWindow(peakId) {
      const rows = store.database.prepare(
        "SELECT observed_at AS observedAtMs, cpu_cores AS cpuCores, cpu_machine_percent AS cpuMachinePercent, "
        + "memory_bytes AS memoryBytes, read_bps AS readBps, write_bps AS writeBps "
        + "FROM resource_peak_samples WHERE peak_id = ? ORDER BY observed_at ASC",
      ).all(peakId);
      return rows.length === 0 ? null : rows;
    },
  });
}

/**
 * Input adapter for the contributor: live sessions the sampler currently tracks, with
 * normalized execution-task intervals and the latest recorded observation instant from
 * committed L1 evidence. Request numbers live only in the async, disk-backed session-history
 * store, so every task carries requestNumber null and peaks get no request link yet.
 */
export function createResourceHistorySessionInputs({ observationStore, sampler }) {
  return function sessionInputs() {
    const inputs = [];
    for (const snapshot of observationStore.entries()) {
      const sessionId = snapshot.qualifiedId;
      if (!sampler.get(sessionId)) continue;
      const evidence = snapshot.evidence || {};
      const tasks = [];
      for (const agent of evidence.agents || []) {
        for (const task of agent.executionTasks || []) {
          const startedAtMs = Date.parse(task?.startedAt);
          if (!Number.isFinite(startedAtMs)) continue;
          const finishedAtMs = task.finishedAt ? Date.parse(task.finishedAt) : null;
          tasks.push({ id: task.id, startedAtMs, finishedAtMs: Number.isFinite(finishedAtMs) ? finishedAtMs : null, requestNumber: null });
        }
      }
      const latestObservationMs = Date.parse(evidence.session?.updatedAt || "");
      inputs.push({ sessionId, tasks, latestObservationMs: Number.isFinite(latestObservationMs) ? latestObservationMs : null });
    }
    return inputs;
  };
}

const STORE_NUDGE_MS = 60_000;

/**
 * Registers the contributor on the monitor store runtime and returns `sampleAndSchedule`,
 * which the resource observation uses in place of `sampler.sample`. Checkpoints fire only
 * on evidence changes, so a quiet live session (a long build) could outlive the sampler's
 * 30-minute raw window unpersisted; after sampling at least one session it schedules the
 * coalesced store cycle at most once per minute. With persistence disabled, or a sampler
 * that cannot be drained, it only samples.
 */
export function attachResourceHistory({ enabled = true, monitorStoreRuntime, sampler, observationStore, now = Date.now }) {
  const attached = enabled && typeof monitorStoreRuntime?.registerContributor === "function"
    && typeof sampler?.samplesSince === "function";
  if (attached) {
    monitorStoreRuntime.registerContributor(createResourceHistoryContributor({
      sampler,
      sessionInputs: createResourceHistorySessionInputs({ observationStore, sampler }),
    }));
  }
  let lastNudgeMs = null;
  return Object.freeze({
    async sampleAndSchedule(targets) {
      const result = await sampler.sample(targets);
      if (!attached || !Array.isArray(targets) || targets.length === 0) return result;
      const nowMs = now();
      if (lastNudgeMs === null || nowMs - lastNudgeMs >= STORE_NUDGE_MS) {
        lastNudgeMs = nowMs;
        monitorStoreRuntime.afterCheckpointWrite?.();
      }
      return result;
    },
  });
}
