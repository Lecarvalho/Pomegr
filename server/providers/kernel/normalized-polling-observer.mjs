import fs from "node:fs";
import { createSourceWriteClassifier } from "./source-write-classifier.mjs";
import { isObservationWorkingSetEntry } from "../../normalize/observation-working-set.mjs";
import { createDurationSeries } from "../../diagnostics/pipeline-operations.mjs";
import { createPipelineFailureRecorder } from "../../diagnostics/pipeline-operations-failures.mjs";

/**
 * Transitional adapter-local observer.  It intentionally knows nothing about
 * a provider's transcript format: an adapter supplies acquisition and
 * normalization closures, while this worker only schedules publication of
 * their already-normalized results.  Native incremental cursors and partial
 * record fragments remain adapter-private and can replace `read` without
 * changing the observer lifecycle.
 */
export { createIncrementalJsonlIngestor } from "./incremental-jsonl-ingestor.mjs";

const URGENT = 0;
const SOURCE_UPDATE = 1;
const BACKGROUND = 2;
// A session first published within this long of its own creation is treated
// like a first live publication even if it has already finished, so a short
// session is not queued behind the whole historical working set.
const NEW_SESSION_PRIORITY_WINDOW_MS = 10 * 60_000;
const SOURCE_CATALOG_INTERVAL_MS = 1_000;

function watchFilename(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return null;
}

function normalizedSourceRoute(value) {
  if (!value || typeof value !== "object") return { catalog: true, sessionIds: [] };
  const sessionIds = [...new Set((Array.isArray(value.sessionIds) ? value.sessionIds : [])
    .filter((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 512))];
  return {
    catalog: Boolean(value.catalog), sessionIds, afterCatalog: Boolean(value.afterCatalog),
    sourceKnown: value.sourceKnown === true,
  };
}

export function createNormalizedPollingObserver(options) {
  const {
    list,
    read,
    ingest,
    prepare,
    intervalMs = 10_000,
    // Minimum spacing between catalog passes a source notification can cause. A burst of
    // notifications inside this window shares one trailing pass; 0 restores one pass per
    // idle notification.
    sourceCatalogIntervalMs = SOURCE_CATALOG_INTERVAL_MS,
    concurrency = 2,
    interactiveConcurrency = options?.interactiveConcurrency ?? Math.max(1, concurrency),
    backgroundConcurrency = options?.backgroundConcurrency ?? 1,
    watchTargets = [],
    routeSourceEvent,
    watchSource = fs.watch,
    statSource,
    yieldControl = () => new Promise((resolve) => setImmediate(resolve)),
    now = Date.now,
    monotonicNow = () => performance.now(),
    shouldEagerHydrate = (entry) => isObservationWorkingSetEntry(entry, now()),
    // The fixed provider id this observer instance was constructed for (e.g. "claude" or
    // "codex"). Attached only to trace records at acquisition call sites below; an
    // unrecognized or missing value simply leaves those records unattributed.
    providerId = null,
  } = options || {};
  const observerProviderId = typeof providerId === "string" && providerId ? providerId : null;
  const acquire = ingest || read;
  if (typeof list !== "function" || typeof acquire !== "function") {
    throw new TypeError("Normalized polling observer requires list and ingest functions");
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 100) {
    throw new TypeError("Normalized polling observer interval must be at least 100 ms");
  }
  if (!Number.isInteger(sourceCatalogIntervalMs) || sourceCatalogIntervalMs < 0 || sourceCatalogIntervalMs > 60_000) {
    throw new TypeError("Normalized polling observer source catalog interval must be between 0 and 60000 ms");
  }
  // Never space source-driven passes wider than routine reconciliation.
  const sourceCatalogSpacingMs = Math.min(sourceCatalogIntervalMs, intervalMs);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new TypeError("Normalized polling observer concurrency must be between 1 and 16");
  }
  if (!Number.isInteger(interactiveConcurrency) || interactiveConcurrency < 1 || interactiveConcurrency > 16) {
    throw new TypeError("Normalized polling observer interactive concurrency must be between 1 and 16");
  }
  if (!Number.isInteger(backgroundConcurrency) || backgroundConcurrency < 1 || backgroundConcurrency > 16) {
    throw new TypeError("Normalized polling observer background concurrency must be between 1 and 16");
  }
  const maxTotalConcurrency = interactiveConcurrency + backgroundConcurrency;
  const sourceUpdateConcurrency = Math.max(1, interactiveConcurrency - 1);
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
  let trace = null;
  let traceScopeForLocalId = null;
  let signal = null;
  let timer = null;
  let refreshPending = false;
  let refreshQueued = false;
  let refreshQueuedFresh = false;
  // Source-driven catalog dirtiness. Any catalog pass that starts after the notification
  // satisfies it (upgraded to a fresh pass); otherwise one trailing timer runs it.
  let sourceCatalogDirty = false;
  let sourceCatalogTimer = null;
  let lastCatalogPassAt = -Infinity;
  let eagerPreparationActive = false;
  let preparationGeneration = 0;
  let pendingEagerEntries = null;
  let stopped = false;
  let queueSequence = 0;
  const watchers = [];
  const pendingHydrations = new Map();
  const runningHydrations = new Map();
  const latestEntries = new Map();
  const catalogHydrations = new Map();
  const sourceWrites = createSourceWriteClassifier({ ...(statSource ? { stat: statSource } : {}), now });
  const hydratedSessions = new Set();
  // The first catalog this observer ever reads (its "startup catalog"). Any
  // session already present in it is excluded from the new-session priority
  // rule below, so a restart with many recently created sessions cannot flood
  // the interactive lanes; only a session that genuinely appears later is new.
  let startupCatalogIds = null;
  // Hydrations that arrived for a session this observer's catalog does not list, before any
  // catalog pass completed. Whether such a session is live is unknown until a pass has run;
  // each waiter resolves true once one has, and false when none can (a failed pass or a stop).
  let catalogWaiters = [];
  const failures = createPipelineFailureRecorder({ now });
  const timings = Object.freeze({
    catalogDiscovery: createDurationSeries(),
    // The aggregate across every priority. Mixing urgent, source-update, and
    // background waits here hid which lane was actually starved; the three
    // per-priority series below answer that without removing this one.
    queueWait: createDurationSeries(),
    // Urgent work a viewer explicitly requested (a selection), recorded apart from
    // first live publication. Scheduling is unchanged: both share the urgent priority.
    queueWaitSelected: createDurationSeries(),
    queueWaitUrgent: createDurationSeries(),
    queueWaitSourceUpdate: createDurationSeries(),
    queueWaitBackground: createDurationSeries(),
    preparation: createDurationSeries(),
    acquisitionNormalization: createDurationSeries(),
  });
  function queueWaitSeriesForPriority(priority, requested = false) {
    if (priority === URGENT && requested) return timings.queueWaitSelected;
    if (priority === URGENT) return timings.queueWaitUrgent;
    if (priority === SOURCE_UPDATE) return timings.queueWaitSourceUpdate;
    return timings.queueWaitBackground;
  }
  // The bounded trace priority-lane name for the same priority values above.
  function priorityLaneName(priority, requested = false) {
    if (priority === URGENT && requested) return "selected";
    if (priority === URGENT) return "urgent";
    if (priority === SOURCE_UPDATE) return "source_update";
    return "background";
  }
  const qa = {
    reconciliationRuns: 0,
    watcherWakeups: 0,
    routedSourceEvents: 0,
    unresolvedSourceEvents: 0,
    unchangedSourceEvents: 0,
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

  function traceScope(localSessionId) {
    if (typeof traceScopeForLocalId !== "function") return null;
    try {
      const value = traceScopeForLocalId(localSessionId);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch { return null; }
  }

  function settleCatalogWaiters() {
    const waiters = catalogWaiters;
    catalogWaiters = [];
    const known = startupCatalogIds !== null && !stopped;
    for (const resolve of waiters) resolve(known);
  }

  /**
   * Resolves true once a catalog pass has completed, so a session absent from the catalog is
   * known to be absent. It never waits on a hydration slot: catalog passes do not use one, so
   * the wait ends with the pass whether that succeeds (true) or fails or is stopped (false).
   */
  function awaitCatalogPass() {
    if (startupCatalogIds !== null) return Promise.resolve(true);
    if (stopped || signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      catalogWaiters.push(resolve);
      // With no pass in flight the previous one failed: ask for the next pass now.
      if (!refreshPending) void refresh();
    });
  }

  async function runHydration(localSessionId, prepared, requested, flow = null, scope = null, priority = BACKGROUND) {
    if (stopped || !publisher) return false;
    qa.hydrationAttempts += 1;
    let failureStage = "worker_yield";
    const laneName = priorityLaneName(priority, requested);
    try {
      // Provider reducers still contain bounded synchronous work. Yield before
      // every acquisition unit so cache-only serving remains responsive.
      await yieldControl();
      let context = prepared;
      if (prepared === undefined && prepare) {
        failureStage = "source_preparation";
        // The catalog lists live sessions first and is bounded, so a session it does not list is
        // not live. That conclusion needs a completed pass: before one, liveness is unknown and
        // neither answer may be published, because a state is decided at first observation.
        let entry = latestEntries.get(localSessionId);
        if (!entry) {
          if (!await awaitCatalogPass()) {
            trace?.finishFlow?.(flow, { outcome: "rejected" });
            return false;
          }
          entry = latestEntries.get(localSessionId) || { localId: localSessionId, isLive: false };
        }
        const preparationStartedAt = monotonicNow();
        const preparationSpan = trace?.begin({ stage: "source_preparation", domain: "acquisition", flow, scope, provider: observerProviderId, priorityLane: laneName });
        try {
          context = await prepare([entry]);
          trace?.end(preparationSpan, { outcome: "completed" });
        } catch (error) {
          trace?.end(preparationSpan, { outcome: "failed" });
          throw error;
        } finally {
          timings.preparation.record(monotonicNow() - preparationStartedAt);
        }
      }
      const acquisitionStartedAt = monotonicNow();
      const acquisitionSpan = trace?.begin({ stage: "acquisition_normalization", domain: "acquisition", flow, scope, provider: observerProviderId, priorityLane: laneName });
      failureStage = "acquire_normalize";
      let candidate;
      try {
        candidate = await acquire(localSessionId, publisher, context, { requested });
        trace?.end(acquisitionSpan, { outcome: candidate ? "completed" : "unchanged" });
      } catch (error) {
        trace?.end(acquisitionSpan, { outcome: "failed" });
        throw error;
      } finally {
        timings.acquisitionNormalization.record(monotonicNow() - acquisitionStartedAt);
      }
      if (!stopped && !signal?.aborted && candidate) {
        failureStage = "session_publication";
        publisher.publishSession(localSessionId, candidate);
        hydratedSessions.add(localSessionId);
        qa.candidatesPublished += 1;
      }
      trace?.finishFlow?.(flow, { outcome: candidate ? "completed" : "rejected" });
      return Boolean(candidate);
    } catch (error) {
      // Acquisition failures are isolated and sanitized. The previous
      // committed revision remains visible and reconciliation can retry.
      qa.acquisitionFailures += 1;
      failures.record("acquisitionFailures", error, failureStage);
      trace?.finishFlow?.(flow, { outcome: "failed" });
      return false;
    }
  }

  function needsInitialLiveHydration(localSessionId) {
    const entry = latestEntries.get(localSessionId);
    return Boolean(entry?.isLive || entry?.needsInput) && !hydratedSessions.has(localSessionId);
  }

  /** A session that first appears (outside the startup catalog) soon after it was created is not left behind the historical background queue, even if it already finished. */
  function isNewSessionPriorityEligible(entry) {
    if (!entry?.localId || hydratedSessions.has(entry.localId)) return false;
    if (!startupCatalogIds || startupCatalogIds.has(entry.localId)) return false;
    const ageMs = now() - Date.parse(entry.createdAt || "");
    return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= NEW_SESSION_PRIORITY_WINDOW_MS;
  }

  function nextPendingHydration(allowInteractive, allowSourceUpdate, allowBackground) {
    let selected = null;
    for (const item of pendingHydrations.values()) {
      if (runningHydrations.has(item.localSessionId)) continue;
      const isInteractive = item.priority < BACKGROUND;
      if (isInteractive && !allowInteractive) continue;
      if (item.priority === SOURCE_UPDATE && !allowSourceUpdate) continue;
      if (!isInteractive && !allowBackground) continue;
      if (!selected || item.priority < selected.priority
        || (item.priority === selected.priority && item.sequence < selected.sequence)) selected = item;
    }
    return selected;
  }

  function drainHydrations() {
    if (stopped || signal?.aborted) return;
    while (runningHydrations.size < maxTotalConcurrency) {
      let activeInteractive = 0;
      let activeSourceUpdates = 0;
      let activeBackground = 0;
      for (const info of runningHydrations.values()) {
        if (info.priority < BACKGROUND) activeInteractive += 1;
        else activeBackground += 1;
        if (info.priority === SOURCE_UPDATE) activeSourceUpdates += 1;
      }
      const allowInteractive = activeInteractive < interactiveConcurrency;
      const allowBackground = activeBackground < backgroundConcurrency;
      if (!allowInteractive && !allowBackground) break;
      // Keep one interactive slot available for first live publication or
      // selection, even during a continuous source-update burst.
      const item = nextPendingHydration(allowInteractive,
        activeSourceUpdates < sourceUpdateConcurrency, allowBackground);
      if (!item) break;
      pendingHydrations.delete(item.localSessionId);
      // Every dequeued item — urgent selection, an ordinary source update, or a
      // background hydration with no source event at all — gets a per-priority
      // sample from the time it entered its current lane (its enqueue, or its
      // promotion to a higher priority). The aggregate queueWait series, the
      // qa counters, and the source_queue trace stay source-event-only, exactly
      // as before.
      const dequeuedAt = monotonicNow();
      queueWaitSeriesForPriority(item.priority, item.requested)
        .record(Math.max(0, dequeuedAt - item.laneSince));
      if (Number.isFinite(item.sourceEventAt)) {
        const queueDelayMs = Math.max(0, dequeuedAt - item.sourceEventAt);
        qa.sourceEventQueueSamples += 1;
        qa.sourceEventQueueDelayTotalMs += queueDelayMs;
        qa.sourceEventQueueDelayMaxMs = Math.max(qa.sourceEventQueueDelayMaxMs, queueDelayMs);
        qa.sourceEventQueueDelayLastMs = queueDelayMs;
        timings.queueWait.record(queueDelayMs);
        trace?.recordDuration({ stage: "source_queue", domain: "acquisition", durationMs: queueDelayMs,
          flow: item.traceFlow, scope: item.traceScope, provider: observerProviderId, priorityLane: priorityLaneName(item.priority, item.requested) });
      }
      const taskPromise = runHydration(item.localSessionId, item.prepared, item.requested, item.traceFlow, item.traceScope, item.priority);
      runningHydrations.set(item.localSessionId, { promise: taskPromise, priority: item.priority });
      void taskPromise.then((result) => {
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
    priority = BACKGROUND,
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
      // A promoted item's wait in its new lane starts at the promotion, not at its enqueue.
      if (priority < pending.priority) pending.laneSince = monotonicNow();
      pending.priority = Math.min(pending.priority, priority);
      pending.requested ||= requested;
      if (priority < BACKGROUND || (pending.priority === BACKGROUND && prepared !== undefined)) pending.prepared = prepared;
      if (Number.isFinite(sourceEventAt)) {
        pending.sourceEventAt = Number.isFinite(pending.sourceEventAt)
          ? Math.min(pending.sourceEventAt, sourceEventAt)
          : sourceEventAt;
      }
      if (resolveWaiter) pending.waiters.push(resolveWaiter);
      qa.hydrationsCoalesced += 1;
      drainHydrations();
      return result;
    }
    const active = runningHydrations.get(localSessionId);
    if (active && !rerunIfActive) return wait ? active.promise : false;
    if (active) qa.hydrationDirtyAgain += 1;
    const scope = traceScope(localSessionId);
    pendingHydrations.set(localSessionId, {
      localSessionId,
      prepared,
      requested,
      priority,
      sequence: queueSequence += 1,
      queuedAt: Number.isFinite(sourceEventAt) ? sourceEventAt : monotonicNow(),
      laneSince: Number.isFinite(sourceEventAt) ? sourceEventAt : monotonicNow(),
      waiters: resolveWaiter ? [resolveWaiter] : [],
      sourceEventAt: Number.isFinite(sourceEventAt) ? sourceEventAt : null,
      traceScope: scope,
      traceFlow: trace?.createFlow?.({ scope }) || null,
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
        const generation = preparationGeneration;
        pendingEagerEntries = null;
        let prepared;
        try {
          if (prepare && batch.length) {
            const preparationStartedAt = monotonicNow();
            // Every entry queued here is background priority; see scheduleEagerHydration.
            const preparationSpan = trace?.begin({ stage: "source_preparation", domain: "acquisition", provider: observerProviderId, priorityLane: "background" });
            try {
              prepared = await prepare(batch.map(({ entry }) => entry));
              trace?.end(preparationSpan, { outcome: "completed" });
            } catch (error) {
              trace?.end(preparationSpan, { outcome: "failed" });
              throw error;
            } finally {
              timings.preparation.record(monotonicNow() - preparationStartedAt);
            }
          }
        } catch (error) {
          qa.acquisitionFailures += 1;
          failures.record("acquisitionFailures", error, "source_preparation");
          continue;
        }
        if (generation !== preparationGeneration) {
          if (pendingEagerEntries) continue;
          prepared = undefined;
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

  function scheduleEagerHydration(entries) {
    preparationGeneration += 1;
    const background = [];
    for (const entry of entries) {
      if (entry.detailReadiness === "unavailable" || !shouldEagerHydrate(entry)) continue;
      if (needsInitialLiveHydration(entry.localId) || isNewSessionPriorityEligible(entry)) {
        // Do not wait for preparation of unrelated history. Keep retrying this
        // lane across catalog refreshes until initial evidence is published.
        enqueueHydration(entry.localId, { priority: URGENT, rerunIfActive: true });
      } else background.push({ entry, priority: BACKGROUND });
    }
    pendingEagerEntries = background;
    // Let urgent workers start their session-local preparation before a bulk
    // preparer can do synchronous work on this same event loop.
    void yieldControl().then(() => drainEagerPreparation(), () => {});
  }

  /** @param {{fresh?: boolean, sessionIds?: string[], sourceEventAt?: number}} [request] */
  async function refresh({ fresh = false, sessionIds = [], sourceEventAt } = {}) {
    if (stopped || signal?.aborted || !publisher) return;
    for (const id of sessionIds) {
      if (!catalogHydrations.has(id)) catalogHydrations.set(id, sourceEventAt);
    }
    if (refreshPending) {
      refreshQueued = true;
      refreshQueuedFresh ||= fresh;
      return;
    }
    refreshPending = true;
    lastCatalogPassAt = monotonicNow();
    if (sourceCatalogDirty) {
      // This pass reads the catalog after the pending notification, so it answers it.
      sourceCatalogDirty = false;
      fresh = true;
    }
    const rehydrate = new Map(catalogHydrations);
    catalogHydrations.clear();
    qa.reconciliationRuns += 1;
    try {
      const discoveryStartedAt = monotonicNow();
      // Catalog discovery has no priority lane; it carries only the provider id.
      const discoverySpan = trace?.begin({ stage: "catalog_discovery", domain: "acquisition", provider: observerProviderId });
      let entries;
      try {
        entries = await list({ fresh });
        trace?.end(discoverySpan, { outcome: "completed" });
      } catch (error) {
        trace?.end(discoverySpan, { outcome: "failed" });
        throw error;
      } finally {
        timings.catalogDiscovery.record(monotonicNow() - discoveryStartedAt);
      }
      if (stopped || signal?.aborted) return;
      if (!Array.isArray(entries)) throw new TypeError("Provider catalog is unavailable");
      latestEntries.clear();
      for (const entry of entries) {
        if (entry && typeof entry.localId === "string" && entry.localId) latestEntries.set(entry.localId, entry);
      }
      if (startupCatalogIds === null) startupCatalogIds = new Set(latestEntries.keys());
      publisher.publishCatalog(entries);
      for (const id of hydratedSessions) {
        if (!latestEntries.has(id)) hydratedSessions.delete(id);
      }
      // Queue initial live loads before broad catalog notifications can consume
      // acquisition capacity. Routine eager preparation remains independent.
      scheduleEagerHydration(entries);
      // Lifecycle/index notifications hydrate against the catalog just read,
      // including sessions that left the eager working set on this revision.
      for (const [localSessionId, eventAt] of rehydrate) {
        preparationGeneration += 1;
        if (latestEntries.has(localSessionId) && latestEntries.get(localSessionId).detailReadiness !== "unavailable") enqueueHydration(localSessionId, {
          priority: needsInitialLiveHydration(localSessionId) ? URGENT
            : latestEntries.get(localSessionId).isLive || latestEntries.get(localSessionId).needsInput ? SOURCE_UPDATE : BACKGROUND,
          rerunIfActive: true, sourceEventAt: eventAt,
        });
      }
    } catch {
      for (const [id, eventAt] of rehydrate) {
        if (!catalogHydrations.has(id)) catalogHydrations.set(id, eventAt);
      }
      // The registry records observer failures.  Do not erase an existing
      // catalog or publish an incomplete replacement here.
    } finally {
      refreshPending = false;
      settleCatalogWaiters();
      if (refreshQueued && !stopped && !signal?.aborted) {
        const queuedFresh = refreshQueuedFresh;
        refreshQueued = false;
        refreshQueuedFresh = false;
        // A queued watcher/reconciliation pass must not form a microtask-only
        // loop that starves the monitor's HTTP server.
        void yieldControl().then(() => refresh({ fresh: queuedFresh }), () => {});
      } else scheduleSourceCatalog();
    }
  }

  /**
   * Source notifications mark the catalog dirty instead of each starting a full discovery
   * pass. An idle observer whose last pass began at least `sourceCatalogSpacingMs` ago starts
   * one immediately; otherwise one trailing pass runs when the spacing elapses (or when an
   * in-flight pass finishes, whichever is later). A burst of N notifications therefore costs
   * at most one pass per spacing window, and the last notification is always followed by a
   * pass that starts after it.
   */
  function requestSourceCatalog(sessionIds, sourceEventAt) {
    for (const id of sessionIds) {
      if (!catalogHydrations.has(id)) catalogHydrations.set(id, sourceEventAt);
    }
    sourceCatalogDirty = true;
    scheduleSourceCatalog();
  }

  function scheduleSourceCatalog() {
    if (!sourceCatalogDirty || sourceCatalogTimer || refreshPending || stopped || signal?.aborted) return;
    const waitMs = lastCatalogPassAt + sourceCatalogSpacingMs - monotonicNow();
    if (waitMs <= 0) {
      void refresh({ fresh: true });
      return;
    }
    sourceCatalogTimer = setTimeout(() => {
      sourceCatalogTimer = null;
      scheduleSourceCatalog();
    }, Math.ceil(waitMs));
    sourceCatalogTimer.unref?.();
  }

  async function handleSourceEvent(change) {
    if (stopped || signal?.aborted) return;
    const sourceEventAt = monotonicNow();
    // A notification that moved neither the file's size nor its modification time (a
    // last-access update caused by a read, on Windows) is not a source event at all.
    const written = await sourceWrites.classify(change);
    if (stopped || signal?.aborted) return;
    if (written === "unchanged") {
      qa.unchangedSourceEvents += 1;
      return;
    }
    trace?.recordDuration({ stage: "source_notification", domain: "acquisition", durationMs: 0 });
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
    // sources skip discovery and enter acquisition immediately. A write to a
    // source its sessions already read is answered by that immediate read: the
    // catalog is still marked dirty, but the sessions are not retained for a
    // second read after the pass, which would find nothing new.
    if (routed.catalog) {
      const answeredNow = routed.sourceKnown && !routed.afterCatalog && change?.eventType === "change";
      requestSourceCatalog(answeredNow ? [] : routed.sessionIds, sourceEventAt);
      if (routed.afterCatalog) return;
    }
    for (const localSessionId of routed.sessionIds) {
      preparationGeneration += 1;
      // The live-update lane is for a confirmed write, a live session, or a session the
      // catalog does not list yet. Any other notification for a settled session waits with
      // background work, so a burst of them cannot delay live sessions.
      const entry = latestEntries.get(localSessionId);
      const liveLane = written === "written" || !entry || entry.isLive || entry.needsInput;
      enqueueHydration(localSessionId, {
        priority: needsInitialLiveHydration(localSessionId) ? URGENT : liveLane ? SOURCE_UPDATE : BACKGROUND,
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
    if (sourceCatalogTimer) clearTimeout(sourceCatalogTimer);
    sourceCatalogTimer = null;
    sourceCatalogDirty = false;
    for (const watcher of watchers.splice(0)) {
      try { watcher.close(); } catch { /* best-effort observer shutdown */ }
    }
    for (const item of pendingHydrations.values()) {
      for (const resolve of item.waiters) resolve(false);
    }
    pendingHydrations.clear();
    catalogHydrations.clear();
    sourceWrites.clear();
    hydratedSessions.clear();
    pendingEagerEntries = null;
    settleCatalogWaiters();
  }

  return Object.freeze({
    async start(nextPublisher, nextSignal, diagnostics = {}) {
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
      trace = diagnostics.trace || null;
      traceScopeForLocalId = diagnostics.traceScopeForLocalId || null;
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
      preparationGeneration += 1;
      return enqueueHydration(localSessionId, { priority: URGENT, wait: true, requested: true, rerunIfActive: true });
    },
    listSessions: list,
    refresh,
    stop,
    diagnostics: () => Object.freeze({
      ...qa,
      sourceEventQueueDelayAverageMs: qa.sourceEventQueueSamples
        ? Math.round(qa.sourceEventQueueDelayTotalMs / qa.sourceEventQueueSamples)
        : 0,
      activeHydrations: runningHydrations.size,
      pendingHydrations: pendingHydrations.size,
      oldestPendingMs: Math.max(0, ...[...pendingHydrations.values()].map((item) => monotonicNow() - item.queuedAt)),
      hydrationConcurrency: concurrency,
      interactiveHydrationConcurrency: interactiveConcurrency,
      sourceUpdateConcurrency,
      backgroundHydrationConcurrency: backgroundConcurrency,
      failureDetails: failures.snapshot(),
      timings: Object.freeze(Object.fromEntries(Object.entries(timings).map(([key, series]) => [key, series.snapshot()]))),
    }),
  });
}
