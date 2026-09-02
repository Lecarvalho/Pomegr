import fs from "node:fs";
import { priorSourceSuffixMatches } from "./source-generation.mjs";
import path from "node:path";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { appServerLiveness } from "./codex-owning-runtime.mjs";
import { readCodexLivenessTail, observedCodexRolloutLifecycle } from "./codex-rollout-lifecycle.mjs";
import { isActiveCodexWriterLock } from "./codex-cli-observation.mjs";
import { createCodexSourceRouter, codexInferenceEligible } from "./codex-source-routing.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";
import { codexRecordedLiveness } from "./codex-recorded-lifecycle.mjs";
import { aggregateCodexSessionLifecycle } from "./codex-session-lifecycle.mjs";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS, CODEX_LIVENESS_CACHE_MS, CODEX_LIVENESS_MAX_TAIL_BYTES, CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS, CODEX_LIVENESS_MAX_COLD_ROLLOUTS } from "./codex-lifecycle-constants.mjs";
export * from "./codex-lifecycle-constants.mjs";
export { isActiveCodexWriterLock } from "./codex-cli-observation.mjs";
export { parseCodexCliRolloutLiveness as parseCodexRolloutLiveness } from "./codex-cli-observation.mjs";
export { appServerLiveness } from "./codex-owning-runtime.mjs";
function timestampValue(value) { const ms = Date.parse(value || ""); return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY; }

function sameGeneration(left, right) {
  return left && right && left.identity === right.identity && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.suffixDigest === right.suffixDigest;
}

function compatibleAppend(file, previous, current) {
  return previous && current && current.identity === previous.identity
    && current.size > previous.size && current.mtimeMs >= previous.mtimeMs
    && priorSourceSuffixMatches(file, previous);
}

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
  const writerLocksRoot = options.writerLocksRoot ? path.resolve(options.writerLocksRoot) : null;
  const writerLockIsActive = options.writerLockIsActive || ((file) => isActiveCodexWriterLock(file, { platform: options.platform }));
  const currentWriterOwner = options.currentWriterOwner || (() => null);
  const now = options.now || (() => Date.now());
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : CODEX_LIVENESS_CACHE_MS;
  const maximumTailBytes = Number.isInteger(options.maximumTailBytes)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_TAIL_BYTES, options.maximumTailBytes))
    : CODEX_LIVENESS_MAX_TAIL_BYTES;
  const tailCache = new Map();
  const recordedSources = new Map();
  const rolloutObservations = new Map();
  let cache = null;
  let stats = { rolloutFiles: 0, rolloutBytes: 0 };

  function ownerFor(thread) {
    // This callback consumes only the collector's private in-memory snapshot.
    // An owning runtime's explicit unload outranks cached writer presence.
    if (thread.archived || thread.runtimeStatus?.type === "notLoaded" || !isSafeCodexSessionId(thread.localId)) return null;
    try {
      const owner = currentWriterOwner(thread.localId);
      return Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.pid <= 0x7fffffff
        && typeof owner.processStartIdentity === "string" && /^\d{1,20}$/.test(owner.processStartIdentity)
        ? { pid: owner.pid, processStartIdentity: owner.processStartIdentity } : null;
    } catch { return null; }
  }

  function hasCurrentWriterLock(thread) {
    const localId = isSafeCodexSessionId(thread?.localId) ? thread.localId : null;
    if (!writerLocksRoot || !localId) return false;
    return writerLockIsActive(path.join(writerLocksRoot, `${localId}.lock`)) === true;
  }

  function rolloutEvidence(file, nowMs, implementation, unavailableReason) {
    if (!file) return null;
    const current = incrementalSourceDescriptor(file);
    if (!current) return null;
    const recorded = recordedSources.get(file);
    if (recorded) {
      // Acquisition lag is not a lifecycle change. Once the full observer owns
      // this source, let it validate appended records before replacing its state.
      if (sameGeneration(current, recorded.generation)
        || compatibleAppend(file, recorded.generation, current)) {
        const retained = codexRecordedLiveness(recorded.state, { now: nowMs, complete: recorded.complete });
        if (retained) return retained;
      }
    }
    const key = `${current.identity}:${current.size}:${current.mtimeMs}:${current.suffixDigest}`;
    let cached = tailCache.get(file);
    if (!cached || cached.key !== key) {
      const read = readCodexLivenessTail(file, maximumTailBytes);
      const appended = cached && compatibleAppend(file, cached.generation, current);
      const previousBoundary = appended ? cached.boundary : null;
      const tailBoundary = observedCodexRolloutLifecycle(read.records, { now: nowMs }).boundary;
      const continuous = !cached || !appended
        || (cached.generation.size >= read.startOffset && cached.continuous !== false);
      const confirmed = incrementalSourceDescriptor(file);
      const stable = sameGeneration(confirmed, current);
      // A framed, continuous prior read remains usable while an ordinary append
      // is unfinished. Malformed records and gaps cannot borrow that evidence.
      const pendingAppend = appended && cached.complete && cached.continuous
        && cached.generation.size >= read.startOffset && read.malformedRecords === 0
        && (!read.complete || !stable)
        && (stable || compatibleAppend(file, current, confirmed));
      if (!pendingAppend) {
        cached = { key, records: read.records, generation: current,
          complete: read.complete && Boolean(stable),
          continuous: Boolean(tailBoundary) || continuous,
          boundary: observedCodexRolloutLifecycle(read.records, { now: nowMs, previous: previousBoundary }).boundary };
        tailCache.set(file, cached);
      }
      while (tailCache.size > CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS) tailCache.delete(tailCache.keys().next().value);
      stats.rolloutFiles += 1;
      stats.rolloutBytes += Math.min(current.size, maximumTailBytes);
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
    if (observeOptions.historical) return { threads: threads.map((thread) => ({ ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false, presenceConfirmed: false })), sessions: new Map() };
    const checkedAt = now();
    const resourceOwnersByThreadId = new Map(threads.flatMap((thread) => {
      const owner = ownerFor(thread);
      return owner ? [[thread.localId, owner]] : [];
    }));
    const presenceKey = JSON.stringify([...resourceOwnersByThreadId]);
    if (cache && checkedAt >= cache.checkedAt && checkedAt < cache.expiresAt
      && cache.input === threads && cache.presenceKey === presenceKey) return cache.value;
    stats = { rolloutFiles: 0, rolloutBytes: 0 };
    const topLevelSourceBySessionId = new Map(
      threads
        .filter((thread) => !thread.parentThreadId)
        .map((thread) => [thread.sessionId || thread.localId, thread.sourceKind]),
    );
    const sourceFor = createCodexSourceRouter(CODEX_LIVENESS_MAX_COLD_ROLLOUTS);
    const observedThreads = threads.map((thread) => {
      if (thread.archived) return { ...thread, runtimeStatus: null, liveStatus: null, liveness: null, livenessLive: false, presenceConfirmed: false };
      const app = appServerLiveness(thread.runtimeStatus, thread.runtimeObservedAt || thread.updatedAt);
      const owner = resourceOwnersByThreadId.get(thread.localId);
      // Writer ownership establishes presence, never execution or completion.
      const authoritative = Boolean(app);
      const metadataCanBeLive = !authoritative && rolloutMetadataCanBeLive(thread, checkedAt);
      const implementation = sourceFor(topLevelSourceBySessionId.get(thread.sessionId || thread.localId) || thread.sourceKind);
      const coldCandidate = !authoritative && !metadataCanBeLive && implementation.coldCandidate(thread, hasCurrentWriterLock);
      const rollout = !authoritative && (owner || metadataCanBeLive || coldCandidate
        || recordedSources.has(thread.rolloutFile) || tailCache.has(thread.rolloutFile))
        ? rolloutEvidence(thread.rolloutFile, checkedAt, implementation, thread.runtimeAvailability || null)
        : null;
      // A current owning-runtime snapshot is authoritative for its loaded task.
      const liveness = app || rollout;
      return {
        ...thread,
        liveStatus: liveness?.status || "unknown",
        // Keep owner-backed presence separate from an unresolved recorded turn.
        presenceConfirmed: Boolean(app || owner),
        liveness: liveness ? {
          source: liveness.source, observedAt: liveness.observedAt,
          evidence: liveness.evidence, freshness: liveness.freshness,
          ...(liveness.reason ? { reason: liveness.reason } : {}),
        } : null,
        livenessLive: Boolean(liveness?.live || owner),
      };
    });
    const sessions = new Map();
    for (const rootThread of observedThreads.filter((thread) => !thread.parentThreadId)) {
      const ids = descendantsFor(rootThread.localId, observedThreads);
      const related = observedThreads.filter((thread) => ids.has(thread.localId));
      const live = related.filter((thread) => thread.livenessLive);
      // Runtime confirmation (including the first poll after restart) is not
      // recorded activity and must not advance the catalog's activity clock.
      const newest = related.map((thread) => thread.liveness).filter((value) => value && value.source !== "owning_app_server")
        .sort((left, right) => timestampValue(right.observedAt) - timestampValue(left.observedAt))[0];
      const owners = new Map(live.map((thread) => resourceOwnersByThreadId.get(thread.localId)).filter(Boolean)
        .map((owner) => [`${owner.pid}\0${owner.processStartIdentity}`, owner]));
      const resourceOwner = owners.size === 1 ? [...owners.values()][0] : null;
      sessions.set(rootThread.localId, {
        ...aggregateCodexSessionLifecycle(rootThread, related),
        observedAt: newest?.observedAt || null,
        resourceOwner,
      });
    }
    const value = { threads: observedThreads, sessions };
    cache = { input: threads, checkedAt, expiresAt: checkedAt + cacheMs, presenceKey, value };
    return value;
  }

  return Object.freeze({
    observe,
    observeLifecycleSources(observations) {
      let changed = false;
      for (const { file, generation, state, complete, pending } of observations) {
        if (!state || !generation) continue;
        const previous = recordedSources.get(file);
        // The first full acquisition may still be pending after a complete tail
        // was accepted. Leave that tail in charge until the full candidate is ready.
        if (pending && !previous) continue;
        if (pending && previous?.complete && (sameGeneration(generation, previous.generation)
          || compatibleAppend(file, previous.generation, generation))) continue;
        const value = { generation: { identity: generation.identity, size: generation.size,
          mtimeMs: generation.mtimeMs, suffixDigest: generation.suffixDigest,
          suffixBytes: generation.suffixBytes }, state, complete };
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
