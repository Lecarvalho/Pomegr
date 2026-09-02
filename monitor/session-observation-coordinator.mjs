import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { isObservationWorkingSetEntry } from "./observation-working-set.mjs";
import { createDurationSeries } from "./pipeline-operations.mjs";
import { parseProviderSessionId } from "./providers/provider-contract.mjs";
import { projectSessionActivityFallback, projectSessionCurrentActivity, reconcileSessionActivityFallback } from "./session-current-activity.mjs";

function qualifiedSessionId(providerId, localSessionId) {
  return `${providerId}:${localSessionId}`;
}

function compareCatalogEntries(left, right) {
  return Date.parse(right.createdAt || right.updatedAt || "") - Date.parse(left.createdAt || left.updatedAt || "")
    || left.id.localeCompare(right.id);
}

function publicCatalogEntry(providerId, source, entry) {
  const localId = String(entry?.localId || "");
  if (!localId) return null;
  return Object.freeze({
    id: qualifiedSessionId(providerId, localId),
    provider: providerId,
    source,
    title: String(entry.title || "Untitled session"),
    project: String(entry.project || "Unknown project"),
    createdAt: entry.createdAt || entry.updatedAt || null,
    updatedAt: entry.updatedAt || null,
    isLive: Boolean(entry.isLive),
    needsInput: Boolean(entry.needsInput),
    activityStatus: entry.activityStatus || "unknown",
  });
}

function catalogStructure(entries = []) {
  return entries
    .map((entry) => `${entry.id}\0${entry.isLive ? 1 : 0}\0${entry.needsInput ? 1 : 0}\0${entry.activityStatus || "unknown"}`)
    .sort()
    .join("\n");
}

// Lifecycle observations in an L2 checkpoint describe the previous process;
// they are useful context after restart but cannot be presented as current.
function downgradeRestoredLifecycle(record) {
  // Only Codex lifecycle observations are process-local. Do not alter older
  // Claude checkpoints, and do not recursively clone unrelated evidence.
  if (record.providerId !== "codex") return record;
  const historical = record.evidence?.historical === true;
  const downgradeAgent = (agent) => {
    if (!agent || typeof agent !== "object" || !agent.liveness) return agent;
    if (historical) return { ...agent, liveness: null };
    return {
      ...agent,
      status: "unknown",
      liveness: {
        ...agent.liveness,
        evidence: "unavailable",
        freshness: "stale",
        reason: "legacy_snapshot",
      },
    };
  };
  const downgradeAgents = (value) => value && Array.isArray(value.agents)
    ? { ...value, agents: value.agents.map(downgradeAgent) }
    : value;
  return {
    ...record,
    evidence: downgradeAgents(record.evidence),
    publicState: downgradeAgents(record.publicState),
  };
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
  const catalogCache = options.catalogCache || createCommittedResponseCache({ includeRevision: true });
  const checkpointStore = options.checkpointStore || null;
  const checkpointDelayMs = Math.max(0, Number(options.checkpointDelayMs ?? 5_000));
  const checkpointMaxDelayMs = Math.max(checkpointDelayMs, Number(options.checkpointMaxDelayMs ?? 60_000));
  const now = options.now || Date.now;
  const monotonicNow = options.monotonicNow || (() => performance.now());
  const catalogsByProvider = new Map();
  const catalogReadinessByProvider = new Map();
  const pendingSessions = new Map();
  const scheduledSessions = new Map();
  const sessionRetryAttempts = new Map();
  const checkpointTimers = new Map();
  const restoredActivitySessions = new Set();
  const subscribers = new Set();
  let catalogTimer = null;
  let catalogTimerDueAt = null;
  let catalogDirtyAt = null;
  let abortController = null;
  let lifecycle = null;
  let startPromise = null;
  let stopped = true;
  let generation = 0;
  let selectedPinnedId = null;
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
    const previous = checkpointTimers.get(snapshot.qualifiedId);
    if (previous) cancel(previous.timer);
    const firstDirtyAt = previous?.firstDirtyAt ?? now();
    const maximumRemaining = Math.max(0, checkpointMaxDelayMs - (now() - firstDirtyAt));
    const delay = Math.min(checkpointDelayMs, maximumRemaining);
    const timer = schedule(() => {
      checkpointTimers.delete(snapshot.qualifiedId);
      void checkpointStore.write(store.getByQualifiedId(snapshot.qualifiedId) || snapshot).catch(() => {});
    }, delay);
    checkpointTimers.set(snapshot.qualifiedId, { timer, firstDirtyAt });
  }

  function notify(event) {
    for (const subscriber of subscribers) {
      try { subscriber(event); } catch { /* one consumer must not block publication */ }
    }
  }

  function commitCatalog() {
    const projectionStartedAt = monotonicNow();
    catalogTimer = null;
    catalogTimerDueAt = null;
    if (catalogDirtyAt !== null) {
      const delayMs = Math.max(0, monotonicNow() - catalogDirtyAt);
      qa.catalogCommitDelaySamples += 1;
      qa.catalogCommitDelayTotalMs += delayMs;
      qa.catalogCommitDelayLastMs = delayMs;
      qa.catalogCommitDelayMaxMs = Math.max(qa.catalogCommitDelayMaxMs, delayMs);
      timings.catalogCommitWait.record(delayMs);
      catalogDirtyAt = null;
    }
    const entries = [...catalogsByProvider.values()].flat().sort(compareCatalogEntries);
    const previousRows = new Map((catalogCache.current()?.value?.sessions || []).map((entry) => [entry.id, entry]));
    const sessions = entries.map((entry) => {
      const snapshot = store.getByQualifiedId(entry.id);
      const state = snapshot?.publicState;
      const previous = previousRows.get(entry.id);
      const retainPrevious = !entry.isLive
        && !snapshot
        && previous?.summaryReadiness === "ready"
        && previous.updatedAt === entry.updatedAt;
      const primaryAgent = Array.isArray(state?.agents)
        ? state.agents.find((agent) => agent.id === "primary")
        : null;
      return {
        ...entry,
        summaryReadiness: snapshot || retainPrevious ? "ready" : "loading",
        agentCount: Number.isFinite(state?.metrics?.agents)
          ? state.metrics.agents
          : retainPrevious ? previous.agentCount : null,
        activeAgentCount: (snapshot || retainPrevious) && !entry.isLive
          ? 0
          : Number.isFinite(state?.metrics?.activeAgents) ? state.metrics.activeAgents : null,
        latestContextTotal: Number.isFinite(state?.metrics?.tokens?.allAgents)
          ? state.metrics.tokens.allAgents
          : retainPrevious ? previous.latestContextTotal : null,
        progress: state?.session?.progress || (retainPrevious ? previous.progress : null),
        currentActivity: projectSessionCurrentActivity(entry, primaryAgent),
        activityFallback: retainPrevious ? reconcileSessionActivityFallback(entry, previous.activityFallback)
          : projectSessionActivityFallback(restoredActivitySessions.has(entry.id) ? { ...entry, isLive: false } : entry,
            state?.agents, snapshot?.evidence?.toolCalls),
      };
    });
    const providerStates = [...catalogReadinessByProvider.values()];
    const catalogReadiness = providerStates.length > 0 && providerStates.every((value) => value === "unavailable")
      ? "unavailable"
      : "ready";
    const committed = catalogCache.commit({
      readiness: {
        catalog: catalogReadiness,
      },
      sessions,
    });
    notify({ type: "catalog", revision: committed.revision });
    timings.catalogProjectionCommit.record(monotonicNow() - projectionStartedAt);
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
    try {
      timings.sessionCommitWait.record(monotonicNow() - candidate.queuedAt);
      const derivationStartedAt = monotonicNow();
      let derived;
      try {
        derived = await deriveSession(candidate);
      } finally {
        timings.sessionDerivation.record(monotonicNow() - derivationStartedAt);
      }
      if (stopped || workGeneration !== generation) return;
      if (pendingSessions.get(qualifiedId) !== candidate) {
        scheduleSessionCommit(qualifiedId);
        return;
      }
      const storeStartedAt = monotonicNow();
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
      }
      timings.sessionCandidateToCommit.record(monotonicNow() - candidate.queuedAt);
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
        notify({ type: "session", qualifiedId, revision: snapshot.snapshot.revision });
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
    } catch {
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
    checkpointFor(providerId, localSessionId) {
      const source = store.get(providerId, localSessionId)?.source;
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
      const structuralChange = catalogStructure(catalogsByProvider.get(providerId)) !== catalogStructure(normalized);
      catalogsByProvider.set(providerId, normalized);
      catalogReadinessByProvider.set(providerId, readiness === "unavailable" ? "unavailable" : "ready");
      if (structuralChange) qa.catalogStructuralFastPaths += 1;
      scheduleCatalogCommit(structuralChange ? catalogStructuralDelayMs : commitDelayMs);
    },

    publishSession(providerId, localSessionId, evidence) {
      if (stopped) return;
      qa.sessionCandidates += 1;
      const qualifiedId = qualifiedSessionId(providerId, localSessionId);
      const provider = registry.providers?.find((candidate) => candidate.id === providerId);
      const scheduled = scheduledSessions.get(qualifiedId);
      // Coalesce at the first candidate's deadline. Restarting this timer for
      // every append can starve publication indefinitely during continuous work.
      // Fresh evidence may still preempt a delayed failure retry.
      if (scheduled && sessionRetryAttempts.has(qualifiedId)) {
        cancel(scheduled);
        scheduledSessions.delete(qualifiedId);
      }
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

  async function start() {
    if (startPromise) return startPromise;
    abortController = new AbortController();
    stopped = false;
    generation += 1;
    startPromise = (async () => {
      if (checkpointStore) {
        const loaded = await checkpointStore.load({
          includeRecord(record) {
            return isObservationWorkingSetEntry({
              isLive: record.evidence?.historical === false,
              needsInput: record.evidence?.session?.needsInput,
              updatedAt: record.observedAt,
            }, now());
          },
          projectState: options.restoreState || (({ evidence }) => evidence),
        });
        for (const record of loaded.records) {
          if (!registry.providers?.some((provider) => provider.id === record.providerId)) continue;
          const restored = store.restore(downgradeRestoredLifecycle(record));
          if (!restored.accepted) continue;
          restoredActivitySessions.add(restored.snapshot.qualifiedId);
          const provider = registry.providers?.find((candidate) => candidate.id === record.providerId);
          pendingSessions.set(restored.snapshot.qualifiedId, Object.freeze({
            providerId: record.providerId,
            localSessionId: record.localSessionId,
            // Rederive the restored evidence, including its downgraded lifecycle;
            // the original checkpoint must not resurrect a prior process's status.
            evidence: restored.snapshot.evidence,
            source: provider?.source || "",
            checkpointSource: record.source,
            observedAt: record.observedAt,
            pinned: Boolean(record.evidence?.historical === false),
            queuedAt: monotonicNow(),
          }));
          scheduleSessionCommit(restored.snapshot.qualifiedId);
        }
      }
      lifecycle = typeof registry.startObservers === "function"
        ? await registry.startObservers(publisher, abortController.signal)
        : null;
      return lifecycle;
    })();
    try { return await startPromise; }
    catch (error) { startPromise = null; throw error; }
  }

  function hydrate(requestedSessionId) {
    if (!requestedSessionId || typeof lifecycle?.hydrate !== "function") return false;
    qa.hydrationsQueued += 1;
    void lifecycle.hydrate(requestedSessionId).catch(() => {});
    return true;
  }

  function refreshProjection(qualifiedId) {
    if (stopped || typeof qualifiedId !== "string" || !qualifiedId) return false;
    if (pendingSessions.has(qualifiedId)) return true;
    const snapshot = store.getByQualifiedId(qualifiedId);
    if (!snapshot) return false;
    pendingSessions.set(qualifiedId, Object.freeze({
      providerId: snapshot.providerId,
      localSessionId: snapshot.localSessionId,
      evidence: snapshot.evidence,
      source: "",
      checkpointSource: snapshot.source,
      observedAt: snapshot.observedAt,
      pinned: Boolean(snapshot.evidence?.historical === false),
      queuedAt: monotonicNow(),
    }));
    sessionRetryAttempts.delete(qualifiedId);
    scheduleSessionCommit(qualifiedId);
    return true;
  }

  async function stop() {
    stopped = true;
    generation += 1;
    abortController?.abort();
    if (catalogTimer !== null) cancel(catalogTimer);
    catalogTimer = null;
    catalogTimerDueAt = null;
    catalogDirtyAt = null;
    for (const timer of scheduledSessions.values()) cancel(timer);
    scheduledSessions.clear();
    pendingSessions.clear();
    sessionRetryAttempts.clear();
    for (const [qualifiedId, pendingCheckpoint] of checkpointTimers) {
      cancel(pendingCheckpoint.timer);
      const snapshot = store.getByQualifiedId(qualifiedId);
      if (snapshot) {
        try { await checkpointStore?.write(snapshot); } catch { /* checkpoint failure cannot block shutdown */ }
      }
    }
    checkpointTimers.clear();
    try { await lifecycle?.stop?.(); } catch { /* shutdown remains best-effort */ }
    lifecycle = null;
    startPromise = null;
  }

  return Object.freeze({
    publisher,
    start,
    stop,
    hydrate,
    refreshProjection,
    catalog: (revision) => catalogCache.read(revision),
    session(requestedSessionId, revision) {
      const catalog = catalogCache.current()?.value?.sessions || [];
      const parsed = requestedSessionId ? parseProviderSessionId(requestedSessionId) : null;
      const selectedId = requestedSessionId
        ? (parsed && registry.providers?.some((provider) => provider.id === parsed.providerId) ? requestedSessionId : "")
        : catalog.find((entry) => entry.isLive)?.id || catalog[0]?.id || "";
      if (!selectedId) return Object.freeze({ status: "empty", selectedId: "", catalogEntry: null, snapshot: null });
      const snapshot = store.getByQualifiedId(selectedId);
      const catalogEntry = catalog.find((entry) => entry.id === selectedId) || null;
      if (snapshot || catalogEntry) {
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
        hydrate(selectedId);
        return Object.freeze({
          status: "loading",
          selectedId,
          catalogEntry,
          snapshot: null,
        });
      }
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
        observers: lifecycle?.diagnostics?.() || {},
        timings: Object.freeze(Object.fromEntries(Object.entries(timings).map(([key, series]) => [key, series.snapshot()]))),
      });
    },
  });
}
