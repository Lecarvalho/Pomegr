// Committed source for the session `resources` domain's retained (SQLite-backed) block:
// minute curves, curve-removal explanations, and matched peaks with their sample windows.
// Built on the monitor-store checkpoint cycle only; `retained()` is a pure in-memory map
// lookup so a domain GET never triggers a synchronous SQLite read. See
// docs/OBSERVATION_CACHE.md for the committed-domain-cache contract this follows.
//
// Privacy: the block carries only normalized session/peak/task identity, ISO timestamps,
// bounded numeric aggregates, and bounded retention-reason enums. No PIDs, process
// identity, paths, command text, or raw provider evidence.

import { createResourceHistoryQueries } from "./resource-history.mjs";

const MINUTE_MS = 60_000;
const MAX_MINUTES = 1440;
const TOP_PEAKS_PER_FIELD = 3;
const MAX_DEMANDED_SESSIONS_PER_CYCLE = 32;

// The four display fields the resources domain shows curves and peaks for.
// cpu_machine_percent is sampled live only and is dropped here.
const DISPLAY_FIELDS = new Set(["cpu_cores", "memory_bytes", "read_bps", "write_bps"]);
const FIELD_SAMPLE_KEY = Object.freeze({
  cpu_cores: "cpuCores",
  memory_bytes: "memoryBytes",
  read_bps: "readBps",
  write_bps: "writeBps",
});

const EMPTY_RETAINED = Object.freeze({
  minutes: Object.freeze([]),
  minutesTruncated: false,
  curveRemoval: null,
  peaks: Object.freeze([]),
});
const LOADING_BLOCK = Object.freeze({ readiness: "loading", ...EMPTY_RETAINED });
const UNAVAILABLE_BLOCK = Object.freeze({ readiness: "unavailable", ...EMPTY_RETAINED });
const REBUILDING_BLOCK = Object.freeze({ readiness: "rebuilding", ...EMPTY_RETAINED });

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isoOrNull(ms) {
  return isFiniteNumber(ms) ? new Date(ms).toISOString() : null;
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function aggregateFromRow(row, prefix) {
  const min = row[`${prefix}Min`];
  const max = row[`${prefix}Max`];
  if (!isFiniteNumber(min) || !isFiniteNumber(max)) return null;
  return {
    min,
    avg: isFiniteNumber(row[`${prefix}Avg`]) ? row[`${prefix}Avg`] : min,
    max,
    maxAt: isoOrNull(row[`${prefix}MaxAt`]),
  };
}

/** Turns one camelized resource_minutes row (numeric minuteStart) into the domain's ResourceMinute. */
function toResourceMinute(row) {
  return {
    minuteStart: isoOrNull(row.minuteStart),
    cpuCores: aggregateFromRow(row, "cpuCores"),
    memoryBytes: aggregateFromRow(row, "memoryBytes"),
    readBytesPerSecond: aggregateFromRow(row, "readBps"),
    writeBytesPerSecond: aggregateFromRow(row, "writeBps"),
  };
}

function buildPeak(queries, peakRow, minutesByStart) {
  const sampleKey = FIELD_SAMPLE_KEY[peakRow.field];
  const windowRows = queries.peakSampleWindow(peakRow.id);
  let window;
  if (windowRows) {
    window = {
      status: "retained",
      samples: windowRows.map((row) => ({ at: isoOrNull(row.observedAtMs), value: numberOrNull(row[sampleKey]) })),
      minute: null,
    };
  } else {
    const minuteStart = Math.floor(peakRow.observedAtMs / MINUTE_MS) * MINUTE_MS;
    const minuteRow = minutesByStart.get(minuteStart) || null;
    window = { status: "not_retained", samples: [], minute: minuteRow ? toResourceMinute(minuteRow) : null };
  }
  const matchedTaskIds = Array.isArray(peakRow.matchedTaskIds) ? peakRow.matchedTaskIds : [];
  return {
    id: `p${peakRow.id}`,
    field: peakRow.field,
    observedAt: isoOrNull(peakRow.observedAtMs),
    value: peakRow.value,
    // Task resolution (label/workKind/duration) happens in the projection layer against
    // committed normalized execution tasks; this block carries only the raw matched IDs.
    matchedTaskIds,
    matchedTaskCount: matchedTaskIds.length,
    window,
  };
}

/** Builds the complete retained block for one session from the committed SQLite store. */
function buildBlock(store, sessionId) {
  const queries = createResourceHistoryQueries(store);
  const bounded = queries.sessionResourceCurvesRecent(sessionId, { limit: MAX_MINUTES });
  const minutesByStart = new Map(bounded.rows.map((row) => [row.minuteStart, row]));
  const minutes = bounded.rows.map(toResourceMinute);

  const removalRow = queries.sessionCurveRemoval(sessionId);

  const byField = new Map();
  for (const peakRow of queries.sessionResourcePeaks(sessionId)) {
    if (!DISPLAY_FIELDS.has(peakRow.field)) continue;
    const bucket = byField.get(peakRow.field) || [];
    // sessionResourcePeaks already orders each field's rows by value desc.
    if (bucket.length < TOP_PEAKS_PER_FIELD) {
      bucket.push(peakRow);
      byField.set(peakRow.field, bucket);
    }
  }
  const selectedPeakRows = [...byField.values()].flat();
  selectedPeakRows.sort((left, right) => right.observedAtMs - left.observedAtMs);
  const peaks = selectedPeakRows.map((peakRow) => buildPeak(queries, peakRow, minutesByStart));

  let curveRemoval = null;
  if (removalRow) {
    curveRemoval = { reason: removalRow.reason, removedAt: isoOrNull(removalRow.removedAtMs) };
  } else if (minutes.length === 0 && peaks.length > 0) {
    curveRemoval = { reason: "not_recorded", removedAt: null };
  }

  return Object.freeze({
    readiness: "ready",
    minutes: Object.freeze(minutes),
    minutesTruncated: bounded.truncated,
    curveRemoval,
    peaks: Object.freeze(peaks),
  });
}

function storageReadinessKind(monitorStoreRuntime) {
  try {
    return monitorStoreRuntime.serveStorage?.()?.snapshot?.value?.readiness ?? null;
  } catch {
    return null;
  }
}

/**
 * Commits the session `resources` domain's retained block on the monitor-store checkpoint
 * cycle. Registers a `resource-domain` contributor (always `rebuildComplete: true`: this
 * data is a derived cache over already-committed SQLite tables, never a rebuild target
 * itself) that, for each demanded session, reads curves/removal/peaks/windows and keeps the
 * normalized result in an in-memory map. `retained()` only reads that map; `request()` only
 * nudges the store runtime to schedule a cycle, never inline.
 */
export function createResourceDomainSource({ monitorStoreRuntime, demandedSessionIds, onChange, now = Date.now } = {}) {
  if (!monitorStoreRuntime || typeof monitorStoreRuntime.registerContributor !== "function"
    || typeof monitorStoreRuntime.store !== "function") {
    throw new TypeError("Resource domain source requires a monitor store runtime");
  }
  if (typeof demandedSessionIds !== "function" || typeof onChange !== "function") {
    throw new TypeError("Resource domain source requires demandedSessionIds() and onChange()");
  }
  void now; // accepted for signature/testability parity with sibling factories; not used directly

  const blocks = new Map(); // sessionId -> committed retained block
  const serialized = new Map(); // sessionId -> last committed block's JSON, for change detection
  const requestedSessionIds = new Set(); // sessions with an outstanding, coalesced hydration nudge

  async function onCheckpoint(store) {
    let sessionIds;
    try {
      sessionIds = demandedSessionIds();
    } catch {
      return;
    }
    if (!Array.isArray(sessionIds)) return;
    for (const sessionId of sessionIds.slice(0, MAX_DEMANDED_SESSIONS_PER_CYCLE)) {
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      requestedSessionIds.delete(sessionId);
      let nextBlock;
      try {
        nextBlock = buildBlock(store, sessionId);
      } catch {
        // A failed read for one session keeps its previous block (last-known-good) and
        // never blocks other demanded sessions in the same cycle.
        continue;
      }
      const nextSerialized = JSON.stringify(nextBlock);
      if (serialized.get(sessionId) === nextSerialized) continue;
      blocks.set(sessionId, nextBlock);
      serialized.set(sessionId, nextSerialized);
      try { onChange(sessionId); } catch { /* one failing subscriber cannot break the cycle */ }
    }
  }

  monitorStoreRuntime.registerContributor(Object.freeze({
    name: "resource-domain",
    onCheckpoint,
    rebuildComplete: () => true,
  }));

  return Object.freeze({
    /** Pure map lookup; never touches SQLite. Safe to call from a serving-side GET. */
    retained(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return LOADING_BLOCK;
      if (!monitorStoreRuntime.store()) return UNAVAILABLE_BLOCK;
      if (storageReadinessKind(monitorStoreRuntime) === "rebuilding") return REBUILDING_BLOCK;
      return blocks.get(sessionId) || LOADING_BLOCK;
    },
    /** Queues asynchronous hydration for a demanded session with no block yet; never inline. */
    request(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (blocks.has(sessionId) || requestedSessionIds.has(sessionId)) return;
      requestedSessionIds.add(sessionId);
      try { monitorStoreRuntime.afterCheckpointWrite?.(); } catch { /* best-effort nudge */ }
    },
  });
}
