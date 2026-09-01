import crypto from "node:crypto";
import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { agentsVariantKey, buildAgentsAnalytics, collectAgentsAnalyticsInput, normalizeAgentsQuery } from "./agents-analytics.mjs";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

function loadingSnapshot(query) {
  return {
    readiness: "loading", refreshReadiness: "ready", generatedAt: null,
    coverage: { retainedSessions: 0, eligibleSessions: 0, missingSessions: 0, retainedRuns: 0, truncated: false, earliestStartedAt: null },
    filters: { ...query, projects: [] },
    summary: { runCount: 0, sessionCount: 0, modelCount: 0, mainRunCount: 0, delegatedRunCount: 0 },
    models: [], work: [], runs: [], roster: [],
  };
}

function unavailableSnapshot(query) {
  return { ...loadingSnapshot(query), readiness: "unavailable", refreshReadiness: "unavailable" };
}

function semanticValue(value) {
  const clone = { ...(value || {}) };
  delete clone.revision;
  delete clone.generatedAt;
  return JSON.stringify(clone);
}

function nextSnapshot(value, previous, now, revision) {
  if (previous && semanticValue(previous.value) === semanticValue(value)) return previous;
  const cache = createCommittedResponseCache({ includeRevision: true, initialRevision: 0, now });
  return cache.commit(value, { revision });
}

function inputFingerprint(input) {
  const catalog = input.catalog.map((entry) => ({ id: entry?.id || "", project: entry?.project || "", isLive: Boolean(entry?.isLive) }));
  return crypto.createHash("sha256").update(JSON.stringify({ runs: input.runs, catalog, projects: input.projects, truncated: input.truncated })).digest("base64url");
}

function nextWindowBoundary(input, currentNow) {
  let earliest = null;
  for (const run of input.runs) {
    const startedAt = Date.parse(run.startedAt || "");
    if (!Number.isFinite(startedAt)) continue;
    for (const days of [7, 30, 90]) {
      const boundary = startedAt + days * 24 * 60 * 60_000 + 1;
      if (boundary > currentNow && (earliest === null || boundary < earliest)) earliest = boundary;
    }
  }
  return earliest;
}

/** D-only analytics: one input capture, yielded staging, atomic variant-map publication. */
export function createAgentsObservation({
  store, catalog, subscribe, isReady = () => false, readiness = null, now = () => Date.now(),
  schedule = setTimeout, cancel = clearTimeout, yieldTask = () => new Promise((resolve) => setImmediate(resolve)),
  intervalMs = 60_000, batchSize = 24,
} = {}) {
  if (!store || typeof store.entries !== "function" || typeof catalog !== "function" || typeof subscribe !== "function" || typeof isReady !== "function") {
    throw new TypeError("Agents observation requires committed store, catalog, subscription, and readiness");
  }
  const minimumInterval = Math.max(60_000, Number(intervalMs) || 60_000);
  const boundedBatchSize = Math.max(1, Math.min(64, Number(batchSize) || 24));
  let committed = new Map();
  let timer = null;
  let timerDueAt = null;
  let unsubscribe = null;
  let started = false;
  let pending = false;
  let rebuildingGeneration = null;
  let generation = 0;
  let lastAttemptAt = null;
  let lastFingerprint = null;
  let nextBoundaryAt = null;
  let rebuilds = 0;
  let failures = 0;
  // Startup must remain cache-only even when an injected observation clock is
  // unavailable. The wall-clock seed is acquired inside background staging.
  let revisionSequence = 0;

  function nextRevision() {
    const wallClock = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER - 1, Math.floor(Number(now())) || 0));
    revisionSequence = Math.max(revisionSequence + 1, wallClock);
    return revisionSequence;
  }

  function currentReadiness() {
    const value = typeof readiness === "function" ? readiness() : isReady() ? "ready" : "loading";
    return value === "ready" || value === "unavailable" ? value : "loading";
  }

  function initialQueries() {
    const queries = [];
    for (const days of [7, 30, 90]) for (const scope of ["all", "main", "delegated"]) queries.push({ project: "all", days, scope });
    return queries;
  }

  async function stage(values, previous, workGeneration) {
    const next = new Map();
    const records = [...values];
    for (let index = 0; index < records.length; index += 1) {
      const [key, value] = records[index];
      next.set(key, nextSnapshot(value, previous.get(key), now, nextRevision()));
      if ((index + 1) % boundedBatchSize === 0 && index + 1 < records.length) await yieldTask();
      if (!started || generation !== workGeneration) return null;
    }
    return next;
  }

  async function installFailureState(workGeneration) {
    const values = new Map();
    for (const query of initialQueries()) {
      const key = agentsVariantKey(query);
      const previous = committed.get(key)?.value;
      values.set(key, previous?.readiness === "ready" ? { ...previous, refreshReadiness: "unavailable" } : unavailableSnapshot(query));
    }
    for (const [key, previous] of committed) {
      if (values.has(key)) continue;
      values.set(key, previous.value?.readiness === "ready"
        ? { ...previous.value, refreshReadiness: "unavailable" }
        : unavailableSnapshot(previous.value?.filters || { project: "all", days: 30, scope: "all" }));
    }
    const next = await stage(values, committed, workGeneration);
    if (next && started && generation === workGeneration) committed = next;
  }

  function scheduleAt(dueAt) {
    if (!started) return;
    if (timer !== null && timerDueAt !== null && timerDueAt <= dueAt) return;
    if (timer !== null) cancel(timer);
    timerDueAt = dueAt;
    // Node clamps larger native timeouts to an immediate wakeup. Keep the
    // intended boundary in timerDueAt; an early capped wakeup fingerprints,
    // skips unchanged derivation, and schedules the remaining interval.
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, dueAt - now()));
    timer = schedule(() => rebuild(), delay);
  }

  function requestRebuild() {
    if (!started) return;
    pending = true;
    scheduleAt(lastAttemptAt === null ? now() : lastAttemptAt + minimumInterval);
  }

  async function rebuild() {
    timer = null;
    timerDueAt = null;
    if (!started || rebuildingGeneration !== null || !pending) return;
    const readinessState = currentReadiness();
    if (readinessState === "loading") return;
    const workGeneration = generation;
    rebuildingGeneration = workGeneration;
    pending = false;
    lastAttemptAt = now();
    try {
      if (readinessState === "unavailable") throw new TypeError("Committed catalog unavailable");
      // Capture exactly once; all variants derive from this same immutable input.
      const capturedEntries = store.entries();
      const capturedCatalog = catalog();
      const capturedNow = now();
      const input = collectAgentsAnalyticsInput({ entries: capturedEntries, catalog: capturedCatalog });
      const fingerprint = inputFingerprint(input);
      const boundary = nextWindowBoundary(input, capturedNow);
      const recovering = [...committed.values()].some((snapshot) => snapshot.value?.refreshReadiness === "unavailable");
      if (fingerprint === lastFingerprint && !recovering && !(nextBoundaryAt !== null && capturedNow >= nextBoundaryAt)) {
        nextBoundaryAt = boundary;
        if (boundary !== null) { pending = true; scheduleAt(Math.max(boundary, lastAttemptAt + minimumInterval)); }
        return;
      }
      const queries = [];
      for (const project of ["all", ...input.projects]) {
        for (const days of [7, 30, 90]) for (const scope of ["all", "main", "delegated"]) queries.push({ project, days, scope });
      }
      const values = new Map();
      for (let index = 0; index < queries.length; index += 1) {
        const query = queries[index];
        values.set(agentsVariantKey(query), buildAgentsAnalytics({ input, ...query, now: capturedNow, refreshReadiness: "ready" }));
        if ((index + 1) % boundedBatchSize === 0 && index + 1 < queries.length) await yieldTask();
        if (!started || generation !== workGeneration) return;
      }
      const next = await stage(values, committed, workGeneration);
      if (!next || !started || generation !== workGeneration) return;
      committed = next;
      lastFingerprint = fingerprint;
      nextBoundaryAt = boundary;
      rebuilds += 1;
      if (boundary !== null) { pending = true; scheduleAt(Math.max(boundary, lastAttemptAt + minimumInterval)); }
    } catch {
      failures += 1;
      await installFailureState(workGeneration);
      if (started && generation === workGeneration) {
        pending = true;
        scheduleAt(lastAttemptAt + minimumInterval);
      }
    } finally {
      if (rebuildingGeneration === workGeneration) rebuildingGeneration = null;
      if (started && generation === workGeneration && pending && timer === null) requestRebuild();
    }
  }

  function start() {
    if (started) return;
    started = true;
    generation += 1;
    rebuildingGeneration = null;
    pending = false;
    lastAttemptAt = null;
    lastFingerprint = null;
    nextBoundaryAt = null;
    if (committed.size === 0) {
      const initial = new Map();
      for (const query of initialQueries()) {
        const cache = createCommittedResponseCache({ includeRevision: true, now });
        initial.set(agentsVariantKey(query), cache.commit(loadingSnapshot(query), { revision: ++revisionSequence, observedAt: 0 }));
      }
      committed = initial;
    }
    unsubscribe = subscribe(() => requestRebuild());
    if (currentReadiness() !== "loading") requestRebuild();
  }

  function stop() {
    started = false;
    generation += 1;
    rebuildingGeneration = null;
    pending = false;
    if (timer !== null) cancel(timer);
    timer = null;
    timerDueAt = null;
    unsubscribe?.();
    unsubscribe = null;
  }

  function read(query, revision) {
    const normalized = normalizeAgentsQuery(query);
    if (!normalized) return Object.freeze({ status: "invalid", revision: 0, snapshot: null });
    const snapshot = committed.get(agentsVariantKey(normalized));
    if (!snapshot) return Object.freeze({ status: "invalid", revision: 0, snapshot: null });
    return Object.freeze({ status: Number(revision) === snapshot.revision ? "unchanged" : "ready", revision: snapshot.revision, snapshot });
  }

  return Object.freeze({
    start, stop, read,
    diagnostics: () => Object.freeze({ rebuilds, failures, scheduled: timer !== null, lastAttemptAt, nextBoundaryAt, variants: committed.size }),
  });
}
