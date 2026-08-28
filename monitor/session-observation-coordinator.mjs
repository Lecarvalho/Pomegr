import { createCommittedResponseCache } from "./committed-response-cache.mjs";
import { isObservationWorkingSetEntry } from "./observation-working-set.mjs";
import { parseProviderSessionId } from "./providers/provider-contract.mjs";

function qualifiedSessionId(providerId, localSessionId) {
  return `${providerId}:${localSessionId}`;
}

function compareCatalogEntries(left, right) {
  return Number(Boolean(right.isLive)) - Number(Boolean(left.isLive))
    || Number(Boolean(right.needsInput)) - Number(Boolean(left.needsInput))
    || Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || "")
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
    updatedAt: entry.updatedAt || null,
    isLive: Boolean(entry.isLive),
    needsInput: Boolean(entry.needsInput),
    activityStatus: entry.activityStatus || "unknown",
  });
}

/** Coordinates U1/U2 provider observers with C/D committed session snapshots. */
export function createSessionObservationCoordinator(options = {}) {
  const { registry, store, deriveSession } = options;
  if (!registry || !store || typeof deriveSession !== "function") {
    throw new TypeError("Observation coordinator requires registry, store, and deriveSession");
  }
  const commitDelayMs = Math.max(0, Number(options.commitDelayMs ?? 500));
  const schedule = options.schedule || ((task, delay) => setTimeout(task, delay));
  const cancel = options.cancel || clearTimeout;
  const catalogCache = options.catalogCache || createCommittedResponseCache({ includeRevision: true });
  const checkpointStore = options.checkpointStore || null;
  const checkpointDelayMs = Math.max(0, Number(options.checkpointDelayMs ?? 5_000));
  const checkpointMaxDelayMs = Math.max(checkpointDelayMs, Number(options.checkpointMaxDelayMs ?? 60_000));
  const now = options.now || Date.now;
  const catalogsByProvider = new Map();
  const catalogReadinessByProvider = new Map();
  const pendingSessions = new Map();
  const scheduledSessions = new Map();
  const sessionRetryAttempts = new Map();
  const checkpointTimers = new Map();
  const subscribers = new Set();
  let catalogTimer = null;
  let abortController = null;
  let lifecycle = null;
  let startPromise = null;
  let stopped = true;
  let generation = 0;
  let selectedPinnedId = null;
  const qa = {
    sessionCandidates: 0,
    sessionCommits: 0,
    unchangedCandidates: 0,
    rejectedCandidates: 0,
    cacheHits: 0,
    cacheMisses: 0,
    hydrationsQueued: 0,
    invalidations: 0,
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
    catalogTimer = null;
    const sessions = [...catalogsByProvider.values()].flat().sort(compareCatalogEntries);
    const liveSessions = sessions.filter((entry) => entry.isLive).map((entry) => {
      const snapshot = store.getByQualifiedId(entry.id);
      const state = snapshot?.publicState;
      return {
        ...entry,
        agentCount: Number.isFinite(state?.metrics?.agents) ? state.metrics.agents : null,
        activeAgentCount: Number.isFinite(state?.metrics?.activeAgents) ? state.metrics.activeAgents : null,
        latestContextTotal: Number.isFinite(state?.metrics?.tokens?.allAgents) ? state.metrics.tokens.allAgents : null,
        progress: state?.session?.progress || null,
      };
    });
    const providerStates = [...catalogReadinessByProvider.values()];
    const catalogReadiness = providerStates.length > 0 && providerStates.every((value) => value === "unavailable")
      ? "unavailable"
      : "ready";
    const committed = catalogCache.commit({
      readiness: {
        catalog: catalogReadiness,
        sessionSummaries: Object.fromEntries(sessions.map((entry) => [
          entry.id,
          store.getByQualifiedId(entry.id) ? "ready" : "loading",
        ])),
      },
      sessions,
      liveSessions,
    });
    notify({ type: "catalog", revision: committed.revision });
  }

  function scheduleCatalogCommit() {
    if (catalogTimer !== null) return;
    catalogTimer = schedule(commitCatalog, commitDelayMs);
  }

  async function commitSession(qualifiedId) {
    const workGeneration = generation;
    scheduledSessions.delete(qualifiedId);
    const candidate = pendingSessions.get(qualifiedId);
    if (!candidate || stopped) return;
    try {
      const derived = await deriveSession(candidate);
      if (stopped || workGeneration !== generation) return;
      if (pendingSessions.get(qualifiedId) !== candidate) {
        scheduleSessionCommit(qualifiedId);
        return;
      }
      const snapshot = store.publish({
        providerId: candidate.providerId,
        localSessionId: candidate.localSessionId,
        evidence: candidate.evidence,
        readiness: derived.readiness,
        publicState: derived.publicState,
        observedAt: candidate.observedAt,
        source: candidate.checkpointSource,
        pinned: candidate.pinned,
      });
      if (snapshot?.accepted && !snapshot.unchanged) {
        pendingSessions.delete(qualifiedId);
        sessionRetryAttempts.delete(qualifiedId);
        qa.sessionCommits += 1;
        scheduleCatalogCommit();
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
      // D failures retain both the previous committed revision and this
      // normalized candidate. Retry without requiring another source append.
      qa.rejectedCandidates += 1;
      scheduleSessionRetry(qualifiedId);
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
      catalogsByProvider.set(providerId, normalized);
      catalogReadinessByProvider.set(providerId, readiness === "unavailable" ? "unavailable" : "ready");
      scheduleCatalogCommit();
    },

    publishSession(providerId, localSessionId, evidence) {
      if (stopped) return;
      qa.sessionCandidates += 1;
      const qualifiedId = qualifiedSessionId(providerId, localSessionId);
      const provider = registry.providers?.find((candidate) => candidate.id === providerId);
      const scheduled = scheduledSessions.get(qualifiedId);
      if (scheduled) {
        cancel(scheduled);
        scheduledSessions.delete(qualifiedId);
      }
      pendingSessions.set(qualifiedId, Object.freeze({
        providerId,
        localSessionId,
        evidence,
        source: provider?.source || "",
        checkpointSource: evidence?.observationSource || null,
        observedAt: evidence?.session?.updatedAt || new Date().toISOString(),
        pinned: Boolean(evidence?.historical === false),
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
          const restored = store.restore(record);
          if (!restored.accepted) continue;
          const provider = registry.providers?.find((candidate) => candidate.id === record.providerId);
          pendingSessions.set(restored.snapshot.qualifiedId, Object.freeze({
            providerId: record.providerId,
            localSessionId: record.localSessionId,
            evidence: record.evidence,
            source: provider?.source || "",
            checkpointSource: record.source,
            observedAt: record.observedAt,
            pinned: Boolean(record.evidence?.historical === false),
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

  async function stop() {
    stopped = true;
    generation += 1;
    abortController?.abort();
    if (catalogTimer !== null) cancel(catalogTimer);
    catalogTimer = null;
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
    catalog: (revision) => catalogCache.read(revision),
    session(requestedSessionId, revision) {
      const catalog = catalogCache.current()?.value?.sessions || [];
      const parsed = requestedSessionId ? parseProviderSessionId(requestedSessionId) : null;
      const selectedId = requestedSessionId
        ? (parsed && registry.providers?.some((provider) => provider.id === parsed.providerId) ? requestedSessionId : "")
        : catalog.find((entry) => entry.isLive)?.id || catalog[0]?.id || "";
      if (!selectedId) return Object.freeze({ status: "empty", selectedId: "", catalogEntry: null, snapshot: null });
      const snapshot = store.getByQualifiedId(selectedId);
      if (!snapshot) {
        qa.cacheMisses += 1;
        hydrate(selectedId);
        return Object.freeze({
          status: "loading",
          selectedId,
          catalogEntry: catalog.find((entry) => entry.id === selectedId) || null,
          snapshot: null,
        });
      }
      qa.cacheHits += 1;
      if (selectedPinnedId && selectedPinnedId !== selectedId) {
        const previous = parseProviderSessionId(selectedPinnedId);
        const previousSnapshot = store.getByQualifiedId(selectedPinnedId);
        if (previous && previousSnapshot?.evidence?.historical !== false) {
          store.setPinned(previous.providerId, previous.localSessionId, false);
        }
      }
      store.setPinned(snapshot.providerId, snapshot.localSessionId, true);
      selectedPinnedId = selectedId;
      return Object.freeze({
        status: Number(revision) === snapshot.revision ? "unchanged" : "ready",
        selectedId,
        catalogEntry: catalog.find((entry) => entry.id === selectedId) || null,
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
        store: store.stats?.() || null,
        checkpoints: checkpointStore?.stats?.() || null,
        observers: lifecycle?.diagnostics?.() || {},
      });
    },
  });
}
