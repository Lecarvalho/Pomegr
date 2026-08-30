import fs from "node:fs";
import path from "node:path";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { resolveCodexLivenessRoot, readBridgeRecords, bridgeLiveness, currentBridgeResourceOwner, uniqueResourceOwner } from "./codex-hook-lifecycle.mjs";
import { appServerLiveness } from "./codex-owning-runtime.mjs";
import { readCodexLivenessTail, observedCodexRolloutLifecycle } from "./codex-rollout-lifecycle.mjs";
import { isActiveCodexWriterLock } from "./codex-cli-observation.mjs";
import { createCodexSourceRouter, codexInferenceEligible } from "./codex-source-routing.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";
import { codexRecordedLiveness } from "./codex-recorded-lifecycle.mjs";
import { aggregateCodexSessionLifecycle } from "./codex-session-lifecycle.mjs";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS, CODEX_BRIDGE_LEASE_MS, CODEX_LIVENESS_CACHE_MS, CODEX_LIVENESS_MAX_BRIDGE_FILES, CODEX_LIVENESS_MAX_TAIL_BYTES, CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS, CODEX_LIVENESS_MAX_COLD_ROLLOUTS } from "./codex-lifecycle-constants.mjs";
export * from "./codex-lifecycle-constants.mjs";
export { resolveCodexLivenessRoot, captureCodexLifecycleHook, renewCodexOwnerLease, processStartIdentity, codexOwnerIdentity } from "./codex-hook-lifecycle.mjs";
export { isActiveCodexWriterLock } from "./codex-cli-observation.mjs";
export { parseCodexCliRolloutLiveness as parseCodexRolloutLiveness } from "./codex-cli-observation.mjs";
export { appServerLiveness } from "./codex-owning-runtime.mjs";
function timestampValue(value) { const ms = Date.parse(value || ""); return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY; }

function descendantsFor(rootId, threads) {
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const thread of threads) {
      if (included.has(thread.localId)) continue;
      if (thread.sessionId === rootId || included.has(thread.parentThreadId) || included.has(thread.forkedFromId)) {
        included.add(thread.localId);
        changed = true;
      }
    }
  }
  return included;
}

export function createCodexLivenessCoordinator(options = {}) {
  const root = resolveCodexLivenessRoot(options);
  const writerLocksRoot = options.writerLocksRoot ? path.resolve(options.writerLocksRoot) : null;
  const writerLockIsActive = options.writerLockIsActive || ((file) => isActiveCodexWriterLock(file, { platform: options.platform }));
  const now = options.now || (() => Date.now());
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : CODEX_LIVENESS_CACHE_MS;
  const maximumBridgeFiles = Number.isInteger(options.maximumBridgeFiles)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_BRIDGE_FILES, options.maximumBridgeFiles))
    : CODEX_LIVENESS_MAX_BRIDGE_FILES;
  const maximumTailBytes = Number.isInteger(options.maximumTailBytes)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_TAIL_BYTES, options.maximumTailBytes))
    : CODEX_LIVENESS_MAX_TAIL_BYTES;
  const tailCache = new Map();
  const recordedSources = new Map();
  const rolloutObservations = new Map();
  const stalePolls = new Map();
  let cache = null;
  let lastCheckedAt = null;
  let resumeGraceUntil = 0;
  let stats = { bridgeFiles: 0, rolloutFiles: 0, rolloutBytes: 0 };

  function hasCurrentWriterLock(thread) {
    const localId = isSafeCodexSessionId(thread?.localId) ? thread.localId : null;
    if (!writerLocksRoot || !localId) return false;
    return writerLockIsActive(path.join(writerLocksRoot, `${localId}.lock`)) === true;
  }

  function rolloutEvidence(file, nowMs, implementation, unavailableReason) {
    if (!file) return null;
    let stat;
    try { stat = fs.statSync(file); } catch { return null; }
    const recorded = recordedSources.get(file);
    if (recorded) {
      const current = incrementalSourceDescriptor(file);
      const matching = current && current.identity === recorded.generation.identity
        && current.size === recorded.generation.size && current.mtimeMs === recorded.generation.mtimeMs
        && current.suffixDigest === recorded.generation.suffixDigest;
      if (matching) {
        const retained = codexRecordedLiveness(recorded.state, { now: nowMs, complete: recorded.complete });
        if (retained) return retained;
      }
    }
    const key = `${stat.size}:${stat.mtimeMs}`;
    let cached = tailCache.get(file);
    if (!cached || cached.key !== key) {
      const read = readCodexLivenessTail(file, maximumTailBytes);
      const previousBoundary = cached && stat.size > cached.size ? cached.boundary : null;
      const tailBoundary = observedCodexRolloutLifecycle(read.records, { now: nowMs }).boundary;
      const continuous = !cached || stat.size <= cached.size
        || (cached.size >= read.startOffset && cached.continuous !== false);
      cached = { key: read.key, records: read.records, size: stat.size,
        complete: read.complete,
        continuous: Boolean(tailBoundary) || continuous,
        boundary: observedCodexRolloutLifecycle(read.records, { now: nowMs, previous: previousBoundary }).boundary };
      tailCache.set(file, cached);
      while (tailCache.size > CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS) tailCache.delete(tailCache.keys().next().value);
      stats.rolloutFiles += 1;
      stats.rolloutBytes += Math.min(stat.size, maximumTailBytes);
    }
    const explicit = observedCodexRolloutLifecycle(cached.records, { now: nowMs, previous: cached.boundary }).liveness;
    const inferred = implementation.infer(cached.records, { now: nowMs });
    if (!cached.complete || !cached.continuous) {
      const last = explicit || inferred;
      return last ? { ...last, status: "unknown", needsInput: false, evidence: "unavailable",
        freshness: "stale", reason: "observation_gap" } : null;
    }
    if (inferred?.needsInputKind === "user_input" && (!explicit || inferred.observedAt >= explicit.observedAt)) return { ...inferred, source: "structured_lifecycle", evidence: "observed", freshness: "current" };
    if (explicit?.evidence === "observed") return explicit;
    if (inferred && !unavailableReason && codexInferenceEligible(options.deterministicAvailability)) {
      return { ...inferred, evidence: "inferred", freshness: "current" };
    }
    const last = inferred || explicit;
    return last ? { ...last, status: "unknown", needsInput: false, evidence: "unavailable",
      reason: unavailableReason || "observation_gap", freshness: explicit?.freshness || "current" } : null;
  }

  function rolloutMetadataCanBeLive(thread, nowMs, maximumAge = CODEX_ROLLOUT_LIVE_WINDOW_MS) {
    const updatedAt = timestampValue(thread.updatedAt);
    const metadataFresh = !Number.isFinite(updatedAt) || nowMs - updatedAt <= maximumAge;
    if (!thread.rolloutFile) return metadataFresh;
    let stat;
    try { stat = fs.statSync(thread.rolloutFile); } catch { return metadataFresh; }
    const key = `${stat.size}:${stat.mtimeMs}`;
    const previous = rolloutObservations.get(thread.rolloutFile);
    const changedAt = previous && previous.key !== key
      ? nowMs
      : previous?.changedAt ?? (metadataFresh ? nowMs : null);
    rolloutObservations.delete(thread.rolloutFile);
    rolloutObservations.set(thread.rolloutFile, { key, changedAt });
    while (rolloutObservations.size > CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS) {
      rolloutObservations.delete(rolloutObservations.keys().next().value);
    }
    return metadataFresh || (changedAt !== null && nowMs - changedAt <= maximumAge);
  }

  function observe(threads, observeOptions = {}) {
    if (observeOptions.historical) return { threads: threads.map((thread) => ({ ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false })), sessions: new Map() };
    const checkedAt = now();
    if (cache && checkedAt < cache.expiresAt && cache.input === threads) return cache.value;
    if (lastCheckedAt !== null && checkedAt - lastCheckedAt > CODEX_BRIDGE_LEASE_MS) resumeGraceUntil = checkedAt + CODEX_BRIDGE_LEASE_MS;
    lastCheckedAt = checkedAt;
    stats = { bridgeFiles: 0, rolloutFiles: 0, rolloutBytes: 0 };
    const bridgeRecords = readBridgeRecords(root, maximumBridgeFiles);
    stats.bridgeFiles = bridgeRecords.length;
    const bridgeByActor = new Map();
    for (const record of bridgeRecords) {
      const actorId = record.snapshot.agentId || record.snapshot.sessionId;
      const key = `${record.snapshot.sessionId}\0${actorId}`;
      const previous = bridgeByActor.get(key);
      if (!previous || record.snapshot.sequence > previous.snapshot.sequence
        || (record.snapshot.sequence === previous.snapshot.sequence
          && timestampValue(record.snapshot.observedAt) > timestampValue(previous.snapshot.observedAt))) {
        bridgeByActor.set(key, record);
      }
    }
    const resourceOwnersByThreadId = new Map();
    const topLevelSourceBySessionId = new Map(
      threads
        .filter((thread) => !thread.parentThreadId)
        .map((thread) => [thread.sessionId || thread.localId, thread.sourceKind]),
    );
    const sourceFor = createCodexSourceRouter(CODEX_LIVENESS_MAX_COLD_ROLLOUTS);
    const observedThreads = threads.map((thread) => {
      if (thread.archived) return { ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false };
      const app = appServerLiveness(thread.runtimeStatus, thread.runtimeObservedAt || thread.updatedAt);
      const bridgeKey = `${thread.sessionId || thread.localId}\0${thread.localId}`;
      const bridgeRecord = bridgeByActor.get(bridgeKey);
      let bridge = null;
      if (bridgeRecord) {
        const staleKey = `${bridgeRecord.snapshot.ownerPid}\0${bridgeRecord.snapshot.ownerStartedAt}\0${bridgeRecord.snapshot.bridgeInstance}`;
        const leaseCurrent = timestampValue(bridgeRecord.lease?.expiresAt) > checkedAt;
        const resourceOwner = currentBridgeResourceOwner(bridgeRecord, checkedAt);
        if (resourceOwner) resourceOwnersByThreadId.set(thread.localId, resourceOwner);
        if (leaseCurrent) stalePolls.delete(staleKey);
        else stalePolls.set(staleKey, (stalePolls.get(staleKey) || 0) + 1);
        const keepStale = checkedAt < resumeGraceUntil || (stalePolls.get(staleKey) || 0) < 2;
        bridge = bridgeLiveness(bridgeRecord, checkedAt, keepStale);
      }
      // A hook is an event observation, not a fresh runtime snapshot. Continue
      // acquiring structured boundaries so a later completion can supersede it.
      const authoritative = Boolean(app);
      const metadataCanBeLive = !authoritative && rolloutMetadataCanBeLive(thread, checkedAt);
      const implementation = sourceFor(topLevelSourceBySessionId.get(thread.sessionId || thread.localId) || thread.sourceKind);
      const coldCandidate = !authoritative && !metadataCanBeLive && implementation.coldCandidate(thread, hasCurrentWriterLock);
      const rollout = !authoritative && (metadataCanBeLive || coldCandidate || recordedSources.has(thread.rolloutFile))
        ? rolloutEvidence(thread.rolloutFile, checkedAt, implementation, thread.runtimeAvailability || null)
        : null;
      // A newer recorded boundary can repair an older ambiguous hook snapshot.
      // A current owning-runtime snapshot is authoritative for its loaded task.
      const explicitRollout = rollout?.evidence === "observed";
      const liveness = app || (explicitRollout && (!bridge || rollout.observedAt >= bridge.observedAt) ? rollout : bridge) || rollout;
      return {
        ...thread,
        liveStatus: liveness?.status || "unknown",
        liveness: liveness ? {
          source: liveness.source, observedAt: liveness.observedAt,
          evidence: liveness.evidence, freshness: liveness.freshness,
          ...(liveness.reason ? { reason: liveness.reason } : {}),
        } : null,
        livenessLive: Boolean(liveness?.live || (bridge?.live && explicitRollout)),
      };
    });
    const sessions = new Map();
    for (const rootThread of observedThreads.filter((thread) => !thread.parentThreadId)) {
      const ids = descendantsFor(rootThread.localId, observedThreads);
      const related = observedThreads.filter((thread) => ids.has(thread.localId));
      const live = related.filter((thread) => thread.livenessLive);
      const newest = live.map((thread) => thread.liveness).filter(Boolean).sort((left, right) => timestampValue(right.observedAt) - timestampValue(left.observedAt))[0];
      const resourceOwner = live.length > 0
        ? uniqueResourceOwner(related.map((thread) => resourceOwnersByThreadId.get(thread.localId)).filter(Boolean))
        : null;
      sessions.set(rootThread.localId, {
        ...aggregateCodexSessionLifecycle(rootThread, related),
        observedAt: newest?.observedAt || null,
        resourceOwner,
      });
    }
    const value = { threads: observedThreads, sessions };
    cache = { input: threads, expiresAt: checkedAt + cacheMs, value };
    return value;
  }

  return Object.freeze({
    observe,
    observeLifecycleSources(observations) {
      let changed = false;
      for (const { file, generation, state, complete } of observations) {
        if (!state || !generation) continue;
        const value = { generation: { identity: generation.identity, size: generation.size,
          mtimeMs: generation.mtimeMs, suffixDigest: generation.suffixDigest }, state, complete };
        const previous = recordedSources.get(file);
        if (JSON.stringify(previous) === JSON.stringify(value)) continue;
        recordedSources.delete(file);
        recordedSources.set(file, value);
        changed = true;
      }
      while (recordedSources.size > CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS) recordedSources.delete(recordedSources.keys().next().value);
      if (changed) cache = null;
      return changed;
    },
    applyWaiting(agents) { return applyWaitingStatus(agents); },
    stats() { return { ...stats, cachedRollouts: tailCache.size }; },
  });
}
