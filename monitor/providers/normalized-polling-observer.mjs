import fs from "node:fs";
import { isObservationWorkingSetEntry } from "../observation-working-set.mjs";
import { createDurationSeries } from "../pipeline-operations.mjs";
import { createPipelineFailureRecorder } from "../pipeline-operations-failures.mjs";

/**
 * Transitional adapter-local observer.  It intentionally knows nothing about
 * a provider's transcript format: an adapter supplies acquisition and
 * normalization closures, while this worker only schedules publication of
 * their already-normalized results.  Native incremental cursors and partial
 * record fragments remain adapter-private and can replace `read` without
 * changing the observer lifecycle.
 */
export { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";

function watchFilename(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function normalizedSourceRoute(value) {
  if (!value || typeof value !== "object") return { catalog: true, sessionIds: [] };
  const sessionIds = [...new Set((Array.isArray(value.sessionIds) ? value.sessionIds : [])
    .filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512))];
  return { catalog: Boolean(value.catalog), sessionIds };
}

export function createNormalizedPollingObserver(options) {
  const {
    list,
    read,
    ingest,
    prepare,
    intervalMs = 10_000,
    concurrency = 2,
    watchTargets = [],
    routeSourceEvent,
    watchSource = fs.watch,
    yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
    now = Date.now,
    monotonicNow = () => performance.now(),
    shouldEagerHydrate = (entry) => isObservationWorkingSetEntry(entry, now()),
  } = options || {};
  const acquire = ingest || read;
  if (typeof list !== "function" || typeof acquire !== "function") {
    throw new TypeError("Normalized polling observer requires list and ingest functions");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new TypeError("Normalized polling observer interval must be at least 100 ms");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("Normalized polling observer concurrency must be between 1 and 16");
  }
  if (prepare !== undefined && typeof prepare !== "function") {
    throw new TypeError("Normalized polling observer prepare hook must be a function");
  }
  if (routeSourceEvent !== undefined && typeof routeSourceEvent !== "function") {
    throw new TypeError("Normalized polling observer source-event router must be a function");
  }
  if (typeof watchSource !== "function" || typeof yieldControl !== "function") {
    throw new TypeError("Normalized polling observer watcher and yield hooks must be functions");
  }
  if (typeof now !== "function" || typeof monotonicNow !== "function" || typeof shouldEagerHydrate !== "function") {
    throw new TypeError("Normalized polling observer working-set hooks must be functions");
  }

  let publisher = null;
  let signal = null;
  let timer = null;
  let refreshPending = false;
  let refreshQueued = false;
  let refreshQueuedFresh = false;
  let eagerPreparationActive = false;
  let pendingEagerEntries = null;
  let stopped = false;
  let queueSequence = 0;
  const watchers = [];
  const pendingHydrations = new Map();
  const runningHydrations = new Map();
  const latestEntries = new Map();
  const failures = createPipelineFailureRecorder({ now });
  const timings = Object.freeze({
    catalogDiscovery: createDurationSeries(),
    queueWait: createDurationSeries(),
    preparation: createDurationSeries(),
    acquisitionNormalization: createDurationSeries(),
  });
  const qa = {
    reconciliationRuns: 0,
    watcherWakeups: 0,
    routedSourceEvents: 0,
    unresolvedSourceEvents: 0,
    hydrationAttempts: 0,
    hydrationsQueued: 0,
    hydrationsCoalesced: 0,
    hydrationDirtyAgain: 0,
    sourceEventQueueSamples: 0,
    sourceEventQueueDelayTotalMs: 0,
    sourceEventQueueDelayMaxMs: 0,
    sourceEventQueueDelayLastMs: 0,
    candidatesPublished: 0,
    acquisitionFailures: 0,
  };

  async function runHydration(localSessionId, prepared, requested) {
    if (stopped || !publisher) return false;
    qa.hydrationAttempts += 1;
    let failureStage = "worker_yield";
    try {
      // Provider reducers still contain bounded synchronous work. Yield before
      // every acquisition unit so cache-only serving remains responsive.
      await yieldControl();
      let context = prepared;
      if (prepared === undefined && prepare) {
        failureStage = "source_preparation";
        const preparationStartedAt = monotonicNow();
        try {
          context = await prepare([latestEntries.get(localSessionId) || { localId: localSessionId }]);
        } finally {
          timings.preparation.record(monotonicNow() - preparationStartedAt);
        }
      }
      const acquisitionStartedAt = monotonicNow();
      failureStage = "acquire_normalize";
      let candidate;
      try {
        candidate = await acquire(localSessionId, publisher, context, { requested });
      } finally {
        timings.acquisitionNormalization.record(monotonicNow() - acquisitionStartedAt);
      }
      if (!stopped && !signal?.aborted && candidate) {
        failureStage = "session_publication";
        publisher.publishSession(localSessionId, candidate);
        qa.candidatesPublished += 1;
      }
      return Boolean(candidate);
    } catch (error) {
      // Acquisition failures are isolated and sanitized. The previous
      // committed revision remains visible and reconciliation can retry.
      qa.acquisitionFailures += 1;
      failures.record("acquisitionFailures", error, failureStage);
      return false;
    }
  }

  function nextPendingHydration() {
    let selected = null;
    for (const item of pendingHydrations.values()) {
      if (runningHydrations.has(item.localSessionId)) continue;
      if (!selected || item.priority < selected.priority
        || (item.priority === selected.priority && item.sequence < selected.sequence)) selected = item;
    }
    return selected;
  }

  function drainHydrations() {
    if (stopped || signal?.aborted) return;
    while (runningHydrations.size < concurrency) {
      const item = nextPendingHydration();
      if (!item) return;
      pendingHydrations.delete(item.localSessionId);
      if (Number.isFinite(item.sourceEventAt)) {
        const queueDelayMs = Math.max(0, monotonicNow() - item.sourceEventAt);
        qa.sourceEventQueueSamples += 1;
        qa.sourceEventQueueDelayTotalMs += queueDelayMs;
        qa.sourceEventQueueDelayMaxMs = Math.max(qa.sourceEventQueueDelayMaxMs, queueDelayMs);
        qa.sourceEventQueueDelayLastMs = queueDelayMs;
        timings.queueWait.record(queueDelayMs);
      }
      const task = runHydration(item.localSessionId, item.prepared, item.requested);
      runningHydrations.set(item.localSessionId, task);
      void task.then((result) => {
        for (const resolve of item.waiters) resolve(result);
      }).finally(() => {
        runningHydrations.delete(item.localSessionId);
        drainHydrations();
      });
    }
  }

  /**
   * @param {string} localSessionId
   * @param {{prepared?: unknown, priority?: number, rerunIfActive?: boolean, wait?: boolean, requested?: boolean, sourceEventAt?: number}} [hydrationOptions]
   */
  function enqueueHydration(localSessionId, {
    prepared,
    priority = 1,
    rerunIfActive = false,
    wait = false,
    requested = false,
    sourceEventAt,
  } = {}) {
    if (stopped || signal?.aborted || typeof localSessionId !== "string" || !localSessionId) {
      return wait ? Promise.resolve(false) : false;
    }
    let resolveWaiter;
    const result = wait ? new Promise((resolve) => { resolveWaiter = resolve; }) : true;
    const pending = pendingHydrations.get(localSessionId);
    if (pending) {
      pending.priority = Math.min(pending.priority, priority);
      pending.requested ||= requested;
      if (prepared !== undefined) pending.prepared = prepared;
      if (Number.isFinite(sourceEventAt)) {
        pending.sourceEventAt = Number.isFinite(pending.sourceEventAt)
          ? Math.min(pending.sourceEventAt, sourceEventAt)
          : sourceEventAt;
      }
      if (resolveWaiter) pending.waiters.push(resolveWaiter);
      qa.hydrationsCoalesced += 1;
      return result;
    }
    const active = runningHydrations.get(localSessionId);
    if (active && !rerunIfActive) return wait ? active : false;
    if (active) qa.hydrationDirtyAgain += 1;
    pendingHydrations.set(localSessionId, {
      localSessionId,
      prepared,
      requested,
      priority,
      sequence: queueSequence += 1,
      waiters: resolveWaiter ? [resolveWaiter] : [],
      sourceEventAt: Number.isFinite(sourceEventAt) ? sourceEventAt : null,
    });
    qa.hydrationsQueued += 1;
    drainHydrations();
    return result;
  }

  async function drainEagerPreparation() {
    if (eagerPreparationActive || stopped || signal?.aborted) return;
    eagerPreparationActive = true;
    try {
      while (pendingEagerEntries && !stopped && !signal?.aborted) {
        const batch = pendingEagerEntries;
        pendingEagerEntries = null;
        let prepared;
        try {
          if (prepare && batch.length) {
            const preparationStartedAt = monotonicNow();
            try {
              prepared = await prepare(batch.map(({ entry }) => entry));
            } finally {
              timings.preparation.record(monotonicNow() - preparationStartedAt);
            }
          }
        } catch (error) {
          qa.acquisitionFailures += 1;
          failures.record("acquisitionFailures", error, "source_preparation");
          continue;
        }
        for (const { entry, priority } of batch) {
          enqueueHydration(entry.localId, { prepared, priority });
        }
      }
    } finally {
      eagerPreparationActive = false;
      if (pendingEagerEntries && !stopped && !signal?.aborted) void drainEagerPreparation();
    }
  }

  function scheduleEagerHydration(entries, previousIds) {
    pendingEagerEntries = entries.filter((entry) => shouldEagerHydrate(entry)).map((entry) => ({
      entry,
      // Newly discovered sessions enter acquisition ahead of routine
      // working-set reconciliation without changing public catalog order.
      priority: previousIds.has(entry.localId) ? 2 : 0,
    }));
    void drainEagerPreparation();
  }

  async function refresh({ fresh = false } = {}) {
    if (refreshPending) {
      refreshQueued = true;
      refreshQueuedFresh ||= fresh;
      return;
    }
    if (stopped || signal?.aborted || !publisher) return;
    refreshPending = true;
    qa.reconciliationRuns += 1;
    try {
      const discoveryStartedAt = monotonicNow();
      let entries;
      try {
        entries = await list({ fresh });
      } finally {
        timings.catalogDiscovery.record(monotonicNow() - discoveryStartedAt);
      }
      if (!Array.isArray(entries) || stopped || signal?.aborted) return;
      const previousIds = new Set(latestEntries.keys());
      latestEntries.clear();
      for (const entry of entries) {
        if (entry && typeof entry.localId === "string" && entry.localId) latestEntries.set(entry.localId, entry);
      }
      publisher.publishCatalog(entries);
      // Catalog discovery is an independent lane. Source preparation and
      // acquisition continue asynchronously and cannot hold a later catalog
      // publication behind a complete working-set hydration pass.
      scheduleEagerHydration(entries, previousIds);
    } catch {
      // The registry records observer failures.  Do not erase an existing
      // catalog or publish an incomplete replacement here.
    } finally {
      refreshPending = false;
      if (refreshQueued && !stopped && !signal?.aborted) {
        const queuedFresh = refreshQueuedFresh;
        refreshQueued = false;
        refreshQueuedFresh = false;
        // A queued watcher/reconciliation pass must not form a microtask-only
        // loop that starves the monitor's HTTP server.
        void yieldControl().then(() => refresh({ fresh: queuedFresh }), () => {});
      }
    }
  }

  async function handleSourceEvent(change) {
    if (stopped || signal?.aborted) return;
    let routed;
    try {
      routed = normalizedSourceRoute(routeSourceEvent
        ? await routeSourceEvent(change)
        : { catalog: true, sessionIds: [] });
    } catch {
      routed = { catalog: true, sessionIds: [] };
    }
    if (routed.sessionIds.length) qa.routedSourceEvents += 1;
    else qa.unresolvedSourceEvents += 1;
    // Unknown/new sources require a cache-bypassing catalog pass. Known
    // sources skip discovery and enter acquisition immediately.
    if (routed.catalog) void refresh({ fresh: true });
    const sourceEventAt = monotonicNow();
    for (const localSessionId of routed.sessionIds) {
      enqueueHydration(localSessionId, {
        priority: 0,
        rerunIfActive: true,
        sourceEventAt,
      });
    }
  }

  function watchTarget(target) {
    if (typeof target !== "string" || !target) return;
    const wake = (eventType, filename) => {
      qa.watcherWakeups += 1;
      void Promise.resolve().then(() => handleSourceEvent({
        target,
        eventType: typeof eventType === "string" ? eventType : "change",
        filename: watchFilename(filename),
      }));
    };
    try {
      watchers.push(watchSource(target, { recursive: true }, wake));
    } catch {
      try { watchers.push(watchSource(target, wake)); } catch { /* reconciliation remains authoritative */ }
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch { /* best-effort observer shutdown */ }
    }
    for (const item of pendingHydrations.values()) {
      for (const resolve of item.waiters) resolve(false);
    }
    pendingHydrations.clear();
    pendingEagerEntries = null;
  }

  return Object.freeze({
    async start(nextPublisher, nextSignal) {
      if (publisher) throw new TypeError("Provider observer has already started");
      if (!nextPublisher || typeof nextPublisher.publishCatalog !== "function"
        || typeof nextPublisher.publishSession !== "function"
        || typeof nextPublisher.invalidateSession !== "function") {
        throw new TypeError("Provider observer requires a scoped normalized publisher");
      }
      if (!nextSignal || typeof nextSignal.addEventListener !== "function") {
        throw new TypeError("Provider observer requires an AbortSignal");
      }
      publisher = {
        ...nextPublisher,
        publishCatalog(entries) {
          // Hydration may repair the initial catalog classification. Keep future
          // preparation on that same published revision, not a stale startup row.
          const result = nextPublisher.publishCatalog(entries);
          latestEntries.clear();
          for (const entry of entries) latestEntries.set(entry.localId, entry);
          return result;
        },
      };
      signal = nextSignal;
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener("abort", stop, { once: true });
      timer = setInterval(() => { void refresh(); }, intervalMs);
      timer.unref?.();
      for (const target of watchTargets) watchTarget(target);
      void refresh();
    },
    hydrate(localSessionId) {
      return enqueueHydration(localSessionId, { priority: 0, wait: true, requested: true, rerunIfActive: true });
    },
    listSessions: list,
    stop,
    diagnostics: () => Object.freeze({
      ...qa,
      sourceEventQueueDelayAverageMs: qa.sourceEventQueueSamples
        ? Math.round(qa.sourceEventQueueDelayTotalMs / qa.sourceEventQueueSamples)
        : 0,
      activeHydrations: runningHydrations.size,
      pendingHydrations: pendingHydrations.size,
      hydrationConcurrency: concurrency,
      failureDetails: failures.snapshot(),
      timings: Object.freeze(Object.fromEntries(Object.entries(timings).map(([key, series]) => [key, series.snapshot()]))),
    }),
  });
}
