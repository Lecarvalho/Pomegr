import { createSessionHistoryRefreshScheduler } from "./session-history-refresh-scheduler.mjs";

const MAX_SOURCE_PROOFS = 128;

function rememberBounded(map, key, value) {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_SOURCE_PROOFS) map.delete(map.keys().next().value);
}

/** Own complete-history replay scheduling and private source-generation proofs. */
export function createSessionHistoryRuntime(options = {}) {
  const {
    registry, observationStore, historyStore, trace, ownedTraceScope,
    isActive, foregroundConcurrency = 1, backgroundConcurrency = 1,
  } = options;
  const completedSources = new Map();
  const attemptedSources = new Map();
  const observationKeys = new Map();

  function sourceKey(sessionId, snapshot) {
    const source = snapshot?.source;
    if (typeof source?.fingerprint === "string" && Number.isSafeInteger(source.completeOffset)) {
      return `${source.fingerprint}:${source.completeOffset}`;
    }
    const semanticRevision = observationKeys.get(sessionId);
    return Number.isSafeInteger(semanticRevision) ? `observation:${semanticRevision}` : null;
  }

  async function run(sessionId, priority) {
    if (!isActive()) return;
    const snapshot = observationStore.getByQualifiedId(sessionId);
    const provider = snapshot && registry.providers?.find((entry) => entry.id === snapshot.providerId);
    if (!snapshot || typeof provider?.readSessionHistory !== "function") return;
    const key = sourceKey(sessionId, snapshot);
    if (key) rememberBounded(attemptedSources, sessionId, key);
    const scope = ownedTraceScope(sessionId);
    const flow = trace?.createFlow?.({ scope }) || null;
    const readSpan = trace?.begin?.({ stage: "history_read", domain: "activity", flow, scope }) || null;
    let historyOutcome = "completed";
    return Promise.resolve(historyStore.activityFence(sessionId))
      .then((activityFence) => provider.readSessionHistory(snapshot.localSessionId)
        .then((history) => {
          trace?.end?.(readSpan, { outcome: "completed" });
          const publishSpan = trace?.begin?.({ stage: "history_publish", domain: "activity", flow, scope }) || null;
          const publication = typeof historyStore.publishOutcome === "function"
            ? historyStore.publishOutcome(sessionId, history, { activityFence })
            : historyStore.publish(sessionId, history, { activityFence })
              .then((record) => ({ record, accepted: Boolean(record), reason: record ? "accepted" : "incomplete" }));
          return publication.then(({ record, accepted, reason }) => {
            trace?.end?.(publishSpan, { outcome: accepted ? "accepted" : "unchanged" });
            if (accepted && record && history?.complete === true && key) rememberBounded(completedSources, sessionId, key);
            else if (reason === "stale_fence" && isActive()) refresh(sessionId, priority, true, true);
            return record;
          }, (error) => { trace?.end?.(publishSpan, { outcome: "failed" }); throw error; });
        }))
      .catch(() => {
        historyOutcome = "failed";
        if (attemptedSources.get(sessionId) === key) attemptedSources.delete(sessionId);
        return null;
      })
      .finally(() => {
        trace?.end?.(readSpan, { outcome: "failed" });
        trace?.finishFlow?.(flow, { outcome: historyOutcome });
      });
  }

  const scheduler = createSessionHistoryRefreshScheduler({ run, foregroundConcurrency, backgroundConcurrency });

  function refresh(sessionId, priority = 1, rerunIfActive = true, force = false) {
    if (!isActive()) return;
    const snapshot = observationStore.getByQualifiedId(sessionId);
    const key = sourceKey(sessionId, snapshot);
    if (key && completedSources.get(sessionId) === key) {
      if (historyStore.hasCommitted?.(sessionId) !== false) return;
      completedSources.delete(sessionId);
    }
    if (!force && key && attemptedSources.get(sessionId) === key) return;
    scheduler.enqueue(sessionId, { priority, rerunIfActive });
  }

  return Object.freeze({
    start: scheduler.start,
    stop() { completedSources.clear(); attemptedSources.clear(); observationKeys.clear(); scheduler.stop(); },
    observe(sessionId, revision) {
      if (Number.isSafeInteger(revision)) rememberBounded(observationKeys, sessionId, revision);
    },
    ensureObserved(sessionId, revision) {
      if (!observationKeys.has(sessionId) && Number.isSafeInteger(revision)) rememberBounded(observationKeys, sessionId, revision);
    },
    refresh,
    prioritize(sessionId) { if (!scheduler.promote(sessionId)) refresh(sessionId, 0, false); },
    invalidate(sessionId) { completedSources.delete(sessionId); attemptedSources.delete(sessionId); },
    diagnostics: scheduler.diagnostics,
  });
}
