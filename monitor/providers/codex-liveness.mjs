import fs from "node:fs";
import { priorSourceSuffixMatches } from "./source-generation.mjs";
import path from "node:path";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { isSafeCodexSessionId } from "./codex-session-metadata.mjs";
import { appServerLiveness } from "./codex-owning-runtime.mjs";
import { readCodexLivenessTail, observedCodexRolloutLifecycle } from "./codex-rollout-lifecycle.mjs";
import { isActiveCodexWriterLock } from "./codex-cli-observation.mjs";
import { readCodexWriterLock } from "./codex-writer-presence.mjs";
import { createCodexSourceRouter, codexInferenceEligible } from "./codex-source-routing.mjs";
import { incrementalSourceDescriptor } from "./incremental-provider-observer.mjs";
import { codexRecordedLiveness, reduceCodexRecordedLifecycle } from "./codex-recorded-lifecycle.mjs";
import { aggregateCodexSessionLifecycle } from "./codex-session-lifecycle.mjs";
import {
  CODEX_ROLLOUT_LIVE_WINDOW_MS,
  CODEX_LIVENESS_CACHE_MS,
  CODEX_LIVENESS_MAX_TAIL_BYTES,
  CODEX_LIVENESS_MAX_TAIL_RECORDS,
  CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES,
  CODEX_LIVENESS_MAX_OWNER_TAIL_RECORDS,
  CODEX_LIVENESS_MAX_ROLLOUT_OBSERVATIONS,
  CODEX_LIVENESS_MAX_COLD_ROLLOUTS,
} from "./codex-lifecycle-constants.mjs";
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
  const platform = options.platform || process.platform;
  const readWriterLock = options.readWriterLock || ((file) => readCodexWriterLock(file));
  const now = options.now || (() => Date.now());
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : CODEX_LIVENESS_CACHE_MS;
  const maximumTailBytes = Number.isInteger(options.maximumTailBytes)
    ? Math.max(1, Math.min(CODEX_LIVENESS_MAX_TAIL_BYTES, options.maximumTailBytes))
    : CODEX_LIVENESS_MAX_TAIL_BYTES;
  const maximumOwnerTailBytes = Number.isInteger(options.maximumOwnerTailBytes)
    ? Math.max(maximumTailBytes, Math.min(CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES, options.maximumOwnerTailBytes))
    : CODEX_LIVENESS_MAX_OWNER_TAIL_BYTES;
  const maximumOwnerTailRecords = Number.isInteger(options.maximumOwnerTailRecords)
    ? Math.max(CODEX_LIVENESS_MAX_TAIL_RECORDS,
      Math.min(CODEX_LIVENESS_MAX_OWNER_TAIL_RECORDS, options.maximumOwnerTailRecords))
    : CODEX_LIVENESS_MAX_OWNER_TAIL_RECORDS;
  const tailCache = new Map();
  const recordedSources = new Map();
  const recordedTails = new WeakMap();
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

  // One observation reads each needed writer lock at most once. Codex takes a
  // thread's lock before it creates the rollout and holds it while the thread is
  // loaded, so where Windows lock evidence exists a missing or uncontended lock
  // proves no process can resolve that thread's recorded work.
  function writerLockStates() {
    const states = new Map();
    let rootAvailable = null;
    return (localId) => {
      if (states.has(localId)) return states.get(localId);
      let state = "unavailable";
      try {
        if (options.writerLockState) state = options.writerLockState(localId);
        else if (platform === "win32" && writerLocksRoot && isSafeCodexSessionId(localId)) {
          rootAvailable ??= fs.statSync(writerLocksRoot, { throwIfNoEntry: false })?.isDirectory() === true;
          const file = path.join(writerLocksRoot, `${localId}.lock`);
          const lock = rootAvailable ? readWriterLock(file)?.state : null;
          // Release needs the cold-discovery contention probe to agree, so a
          // writer that takes the lock between the two reads still counts as held.
          state = lock === "held" ? "held"
            : lock === "missing" || lock === "unlocked" ? (writerLockIsActive(file) === true ? "held" : "released")
              : "unavailable";
        }
      } catch { state = "unavailable"; }
      states.set(localId, state);
      return state;
    };
  }

  // Unresolved recorded work is live only while a writer could still resolve
  // it. When neither this thread's lock nor its root's is held, it is unknown
  // and not live; nothing about completion, idle, or success is inferred.
  function writerReleased(thread, lockState) {
    const ids = [...new Set([thread.localId, thread.sessionId, thread.parentThreadId].filter(isSafeCodexSessionId))];
    return ids.length > 0 && ids.every((id) => lockState(id) === "released");
  }

  function releasedLiveness(liveness) {
    const released = { ...liveness, live: false, status: "unknown", needsInput: false,
      evidence: "unavailable", freshness: "stale", reason: "writer_released" };
    delete released.needsInputKind;
    return released;
  }

  function hasCurrentWriterLock(thread) {
    const localId = isSafeCodexSessionId(thread?.localId) ? thread.localId : null;
    if (!writerLocksRoot || !localId) return false;
    return writerLockIsActive(path.join(writerLocksRoot, `${localId}.lock`)) === true;
  }

  function rolloutEvidence(file, nowMs, implementation, unavailableReason, ownerConfirmed = false) {
    if (!file) return null;
    const current = incrementalSourceDescriptor(file);
    if (!current) return null;
    // A confirmed native owner narrows this read to a genuine live candidate,
    // so its header may look farther back for an explicit turn boundary without
    // broadening the ordinary recent/history catalog scan.
    const tailBytes = ownerConfirmed ? maximumOwnerTailBytes : maximumTailBytes;
    const tailRecords = ownerConfirmed ? maximumOwnerTailRecords : CODEX_LIVENESS_MAX_TAIL_RECORDS;
    const recorded = recordedSources.get(file);
    if (recorded) {
      // Retain full-observer evidence through acquisition lag. A complete,
      // continuous terminal append can close it without waiting for hydration.
      if (sameGeneration(current, recorded.generation)
        || compatibleAppend(file, recorded.generation, current)) {
        const previous = recordedTails.get(recorded);
        const accepted = previous?.accepted && (sameGeneration(current, previous.accepted.generation)
          || compatibleAppend(file, previous.accepted.generation, current)) ? previous.accepted : recorded;
        let successor = accepted;
        if (recorded.complete && !sameGeneration(current, accepted.generation)
          && !sameGeneration(current, previous?.checkedGeneration)
          && compatibleAppend(file, accepted.generation, current)) {
          const read = readCodexLivenessTail(file, tailBytes, tailRecords);
          const confirmed = incrementalSourceDescriptor(file);
          if (read.complete && read.malformedRecords === 0
            && read.startOffset <= accepted.generation.size && sameGeneration(current, confirmed)) {
            const state = read.records.reduce(reduceCodexRecordedLifecycle, accepted.state);
            const terminal = codexRecordedLiveness(state, { now: nowMs });
            if (state.turn?.kind === "end" && terminal?.evidence === "observed"
              && timestampValue(terminal.observedAt) > Math.max(timestampValue(accepted.state.latestActivityAt),
                timestampValue(accepted.state.turn?.observedAt))) {
              successor = { generation: current, state, complete: true };
            }
          }
          recordedTails.set(recorded, { checkedGeneration: current, accepted: successor });
          stats.rolloutFiles += 1;
          stats.rolloutBytes += Math.min(current.size, tailBytes);
        }
        const retained = codexRecordedLiveness(successor.state, { now: nowMs, complete: successor.complete });
        // A complete retained source can begin inside a long-running turn. A
        // confirmed owner plus fresh structured activity may refine that one
        // unresolved case through the bounded tail below; ownership alone still
        // cannot establish execution.
        if (retained && (!ownerConfirmed || retained.status !== "unknown")) return retained;
      }
    }
    const key = `${current.identity}:${current.size}:${current.mtimeMs}:${current.suffixDigest}:${tailBytes}:${tailRecords}`;
    let cached = tailCache.get(file);
    if (!cached || cached.key !== key) {
      const read = readCodexLivenessTail(file, tailBytes, tailRecords);
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
      stats.rolloutBytes += Math.min(current.size, tailBytes);
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
    if (inferred && (ownerConfirmed
      || (!unavailableReason && codexInferenceEligible(options.deterministicAvailability)))) {
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
    const lockState = writerLockStates();
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
        ? rolloutEvidence(thread.rolloutFile, checkedAt, implementation, thread.runtimeAvailability || null, Boolean(owner))
        : null;
      // A current owning-runtime snapshot is authoritative for its loaded task.
      const released = !app && !owner && rollout?.live === true && writerReleased(thread, lockState);
      const liveness = app || (released ? releasedLiveness(rollout) : rollout);
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
