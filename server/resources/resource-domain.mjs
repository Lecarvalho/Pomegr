
import { createResourceHistoryQueries } from "./resource-history.mjs";

const MINUTE_MS = 60_000;
const MAX_MINUTES = 1440;
const TOP_PEAKS_PER_FIELD = 3;
const MAX_DEMANDED_SESSIONS_PER_CYCLE = 32;

// The four display fields the resources domain shows curves and peaks for.
const DISPLAY_FIELDS = new Set(["cpu_cores", "memory_bytes", "read_bps", "write_bps"]);
const CPU_FIELD = "cpu_cores";
const CPU_MACHINE_PERCENT_FIELD = "cpu_machine_percent";
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

function toResourceMinute(row) {
  return {
    minuteStart: isoOrNull(row.minuteStart),
    cpuCores: aggregateFromRow(row, "cpuCores"),
    cpuMachinePercent: aggregateFromRow(row, "cpuMachinePercent"),
    memoryBytes: aggregateFromRow(row, "memoryBytes"),
    readBytesPerSecond: aggregateFromRow(row, "readBps"),
    writeBytesPerSecond: aggregateFromRow(row, "writeBps"),
  };
}

function minuteStartOf(observedAtMs) {
  return Math.floor(observedAtMs / MINUTE_MS) * MINUTE_MS;
}

function buildPeak(queries, peakRow, minutesByStart, machinePercentByMinute) {
  const sampleKey = FIELD_SAMPLE_KEY[peakRow.field];
  const cpuMachinePercent = peakRow.field === CPU_FIELD
    ? numberOrNull(machinePercentByMinute.get(minuteStartOf(peakRow.observedAtMs)))
    : null;
  const windowRows = queries.peakSampleWindow(peakRow.id);
  let window;
  if (windowRows) {
    window = {
      status: "retained",
      samples: windowRows.map((row) => ({ at: isoOrNull(row.observedAtMs), value: numberOrNull(row[sampleKey]) })),
      minute: null,
    };
  } else {
    const minuteRow = minutesByStart.get(minuteStartOf(peakRow.observedAtMs)) || null;
    window = { status: "not_retained", samples: [], minute: minuteRow ? toResourceMinute(minuteRow) : null };
  }
  const matchedTaskIds = Array.isArray(peakRow.matchedTaskIds) ? peakRow.matchedTaskIds : [];
  return {
    id: `p${peakRow.id}`,
    field: peakRow.field,
    observedAt: isoOrNull(peakRow.observedAtMs),
    value: peakRow.value,
    cpuMachinePercent,
    matchedTaskIds,
    matchedTaskCount: matchedTaskIds.length,
    window,
  };
}

function buildBlock(store, sessionId) {
  const queries = createResourceHistoryQueries(store);
  const bounded = queries.sessionResourceCurvesRecent(sessionId, { limit: MAX_MINUTES });
  const minutesByStart = new Map(bounded.rows.map((row) => [row.minuteStart, row]));
  const minutes = bounded.rows.map(toResourceMinute);

  const removalRow = queries.sessionCurveRemoval(sessionId);

  const byField = new Map();
  const machinePercentByMinute = new Map();
  for (const peakRow of queries.sessionResourcePeaks(sessionId)) {
    if (peakRow.field === CPU_MACHINE_PERCENT_FIELD && isFiniteNumber(peakRow.observedAtMs)) {
      machinePercentByMinute.set(minuteStartOf(peakRow.observedAtMs), peakRow.value);
    }
    if (!DISPLAY_FIELDS.has(peakRow.field)) continue;
    const bucket = byField.get(peakRow.field) || [];
    if (bucket.length < TOP_PEAKS_PER_FIELD) {
      bucket.push(peakRow);
      byField.set(peakRow.field, bucket);
    }
  }
  const selectedPeakRows = [...byField.values()].flat();
  selectedPeakRows.sort((left, right) => right.observedAtMs - left.observedAtMs);
  const peaks = selectedPeakRows.map((peakRow) => buildPeak(queries, peakRow, minutesByStart, machinePercentByMinute));

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

// Commits the session `resources` domain's retained block on the monitor-store checkpoint cycle.
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

  // An explicit retained-resource request wins the next bounded cycle.
  function cycleSessionIds(sessionIds) {
    const demanded = new Set();
    for (const sessionId of sessionIds) {
      if (typeof sessionId === "string" && sessionId.length > 0) demanded.add(sessionId);
    }
    const requested = [];
    for (const sessionId of requestedSessionIds) {
      if (!demanded.delete(sessionId)) continue;
      requested.push(sessionId);
    }
    const ordered = [...requested];
    for (const sessionId of sessionIds) {
      if (demanded.delete(sessionId)) ordered.push(sessionId);
    }
    return ordered;
  }

  async function onCheckpoint(store) {
    let sessionIds;
    try {
      sessionIds = demandedSessionIds();
    } catch {
      return;
    }
    if (!Array.isArray(sessionIds)) return;
    const demanded = new Set(sessionIds.filter((sessionId) => typeof sessionId === "string" && sessionId.length > 0));
    const selectedSessionIds = cycleSessionIds(sessionIds).slice(0, MAX_DEMANDED_SESSIONS_PER_CYCLE);
    for (const sessionId of selectedSessionIds) {
      // Consume explicit priority on the first attempt.
      requestedSessionIds.delete(sessionId);
      let nextBlock;
      try {
        nextBlock = buildBlock(store, sessionId);
      } catch {
        continue;
      }
      const nextSerialized = JSON.stringify(nextBlock);
      if (serialized.get(sessionId) === nextSerialized) continue;
      blocks.set(sessionId, nextBlock);
      serialized.set(sessionId, nextSerialized);
      try { onChange(sessionId); } catch { /* one failing subscriber cannot break the cycle */ }
    }

    // The store runtime turns this into at most one extra pass after the current cycle.
    for (const sessionId of requestedSessionIds) {
      if (!demanded.has(sessionId)) continue;
      try { monitorStoreRuntime.afterCheckpointWrite?.(); } catch { /* best-effort nudge */ }
      break;
    }
  }

  monitorStoreRuntime.registerContributor(Object.freeze({
    name: "resource-domain",
    onCheckpoint,
    rebuildComplete: () => true,
  }));

  return Object.freeze({
    // Pure map lookup; never touches SQLite.
    retained(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return LOADING_BLOCK;
      if (!monitorStoreRuntime.store()) return UNAVAILABLE_BLOCK;
      if (storageReadinessKind(monitorStoreRuntime) === "rebuilding") return REBUILDING_BLOCK;
      return blocks.get(sessionId) || LOADING_BLOCK;
    },
    // Queues asynchronous hydration for a demanded session with no block yet; never inline.
    request(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (blocks.has(sessionId) || requestedSessionIds.has(sessionId)) return;
      requestedSessionIds.add(sessionId);
      try { monitorStoreRuntime.afterCheckpointWrite?.(); } catch { /* best-effort nudge */ }
    },
  });
}
