import { createNotificationCatalog } from "../notifications/notification-catalog.mjs";
import { createCommittedResponseCache } from "../persistence/committed-response-cache.mjs";
import { createCheckpointRestore } from "../sessions/checkpoints/session-checkpoint-restore.mjs";
import { createDurationSeries } from "../diagnostics/pipeline-operations.mjs";
import { createObservationPersistenceQueue, checkpointFailureStage } from "./observation-persistence-queue.mjs";
import { parseProviderSessionId } from "../providers/provider-contract.mjs";
import { catalogShellRow, createRowSummaryWriter } from "../sessions/catalog/session-catalog-row.mjs";
import { createSessionCatalogInventory } from "../sessions/catalog/session-catalog-inventory.mjs";
import { scanProviderHeaders } from "../sessions/catalog/session-header-scan.mjs";
import { MAX_CATALOG_SHELL_ROWS, catalogSourceScopeKey, catalogStructure, compareCatalogEntries, downgradeRestoredLifecycle, openLiveDeadline, publicCatalogEntry, qualifiedSessionId } from "../sessions/catalog/session-catalog-runtime.mjs";

const OPEN_LIVE_WINDOW_MS = 5 * 60_000;

function projectOpenVisibility(entry, checkedAt) {
  const deadline = openLiveDeadline(entry, checkedAt, OPEN_LIVE_WINDOW_MS);
  return deadline !== null && !(deadline > checkedAt) ? { ...entry, isLive: false } : entry;
}

function inventoryLifecycleRows(providerId, entries, checkedAt) {
  return entries.slice(0, 100).map((entry) => ({
    ...projectOpenVisibility(entry, checkedAt),
    localId: entry.id.slice(providerId.length + 1),
  }));
}


/** Coordinates U1/U2 provider observers with C/D committed session snapshots. */
export function createSessionObservationCoordinator(options = {}) {
  const { registry, store, deriveSession } = options;
  if (!registry || !store || typeof deriveSession !== "function") {
    throw new TypeError("Observation coordinator requires registry, store, and deriveSession");
  }
  const commitDelayMs = Math.max(0, Number(options.commitDelayMs ?? 500));
  const catalogStructuralDelayMs = Math.max(0, Number(options.catalogStructuralDelayMs ?? 0));
  const schedule = options.schedule || ((task, delay) => setTimeout(task, delay));
  const cancel = options.cancel || clearTimeout;
  const now = options.now || Date.now;
  const catalogCache = options.catalogCache || createCommittedResponseCache({ includeRevision: true });
  // The directory owns all normalized headers. The coordinator retains only a
  // bounded shell for live/selected consumers; never use that shell as an
  // inventory or a count.
  const catalogInventory = options.catalogInventory || createSessionCatalogInventory({
    store: () => options.monitorStoreRuntime?.store?.() || null,
    now,
    providers: (registry.providers || []).map((provider) => provider.id),
    scopeKey: catalogSourceScopeKey(registry),
  });
  const checkpointStore = options.checkpointStore || null;
  const checkpointDelayMs = Math.max(0, Number(options.checkpointDelayMs ?? 5_000));
  const checkpointMaxDelayMs = Math.max(checkpointDelayMs, Number(options.checkpointMaxDelayMs ?? 60_000));
  const rowSummaries = createRowSummaryWriter({ store, inventory: catalogInventory, schedule, cancel, now,
    quietMs: checkpointDelayMs, maxMs: checkpointMaxDelayMs, isStopped: () => stopped });
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const trace = options.pipelineTrace;
  const traceScopeForSession = typeof options.traceScopeForSession === "function"
    ? options.traceScopeForSession
    : null;
  function traceScope(providerId, localSessionId) {
    if (!traceScopeForSession) return null;
    try {
      const scope = traceScopeForSession(qualifiedSessionId(providerId, localSessionId));
      return scope && typeof scope === "object" && !Array.isArray(scope) ? scope : null;
    } catch { return null; }
  }
  const catalogsByProvider = new Map();
  const notificationCatalog = createNotificationCatalog({ projectVisibility: projectOpenVisibility });
  const catalogReadinessByProvider = new Map();
  const pendingSessions = new Map();
  const scheduledSessions = new Map();
  const sessionRetryAttempts = new Map();
  const deferredProjectionRefreshes = new Set();
  let persistenceQueue = null;
  const restoredActivitySessions = new Set();
  const restoredHydrations = new Map();
  const subscribers = new Set();
  let catalogTimer = null;
  let openExpiryTimer = null;
  let catalogTimerDueAt = null;
  let catalogDirtyAt = null;
  let abortController = null;
  let lifecycle = null;
  let startPromise = null;
  let stopped = true;
  let generation = 0;
  let selectedPinnedId = null;
  let startupSelection = null;
  let restoreFreshSessions = null;
  let headerScanTimer = null;
  let headerScanRunning = false;
  const timings = Object.freeze({
    catalogCommitWait: createDurationSeries(),
    catalogProjectionCommit: createDurationSeries(),
    sessionCommitWait: createDurationSeries(),
    sessionDerivation: createDurationSeries(),
    sessionStoreCommit: createDurationSeries(),
    sessionCandidateToCommit: createDurationSeries(),
  });
  const qa = {
    sessionCandidates: 0,
    sessionCommits: 0,
    unchangedCandidates: 0,
    rejectedCandidates: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hydrationsQueued: 0,
    invalidations: 0,
    catalogStructuralFastPaths: 0,
    catalogCommitDelaySamples: 0,
    catalogCommitDelayTotalMs: 0,
    catalogCommitDelayLastMs: 0,
    catalogCommitDelayMaxMs: 0,
  };

  function scheduleCheckpoint(snapshot) {
    if (!checkpointStore) return;
    if (!persistenceQueue) persistenceQueue = createObservationPersistenceQueue({
      ...options.persistenceQueueOptions,
      schedule, cancel, now,
      onEvent(event) {
        const outcomes = { started: "accepted", coalesced: "superseded", rejected: "rejected", retry: "incomplete", exhausted: "failed" };
        if (outcomes[event.kind]) trace?.recordDuration({
          stage: "source_queue", domain: "persistence", outcome: outcomes[event.kind],
          durationMs: event.kind === "started" ? event.waitedMs : 0,
        });
      },
      async write(candidate) {
        const scope = traceScope(candidate.providerId, candidate.localSessionId);
        const span = trace?.begin({ stage: "checkpoint", domain: "persistence", scope });
        try {
          await checkpointStore.write(candidate);
          trace?.end(span, { outcome: "accepted" });
        } catch (error) {
          trace?.end(span, { outcome: "failed" });
          trace?.recordDuration({ stage: checkpointFailureStage(error), domain: "persistence", durationMs: 0, outcome: "failed", scope });
          throw error;
        }
      },
    });
    const result = persistenceQueue.enqueue(snapshot, { delayMs: checkpointDelayMs, maxDelayMs: checkpointMaxDelayMs });
    if (result?.accepted === false && result.reason === "invalid") {
      trace?.recordDuration({ stage: "checkpoint", domain: "persistence", durationMs: 0, outcome: "rejected" });
    }
  }

  function notify(event) {
    const span = trace?.begin({ stage: "revision_notify", domain: "lifecycle" });
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* one consumer must not block publication */ }
    }
    trace?.end(span, { outcome: "completed" });
  }

  function commitCatalog() {
    if (stopped) return;
    const projectionStartedAt = monotonicNow();
    const projectionSpan = trace?.begin({ stage: "catalog_projection", domain: "derivation" });
    const checkedAt = now();
    let nextOpenExpiry = Infinity;
    if (openExpiryTimer !== null) cancel(openExpiryTimer);
    openExpiryTimer = null;
    catalogTimer = null;
    catalogTimerDueAt = null;
    if (catalogDirtyAt !== null) {
      const delayMs = Math.max(0, monotonicNow() - catalogDirtyAt);
      qa.catalogCommitDelaySamples += 1;
      qa.catalogCommitDelayTotalMs += delayMs;
      qa.catalogCommitDelayLastMs = delayMs;
      qa.catalogCommitDelayMaxMs = Math.max(qa.catalogCommitDelayMaxMs, delayMs);
      timings.catalogCommitWait.record(delayMs);
      trace?.recordDuration({ stage: "catalog_commit_wait", domain: "commit", durationMs: delayMs });
      catalogDirtyAt = null;
    }
    const projectedCatalogs = new Map();
    for (const [providerId, nativeEntries] of catalogsByProvider) {
      const projectedEntries = nativeEntries.map((nativeEntry) => {
        const deadline = openLiveDeadline(nativeEntry, checkedAt, OPEN_LIVE_WINDOW_MS);
        if (deadline !== null && deadline > checkedAt) nextOpenExpiry = Math.min(nextOpenExpiry, deadline);
        return projectOpenVisibility(nativeEntry, checkedAt);
      });
      projectedCatalogs.set(providerId, projectedEntries);
      // Directory filters and counts must use the same lifecycle projection as
      // the committed shell. In particular, an expired Open row is historical
      // even while the provider still reports native process presence.
      catalogInventory.updateProviderLifecycle(providerId, inventoryLifecycleRows(providerId, projectedEntries, checkedAt));
    }
    const entries = [...projectedCatalogs.values()].flat().sort(compareCatalogEntries);
    rowSummaries.settle(entries.filter((entry) => entry.isLive).map((entry) => entry.id));
    const sessions = entries.slice(0, MAX_CATALOG_SHELL_ROWS).map((entry) => {
      const snapshot = store.getByQualifiedId(entry.id);
      return catalogShellRow(entry, { snapshot, restoredActivity: restoredActivitySessions.has(entry.id),
        persisted: snapshot ? null : catalogInventory.get(entry.id) });
    });
    const providerStates = (registry.providers || []).map((provider) => catalogReadinessByProvider.get(provider.id) || "loading");
    // One provider's empty result cannot establish that the combined catalog is
    // empty while another is still discovering sessions. Available rows can be
    // shown immediately, independently of slower providers or detail hydration.
    const catalogReadiness = !sessions.length && providerStates.includes("loading")
      ? "loading"
      : providerStates.length > 0 && providerStates.every((value) => value === "unavailable")
        ? "unavailable"
        : "ready";
    const committed = catalogCache.commit({
      readiness: {
        catalog: catalogReadiness,
      },
      sessions,
      coverage: catalogInventory.coverage(),
    });
    notificationCatalog.commit({ revision: committed.revision, readiness: catalogReadiness, checkedAt,
      incompleteSource: providerStates.some((state) => state !== "ready") });
    notify({ type: "catalog", revision: committed.revision });
    if (Number.isFinite(nextOpenExpiry)) {
      const expiryGeneration = generation;
      openExpiryTimer = schedule(() => {
        openExpiryTimer = null;
        if (!stopped && generation === expiryGeneration) scheduleCatalogCommit(0);
      }, Math.max(0, nextOpenExpiry - now()));
      openExpiryTimer?.unref?.();
    }
    timings.catalogProjectionCommit.record(monotonicNow() - projectionStartedAt);
    trace?.end(projectionSpan, { outcome: "completed" });
  }

  function scheduleCatalogCommit(delayMs = commitDelayMs) {
    const delay = Math.max(0, Number(delayMs));
    const scheduledAt = monotonicNow();
    if (catalogDirtyAt === null) catalogDirtyAt = scheduledAt;
    const dueAt = scheduledAt + delay;
    if (catalogTimer !== null) {
      if (catalogTimerDueAt !== null && catalogTimerDueAt <= dueAt) return;
      cancel(catalogTimer);
    }
    catalogTimerDueAt = dueAt;
    catalogTimer = schedule(commitCatalog, delay);
  }

  async function commitSession(qualifiedId) {
    const workGeneration = generation;
    scheduledSessions.delete(qualifiedId);
    const candidate = pendingSessions.get(qualifiedId);
    if (!candidate || stopped) return;
    const flow = candidate.traceFlow;
    const scope = candidate.traceScope || traceScope(candidate.providerId, candidate.localSessionId);
    try {
      timings.sessionCommitWait.record(monotonicNow() - candidate.queuedAt);
      trace?.recordDuration({ stage: "session_commit_wait", domain: "commit", durationMs: monotonicNow() - candidate.queuedAt, flow, scope });
      const derivationStartedAt = monotonicNow();
      const derivationSpan = trace?.begin({ stage: "session_derivation", domain: "derivation", flow, scope });
      let derived;
      try {
        derived = await deriveSession(candidate);
        trace?.end(derivationSpan, { outcome: "completed" });
      } catch (error) {
        trace?.end(derivationSpan, { outcome: "failed" });
        throw error;
      } finally {
        timings.sessionDerivation.record(monotonicNow() - derivationStartedAt);
      }
      if (stopped || workGeneration !== generation) {
        trace?.finishFlow(flow, { outcome: "cancelled" });
        return;
      }
      if (pendingSessions.get(qualifiedId) !== candidate) {
        trace?.recordDuration({ stage: "candidate_to_commit", domain: "commit", durationMs: monotonicNow() - candidate.queuedAt, flow, scope, outcome: "superseded" });
        trace?.finishFlow(flow, { outcome: "superseded" });
        scheduleSessionCommit(qualifiedId);
        return;
      }
      const storeStartedAt = monotonicNow();
      const storeSpan = trace?.begin({ stage: "normalized_store_commit", domain: "commit", flow, scope });
      let snapshot;
      try {
        snapshot = store.publish({
          providerId: candidate.providerId,
          localSessionId: candidate.localSessionId,
          evidence: candidate.evidence,
          readiness: derived.readiness,
          publicState: derived.publicState,
          observedAt: candidate.observedAt,
          source: candidate.checkpointSource,
          pinned: candidate.pinned,
        });
      } finally {
        timings.sessionStoreCommit.record(monotonicNow() - storeStartedAt);
        trace?.end(storeSpan, { outcome: snapshot?.accepted ? (snapshot.unchanged ? "unchanged" : "accepted") : "rejected" });
      }
      if (snapshot?.accepted) try {
        const session = derived.publicState?.session;
        catalogInventory.updateHeaders(candidate.providerId, [{
          localId: candidate.localSessionId, title: session?.title || "Untitled session",
          project: session?.project || "Unknown project", createdAt: session?.startedAt || candidate.observedAt,
          updatedAt: session?.updatedAt || candidate.observedAt, repositoryId: session?.repositoryId ?? null,
        }], { preserveLifecycle: true });
      } catch { /* header enrichment must not reject an accepted session */ }
      if (snapshot?.accepted) rowSummaries.record(qualifiedId);
      timings.sessionCandidateToCommit.record(monotonicNow() - candidate.queuedAt);
      trace?.recordDuration({ stage: "candidate_to_commit", domain: "commit", durationMs: monotonicNow() - candidate.queuedAt, flow, scope,
        outcome: snapshot?.accepted ? (snapshot.unchanged ? "unchanged" : "accepted") : "rejected" });
      trace?.finishFlow(flow, { outcome: snapshot?.accepted ? "completed" : "rejected" });
      // Restored task state remains last-observed until new provider evidence
      // validates and commits, including an otherwise unchanged observation.
      if (snapshot?.accepted && candidate.freshObservation && restoredActivitySessions.delete(qualifiedId)) {
        scheduleCatalogCommit(catalogStructuralDelayMs);
      }
      if (snapshot?.accepted && !snapshot.unchanged) {
        pendingSessions.delete(qualifiedId);
        sessionRetryAttempts.delete(qualifiedId);
        qa.sessionCommits += 1;
        // Evidence is already committed: don't add a second summary delay before
        // publishing current activity and notifying the catalog's consumers.
        scheduleCatalogCommit(catalogStructuralDelayMs);
        notify({ type: "session", qualifiedId, revision: snapshot.snapshot.revision,
          freshObservation: candidate.freshObservation === true });
        scheduleCheckpoint(snapshot.snapshot);
        options.onCommitted?.(snapshot.snapshot);
      } else if (snapshot?.accepted) {
        pendingSessions.delete(qualifiedId);
        sessionRetryAttempts.delete(qualifiedId);
        qa.unchangedCandidates += 1;
      } else {
        qa.rejectedCandidates += 1;
        pendingSessions.delete(qualifiedId);
        sessionRetryAttempts.delete(qualifiedId);
      }
      if (deferredProjectionRefreshes.delete(qualifiedId)) refreshProjection(qualifiedId);
    } catch {
      trace?.finishFlow(flow, { outcome: "failed" });
      // D failures retain the previous committed revision. Retry this candidate
      // only while it is current; an obsolete failure must not mark newer work
      // as a retry and reset its already-scheduled publication deadline.
      qa.rejectedCandidates += 1;
      if (pendingSessions.get(qualifiedId) === candidate) scheduleSessionRetry(qualifiedId);
    }
  }

  function scheduleSessionRetry(qualifiedId) {
    if (stopped || !pendingSessions.has(qualifiedId)) return;
    const attempt = (sessionRetryAttempts.get(qualifiedId) || 0) + 1;
    sessionRetryAttempts.set(qualifiedId, attempt);
    if (attempt > 5) {
      pendingSessions.delete(qualifiedId);
      sessionRetryAttempts.delete(qualifiedId);
      return;
    }
    scheduleSessionCommit(qualifiedId, Math.min(30_000, Math.max(1_000, commitDelayMs) * (2 ** Math.min(attempt - 1, 5))));
  }

  function scheduleSessionCommit(qualifiedId, delay = commitDelayMs) {
    if (scheduledSessions.has(qualifiedId)) return;
    const timer = schedule(() => { void commitSession(qualifiedId); }, delay);
    scheduledSessions.set(qualifiedId, timer);
  }

  const publisher = Object.freeze({
    publishHistoryContribution(providerId, localSessionId, contribution) {
      if (stopped) return;
      options.onHistoryContribution?.(providerId, localSessionId, contribution);
    },
    publishHistoryRequestContribution(providerId, localSessionId, contribution) {
      if (stopped) return;
      options.onHistoryRequestContribution?.(providerId, localSessionId, contribution);
    },
    checkpointFor(providerId, localSessionId) {
      const snapshot = store.get(providerId, localSessionId);
      // A restored cursor alone cannot revalidate downgraded live lifecycle:
      // unchanged bytes would skip normalization forever. Reacquire once while
      // retaining the saved response, then resume cursor reuse after commit.
      if (snapshot?.evidence?.historical === false
        && restoredActivitySessions.has(qualifiedSessionId(providerId, localSessionId))) return null;
      const source = snapshot?.source;
      return source?.fingerprint && Number.isSafeInteger(source.completeOffset)
        ? { fingerprint: source.fingerprint, completeOffset: source.completeOffset }
        : null;
    },
    publishCatalog(providerId, entries, readiness = "ready") {
      if (stopped) return;
      const provider = registry.providers?.find((candidate) => candidate.id === providerId);
      const normalized = Array.isArray(entries)
        ? entries.map((entry) => publicCatalogEntry(providerId, provider?.source || entry?.source || "", entry)).filter(Boolean)
        : [];
      notificationCatalog.acceptProvider(providerId, normalized, readiness);
      // Retain only the current shell. Historical directory pages are served
      // from the inventory index, so a large provider scan cannot become a
      // resident browser-facing catalog array.
      const shell = normalized.slice().sort((left, right) => Number(right.isLive || right.needsInput) - Number(left.isLive || left.needsInput)
        || compareCatalogEntries(left, right)).slice(0, MAX_CATALOG_SHELL_ROWS);
      // The ordinary observer catalog is a bounded lifecycle shell. It may
      // update current live state for known headers, but it cannot establish
      // completeness or let header scans erase an observed lifecycle.
      catalogInventory.updateProviderLifecycle(providerId, inventoryLifecycleRows(providerId, shell, now()));
      if (readiness === "unavailable") catalogInventory.replaceProvider(providerId, [], "unavailable");
      const structuralChange = catalogStructure(catalogsByProvider.get(providerId)) !== catalogStructure(shell);
      catalogsByProvider.set(providerId, shell);
      catalogReadinessByProvider.set(providerId, readiness === "unavailable" ? "unavailable" : "ready");
      if (structuralChange) qa.catalogStructuralFastPaths += 1;
      scheduleCatalogCommit(structuralChange ? catalogStructuralDelayMs : commitDelayMs);
    },

    publishSession(providerId, localSessionId, evidence) {
      if (stopped) return;
      qa.sessionCandidates += 1;
      const qualifiedId = qualifiedSessionId(providerId, localSessionId);
      // Track even evicted/invalidated candidates until L2 settles. Overflow
      // skips restoration rather than risking an older replacement.
      if (restoreFreshSessions && restoreFreshSessions.size < 4096) restoreFreshSessions.add(qualifiedId);
      const provider = registry.providers?.find((candidate) => candidate.id === providerId);
      const scheduled = scheduledSessions.get(qualifiedId);
      // Coalesce at the first candidate's deadline. Restarting this timer for
      // every append can starve publication indefinitely during continuous work.
      // Fresh evidence may still preempt a delayed failure retry.
      if (scheduled && sessionRetryAttempts.has(qualifiedId)) {
        cancel(scheduled);
        scheduledSessions.delete(qualifiedId);
      }
      const scope = traceScope(providerId, localSessionId);
      pendingSessions.set(qualifiedId, Object.freeze({
        providerId,
        localSessionId,
        evidence,
        freshObservation: true,
        source: provider?.source || "",
        checkpointSource: evidence?.observationSource || null,
        observedAt: evidence?.session?.updatedAt || new Date().toISOString(),
        pinned: Boolean(evidence?.historical === false),
        queuedAt: monotonicNow(),
        traceScope: scope,
        traceFlow: trace?.createFlow({ scope }),
      }));
      sessionRetryAttempts.delete(qualifiedId);
      scheduleSessionCommit(qualifiedId);
    },

    invalidateSession(providerId, localSessionId, reason) {
      if (stopped) return;
      qa.invalidations += 1;
      const qualifiedId = qualifiedSessionId(providerId, localSessionId);
      pendingSessions.delete(qualifiedId);
      sessionRetryAttempts.delete(qualifiedId);
      const previous = store.getByQualifiedId(qualifiedId);
      if (previous && (reason === "source_unavailable" || reason === "provider_unavailable")) {
        const readiness = Object.fromEntries(Object.keys(previous.readiness).map((key) => [key, "unavailable"]));
        store.publish({
          providerId,
          localSessionId,
          evidence: previous.evidence,
          readiness,
          publicState: { ...previous.publicState, readiness },
          observedAt: previous.observedAt,
          source: previous.source,
          pinned: false,
        });
      } else {
        hydrate(qualifiedId);
      }
      notify({ type: "invalidation", qualifiedId, reason });
    },
  });

  // Applies one validated L2 record from the bulk or on-demand restore. Fresh
  // candidates and already committed revisions always win over a saved record.
  function applyRestoredRecord(record, freshSessions) {
    const id = qualifiedSessionId(record.providerId, record.localSessionId);
    if (freshSessions.size >= 4096 || freshSessions.has(id)
      || store.getByQualifiedId(id) || pendingSessions.has(id)) return false;
    const provider = registry.providers?.find((candidate) => candidate.id === record.providerId);
    if (!provider) return false;
    const restored = store.restore(downgradeRestoredLifecycle(record));
    if (!restored.accepted) return false;
    restoredActivitySessions.add(restored.snapshot.qualifiedId);
    const scope = traceScope(record.providerId, record.localSessionId);
    // Rederive the restored evidence, including its downgraded lifecycle; the
    // original checkpoint must not resurrect a prior process's status.
    pendingSessions.set(restored.snapshot.qualifiedId, Object.freeze({
      providerId: record.providerId, localSessionId: record.localSessionId, evidence: restored.snapshot.evidence,
      source: provider.source || "", checkpointSource: record.source, observedAt: record.observedAt,
      pinned: Boolean(record.evidence?.historical === false), queuedAt: monotonicNow(),
      traceScope: scope, traceFlow: trace?.createFlow({ scope }),
    }));
    scheduleSessionCommit(restored.snapshot.qualifiedId);
    return true;
  }

  // Last-known-good evidence stays available; a restored lifecycle is never current.
  const checkpointRestore = createCheckpointRestore({ checkpointStore, ready: (qualifiedId) => options.checkpointRestoreReady?.(qualifiedId),
    projectState: options.restoreState || (({ evidence }) => evidence), apply: applyRestoredRecord });

  // A requested miss during the startup restore reads its own checkpoint first (one file,
  // asynchronously); `onMissing` keeps today's hydration when none is valid.
  function restoreRequested(qualifiedId, onMissing) {
    return checkpointRestore.request(qualifiedId, (restored) => {
      const snapshot = stopped ? null : store.getByQualifiedId(qualifiedId);
      if (restored && snapshot) notify({ type: "session", qualifiedId, revision: snapshot.revision, freshObservation: false });
      else if (!stopped && !snapshot) onMissing();
    });
  }

  async function restoreCheckpoints(workGeneration, freshSessions) {
    try {
      await checkpointRestore.bulk({ isCurrent: () => !stopped && generation === workGeneration, freshSessions });
    } catch { /* Checkpoints are optional; live acquisition remains available. */ }
    finally {
      if (restoreFreshSessions === freshSessions) restoreFreshSessions = null;
      if (!stopped && generation === workGeneration) {
        try { options.onRestoreComplete?.(); } catch { /* A consumer cannot fail live startup. */ }
      }
    }
  }

  async function start() {
    if (startPromise) return startPromise;
    const controller = new AbortController();
    abortController = controller;
    stopped = false;
    const workGeneration = ++generation;
    // Reapply wall-clock visibility before waiting for provider acquisition.
    if (catalogsByProvider.size) scheduleCatalogCommit(0);
    restoreFreshSessions = new Set();
    void restoreCheckpoints(workGeneration, restoreFreshSessions);
    startPromise = (async () => {
      const observerLifecycle = typeof registry.startObservers === "function"
        ? await registry.startObservers(publisher, controller.signal, { trace, traceScopeForSession })
        : null;
      if (stopped || generation !== workGeneration) {
        await observerLifecycle?.stop?.();
        return null;
      }
      lifecycle = observerLifecycle;
      // Directory scans run independently from observer startup. Tokens for
      // every configured source are opened before any one source can finish,
      // so a partial rescan can never momentarily claim a global exact count.
      void startCatalogHeaderEnumeration(controller.signal);
      if (startupSelection) {
        const selectedId = startupSelection;
        startupSelection = null;
        hydrate(selectedId, { selected: true, restored: restoredActivitySessions.has(selectedId) });
      }
      return lifecycle;
    })();
    try { return await startPromise; }
    catch (error) { if (generation === workGeneration) startPromise = null; throw error; }
  }

  async function startCatalogHeaderEnumeration(signal) {
    if (headerScanRunning || stopped || signal?.aborted || typeof registry.enumerateSessionHeaders !== "function") return;
    headerScanRunning = true;
    try {
      // Header inventory persistence is independent from live observer startup.
      // A slow or unavailable store must never delay selected/live publication.
      try { await options.monitorStoreRuntime?.start?.(); } catch { /* bounded partial fallback remains explicit */ }
      if (stopped || signal?.aborted) return;
      catalogInventory.configureProviders((registry.providers || []).map((provider) => provider.id), { scopeKey: catalogSourceScopeKey(registry) });
      catalogInventory.initialize();
      await scanProviderHeaders({
        registry, catalogInventory, signal, isStopped: () => stopped, onChange: () => scheduleCatalogCommit(0),
      });
    } finally {
      headerScanRunning = false;
      if (!stopped && !signal?.aborted && typeof registry.enumerateSessionHeaders === "function") {
        headerScanTimer = schedule(() => { headerScanTimer = null; void startCatalogHeaderEnumeration(signal); }, 60_000);
        headerScanTimer?.unref?.();
      }
    }
  }

  function hydrate(requestedSessionId, { selected = false, restored = false } = {}) {
    if (!requestedSessionId || stopped) return false;
    if (typeof lifecycle?.hydrate !== "function") {
      // Selection can arrive while checkpoints are already served but provider
      // observers are still starting. Retain only the latest selection.
      if (selected) startupSelection = requestedSessionId;
      return false;
    }
    if ((restored || selected) && (restoredHydrations.has(requestedSessionId)
      || pendingSessions.get(requestedSessionId)?.freshObservation)) return true;
    qa.hydrationsQueued += 1;
    if (!restored && !selected) void lifecycle.hydrate(requestedSessionId).catch(() => {});
    else {
      const observer = lifecycle;
      const workGeneration = generation;
      const request = (restored ? Promise.resolve().then(() => !stopped && generation === workGeneration
        ? observer.hydrate(requestedSessionId) : false) : observer.hydrate(requestedSessionId)).catch(() => {}).finally(() => {
        if (restoredHydrations.get(requestedSessionId) === request) restoredHydrations.delete(requestedSessionId);
      });
      restoredHydrations.set(requestedSessionId, request);
    }
    return true;
  }

  // A checkpoint-restored live session serves its downgraded lifecycle until fresh provider
  // evidence commits. A viewer's request prioritizes that revalidation; the restored hydration
  // itself is deduplicated, so repeated requests queue no additional work.
  function prioritizeRestoredLive(qualifiedId, snapshot = store.getByQualifiedId(qualifiedId)) {
    if (snapshot?.evidence?.historical !== false || !restoredActivitySessions.has(qualifiedId)) return false;
    return hydrate(qualifiedId, { selected: true, restored: true });
  }

  // Queues one asynchronous hydration for a session that has neither committed evidence nor a
  // catalog row (for example one older than the bounded provider catalog window). Returns `false`
  // when the ID does not belong to a registered provider, `null` when nothing could be queued yet
  // (observers not started, or stopped), and otherwise a promise resolving whether the hydration
  // published evidence. It never acquires synchronously, and failures resolve `false`.
  function probeUncatalogued(requestedSessionId) {
    const parsed = typeof requestedSessionId === "string" ? parseProviderSessionId(requestedSessionId) : null;
    if (!parsed || !registry.providers?.some((provider) => provider.id === parsed.providerId)) return false;
    if (stopped || typeof lifecycle?.hydrate !== "function") return null;
    qa.hydrationsQueued += 1;
    const observer = lifecycle;
    const workGeneration = generation;
    return Promise.resolve()
      .then(() => !stopped && generation === workGeneration ? observer.hydrate(requestedSessionId) : false)
      .then((found) => Boolean(found), () => false);
  }

  function refreshProjection(qualifiedId) {
    if (stopped || typeof qualifiedId !== "string" || !qualifiedId) return false;
    if (pendingSessions.has(qualifiedId)) {
      deferredProjectionRefreshes.add(qualifiedId);
      return true;
    }
    const snapshot = store.getByQualifiedId(qualifiedId);
    if (!snapshot) return false;
    const scope = traceScope(snapshot.providerId, snapshot.localSessionId);
    pendingSessions.set(qualifiedId, Object.freeze({
      providerId: snapshot.providerId,
      localSessionId: snapshot.localSessionId,
      evidence: snapshot.evidence,
      source: "",
      checkpointSource: snapshot.source,
      observedAt: snapshot.observedAt,
      pinned: Boolean(snapshot.evidence?.historical === false),
      queuedAt: monotonicNow(),
      traceScope: scope,
      traceFlow: trace?.createFlow({ scope }),
    }));
    sessionRetryAttempts.delete(qualifiedId);
    scheduleSessionCommit(qualifiedId);
    return true;
  }

  async function stop() {
    stopped = true;
    rowSummaries.stop();
    if (headerScanTimer !== null) cancel(headerScanTimer);
    headerScanTimer = null;
    generation += 1;
    abortController?.abort();
    if (catalogTimer !== null) cancel(catalogTimer);
    if (openExpiryTimer !== null) cancel(openExpiryTimer);
    openExpiryTimer = null;
    catalogTimer = null;
    catalogTimerDueAt = null;
    catalogDirtyAt = null;
    for (const timer of scheduledSessions.values()) cancel(timer);
    scheduledSessions.clear();
    pendingSessions.clear();
    sessionRetryAttempts.clear();
    deferredProjectionRefreshes.clear();
    restoredHydrations.clear();
    startupSelection = null;
    restoreFreshSessions = null;
    try { await lifecycle?.stop?.(); } catch { /* shutdown remains best-effort */ }
    // Producers stop before the bounded P owner drains its newest accepted revisions.
    // Maintenance is deliberately not part of this durable-write barrier.
    await persistenceQueue?.stop();
    persistenceQueue = null;
    lifecycle = null;
    startPromise = null;
  }

  return Object.freeze({
    publisher,
    start,
    stop,
    hydrate,
    prioritizeRestoredLive: (qualifiedId) => prioritizeRestoredLive(qualifiedId),
    probeUncatalogued,
    refreshProjection,
    persistenceBusy: () => {
      const pending = persistenceQueue?.stats();
      return pendingSessions.size > 0 || scheduledSessions.size > 0 || Boolean(pending?.pending || pending?.active);
    },
    catalog: (revision) => catalogCache.read(revision),
    notificationCatalog: notificationCatalog.read,
    directory: (query) => catalogInventory.directory(query),
    shell: ({ selected = "", pinned = [] } = {}) => {
      const current = catalogCache.current();
      const base = current?.value || { readiness: { catalog: "loading" }, sessions: [] };
      const requested = [];
      const baseRows = new Map((base.sessions || []).map((entry) => [entry.id, entry]));
      for (const id of [selected, ...pinned]) {
        if (!id || requested.some((entry) => entry.id === id)) continue;
        const existing = baseRows.get(id);
        if (existing) { requested.push(existing); baseRows.delete(id); continue; }
        const identity = catalogInventory.get(id);
        if (identity) requested.push(identity);
      }
      return { revision: current?.revision ?? 0, value: { ...base, sessions: [...requested, ...baseRows.values()].slice(0, MAX_CATALOG_SHELL_ROWS), coverage: catalogInventory.coverage() } };
    },
    catalogIdentity: (sessionId) => catalogInventory.get(sessionId),
    catalogReadiness: () => Object.freeze(Object.fromEntries((registry.providers || []).map((provider) => [
      provider.id,
      catalogReadinessByProvider.get(provider.id) || "loading",
    ]))),
    session(requestedSessionId, revision) {
      const catalog = catalogCache.current()?.value?.sessions || [];
      const parsed = requestedSessionId ? parseProviderSessionId(requestedSessionId) : null;
      const selectedId = requestedSessionId
        ? (parsed && registry.providers?.some((provider) => provider.id === parsed.providerId) ? requestedSessionId : "")
        : catalog.find((entry) => entry.isLive)?.id || catalog[0]?.id || "";
      if (!selectedId) return Object.freeze({ status: "empty", selectedId: "", catalogEntry: null, snapshot: null });
      const snapshot = store.getByQualifiedId(selectedId);
      const indexedIdentity = catalogInventory.get(selectedId);
      const catalogEntry = catalog.find((entry) => entry.id === selectedId)
        || (indexedIdentity ? { ...indexedIdentity, summaryReadiness: "loading" } : null);
      if (!lifecycle) startupSelection = null;
      if (snapshot || catalogEntry || parsed) {
        const selected = parseProviderSessionId(selectedId);
        // Pin a known selection before hydration so other commits cannot evict
        // its first snapshot before the next browser poll receives it.
        store.setPinned(selected.providerId, selected.localSessionId, true);
        if (selectedPinnedId && selectedPinnedId !== selectedId) {
          const previous = parseProviderSessionId(selectedPinnedId);
          const previousSnapshot = store.getByQualifiedId(selectedPinnedId);
          if (previous && previousSnapshot?.evidence?.historical !== false) {
            store.setPinned(previous.providerId, previous.localSessionId, false);
          }
        }
        selectedPinnedId = selectedId;
      }
      if (!snapshot) {
        qa.cacheMisses += 1;
        if (catalogEntry?.summaryReadiness === "unavailable") {
          return Object.freeze({
            status: "unavailable",
            selectedId,
            catalogEntry,
            snapshot: null,
          });
        }
        if (!restoreRequested(selectedId, () => hydrate(selectedId, { selected: true }))) hydrate(selectedId, { selected: true });
        return Object.freeze({
          status: "loading",
          selectedId,
          catalogEntry,
          snapshot: null,
        });
      }
      prioritizeRestoredLive(selectedId, snapshot);
      qa.cacheHits += 1;
      return Object.freeze({
        status: Number(revision) === snapshot.revision ? "unchanged" : "ready",
        selectedId,
        catalogEntry,
        snapshot,
      });
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    diagnostics() {
      return Object.freeze({
        ...qa,
        catalogCommitDelayAverageMs: qa.catalogCommitDelaySamples
          ? Math.round(qa.catalogCommitDelayTotalMs / qa.catalogCommitDelaySamples)
          : 0,
        store: store.stats?.() || null,
        checkpoints: checkpointStore?.stats?.() || null,
        persistence: persistenceQueue?.stats() || null,
        observers: lifecycle?.diagnostics?.() || {},
        timings: Object.freeze(Object.fromEntries(Object.entries(timings).map(([key, series]) => [key, series.snapshot()]))),
      });
    },
  });
}
