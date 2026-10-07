import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { priorSourceSuffixMatches } from "../kernel/source-generation.mjs";
import { createHash } from "node:crypto";
import { parseCodexApprovalPlanRecords } from "./approval-plan.mjs";
import { parseCodexAgentRecords } from "./agent-metadata.mjs";
import { mergeCodexContextSnapshot, parseCodexContextRecords } from "./context.mjs";
import { parseCodexCurrentActivityStateRecords } from "./current-activity.mjs";
import { parseCodexExecutionTaskStateRecords } from "./execution-tasks.mjs";

const MAX_LIVE_USAGE_SNAPSHOTS = 1_000;
const MAX_LIVE_COMPACTIONS = 100;
const CODEX_LIVE_EXECUTION_TASK_CACHE_SCHEMA = 2;
/** Source bytes whose parsed records one adapter may keep between reads. */
export const CODEX_ROLLOUT_RECORD_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

/** Owns bounded live-rollout reads, hydration, and cache reuse for one adapter. */
export function createCodexLiveState({
  scanLimit,
  maximumLiveTailBytes,
  maximumLiveTaskHistoryBytes,
  maximumRetainedRecordBytes,
  yieldControl = defaultYield,
}) {
  const recordByteLimit = Number.isSafeInteger(maximumRetainedRecordBytes) && maximumRetainedRecordBytes >= 0
    ? maximumRetainedRecordBytes
    : CODEX_ROLLOUT_RECORD_CACHE_MAX_BYTES;
  // Parsed rollout records are acquisition scratch, never evidence: this cache only
  // spares an unchanged file a second parse. It is bounded by source bytes and files.
  const rolloutCache = new Map();
  let retainedRecordBytes = 0;
  let liveSessionIds = null;
  const liveAgentAssignmentCache = new Map();
  const liveAgentRuntimeCache = new Map();
  const liveContextUsageCache = new Map();
  const liveExecutionTaskCache = new Map();
  const liveCurrentActivityCache = new Map();
  const liveApprovalModeCache = new Map();
  const livePlanTaskCache = new Map();
  const rolloutStats = {
    reads: 0,
    bytes: 0,
    cacheHits: 0,
    taskHydrationReads: 0,
    taskHydrationBytes: 0,
    approvalHydrationReads: 0,
    approvalHydrationBytes: 0,
    recordReleases: 0,
  };

  const rolloutIdentity = (stat) => {
    const device = Number.isFinite(stat?.dev) ? stat.dev : null;
    const inode = Number.isFinite(stat?.ino) && stat.ino > 0 ? stat.ino : null;
    return inode !== null
      ? `${device ?? "device"}:${inode}`
      : `birth:${Number.isFinite(stat?.birthtimeMs) ? stat.birthtimeMs : "unknown"}`;
  };
  const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

  // Dropping records leaves the per-file normalized state below untouched. Each of
  // those caches keeps its own file bound and its own generation check.
  function dropRolloutRecords(file) {
    const cached = rolloutCache.get(file);
    if (!cached) return false;
    rolloutCache.delete(file);
    retainedRecordBytes -= cached.bytes;
    return true;
  }

  /** Source loss or replacement: the file's records and its derived state both go. */
  function invalidateRolloutFile(file, { clearContext = false } = {}) {
    dropRolloutRecords(file);
    liveAgentAssignmentCache.delete(file);
    liveAgentRuntimeCache.delete(file);
    if (clearContext) liveContextUsageCache.delete(file);
    liveExecutionTaskCache.delete(file);
    liveCurrentActivityCache.delete(file);
    liveApprovalModeCache.delete(file);
    livePlanTaskCache.delete(file);
  }

  function parseHydrationRecords(file, generation) {
    if (!generation || generation.size <= maximumLiveTailBytes) return null;
    const bytes = Math.min(generation.size, maximumLiveTaskHistoryBytes);
    const position = generation.size - bytes;
    let descriptor;
    let buffer;
    try {
      descriptor = fs.openSync(file, "r");
      buffer = Buffer.alloc(bytes);
      if (fs.readSync(descriptor, buffer, 0, bytes, position) !== bytes) return null;
    } catch {
      return null;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    let confirmed;
    try { confirmed = fs.statSync(file); } catch { return null; }
    if (!confirmed.isFile() || confirmed.size !== generation.size || confirmed.mtimeMs !== generation.mtimeMs || rolloutIdentity(confirmed) !== generation.identity) return null;
    let text = buffer.toString("utf8");
    if (position > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      } catch {
        // Hydration independently ignores malformed and partially written records.
      }
    }
    return { records, bytes, buffer };
  }

  function assignmentCollaborations(collaborations = []) {
    const byReference = new Map();
    for (const collaboration of collaborations) {
      if (!collaboration?.label || collaboration.label === "Unnamed subagent") continue;
      const reference = collaboration.childThreadId || collaboration.agentReference;
      if (reference) byReference.set(reference, collaboration);
    }
    return [...byReference.values()].slice(-scanLimit);
  }

  function reusable(cache, file, threadId, generation, { strictSuffix = true, schemaVersion = null } = {}) {
    const cached = cache.get(file);
    if (!cached || cached.threadId !== threadId || !generation || (schemaVersion !== null && cached.schemaVersion !== schemaVersion)) {
      if (cached && (schemaVersion !== null || cache === liveCurrentActivityCache)) cache.delete(file);
      return null;
    }
    const previous = cached.generation;
    const monotonic = previous && previous.identity === generation.identity && generation.size >= previous.size && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || (strictSuffix ? generation.mtimeMs === previous.mtimeMs && generation.suffixDigest === previous.suffixDigest : generation.mtimeMs === previous.mtimeMs));
    if (!monotonic || !priorSourceSuffixMatches(file, previous)) {
      cache.delete(file);
      return null;
    }
    return cached;
  }

  function reusableLiveAgentAssignments(file, threadId, generation) {
    const cached = reusable(liveAgentAssignmentCache, file, threadId, generation);
    if (!cached || generation.size - cached.generation.size > maximumLiveTailBytes) {
      if (cached) liveAgentAssignmentCache.delete(file);
      return null;
    }
    return cached.collaborations;
  }

  function hydrateLiveAgentAssignments(file, generation, fallback) {
    const hydrated = parseHydrationRecords(file, generation);
    return hydrated ? assignmentCollaborations(parseCodexAgentRecords(hydrated.records, fallback).collaborations) : [];
  }

  function rememberLiveAgentAssignments(file, threadId, generation, collaborations) {
    liveAgentAssignmentCache.delete(file);
    liveAgentAssignmentCache.set(file, { threadId, generation, collaborations });
    while (liveAgentAssignmentCache.size > scanLimit) liveAgentAssignmentCache.delete(liveAgentAssignmentCache.keys().next().value);
  }

  function reusableLiveAgentRuntime(file, threadId, generation) {
    const cached = reusable(liveAgentRuntimeCache, file, threadId, generation);
    if (!cached || generation.size - cached.generation.size > maximumLiveTailBytes) {
      if (cached) liveAgentRuntimeCache.delete(file);
      return null;
    }
    return cached.runtime;
  }

  function hydrateLiveAgentRuntime(file, generation, fallback) {
    const hydrated = parseHydrationRecords(file, generation);
    return hydrated ? parseCodexAgentRecords(hydrated.records, fallback).runtime : null;
  }

  function resolveLiveAgentRuntime(file, threadId, generation, fallback, runtime) {
    const retained = runtime.model === "unknown" || runtime.effort === "unspecified"
      ? reusableLiveAgentRuntime(file, threadId, generation) ?? hydrateLiveAgentRuntime(file, generation, fallback)
      : null;
    const resolved = retained ? {
      ...runtime,
      model: runtime.model === "unknown" ? retained.model : runtime.model,
      effort: runtime.effort === "unspecified" ? retained.effort : runtime.effort,
    } : runtime;
    liveAgentRuntimeCache.delete(file);
    liveAgentRuntimeCache.set(file, { threadId, generation, runtime: resolved });
    while (liveAgentRuntimeCache.size > scanLimit) liveAgentRuntimeCache.delete(liveAgentRuntimeCache.keys().next().value);
    return resolved;
  }

  function reusableLiveTaskState(file, threadId, generation) {
    return reusable(liveExecutionTaskCache, file, threadId, generation, {
      strictSuffix: false,
      schemaVersion: CODEX_LIVE_EXECUTION_TASK_CACHE_SCHEMA,
    })?.state || null;
  }

  function reusableLiveCurrentActivity(file, threadId, generation) {
    return reusable(liveCurrentActivityCache, file, threadId, generation);
  }

  function hydrateLiveStateEvidence(file, generation, {
    fallbackTimestamp,
    actorId,
    sourceKey,
    currentActivityOptions = {},
  }) {
    const hydrated = parseHydrationRecords(file, generation);
    if (!hydrated) return null;
    rolloutStats.taskHydrationReads += 1;
    rolloutStats.taskHydrationBytes += hydrated.bytes;
    const context = parseCodexContextRecords(hydrated.records, { actorId, fallbackTimestamp, sourceKey, stableFallbackIdentity: true });
    return {
      taskState: parseCodexExecutionTaskStateRecords(hydrated.records, { fallbackTimestamp }),
      currentActivityState: parseCodexCurrentActivityStateRecords(hydrated.records, currentActivityOptions),
      usageSnapshots: context.usageSnapshots,
      compactions: context.compactions,
    };
  }

  function reusableLivePlanTasks(file, threadId, generation) {
    return reusable(livePlanTaskCache, file, threadId, generation, { strictSuffix: false })?.planTasks || null;
  }

  function reusableLiveApprovalMode(file, threadId, generation) {
    return reusable(liveApprovalModeCache, file, threadId, generation);
  }

  function hydrateLiveApprovalMode(file, generation) {
    const hydrated = parseHydrationRecords(file, generation);
    if (!hydrated || !Number.isInteger(generation.suffixBytes) || generation.suffixBytes < 1 || generation.suffixBytes > hydrated.buffer.length || digest(hydrated.buffer.subarray(hydrated.buffer.length - generation.suffixBytes)) !== generation.suffixDigest) return null;
    rolloutStats.approvalHydrationReads += 1;
    rolloutStats.approvalHydrationBytes += hydrated.bytes;
    return { approvalMode: parseCodexApprovalPlanRecords(hydrated.records).approvalMode };
  }

  function hasLiveContextContinuity(file, generation) {
    const previous = liveContextUsageCache.get(file);
    return Boolean(previous && generation
      && previous.identity === generation.identity
      && generation.size >= previous.size
      && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || (generation.mtimeMs === previous.mtimeMs && generation.suffixDigest === previous.suffixDigest))
      && priorSourceSuffixMatches(file, previous));
  }

  function mergeLiveContextEvidence(file, generation, context) {
    const snapshots = context?.usageSnapshots || [];
    const compactions = context?.compactions || [];
    if (!generation) {
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.size > 0) return liveContextUsageCache.get(file) || { snapshots, compactions };
      } catch { /* deleted rollouts do not retain context */ }
      liveContextUsageCache.delete(file);
      return { snapshots, compactions };
    }
    const previous = liveContextUsageCache.get(file);
    const monotonic = hasLiveContextContinuity(file, generation);
    // A tail-only read is not evidence that a retained source generation was
    // replaced.  Keep the last complete normalized context until acquisition
    // can establish a compatible append or an authoritative replacement.
    if (previous && !monotonic && context?.preservePreviousOnDiscontinuity !== false) {
      return { snapshots: previous.snapshots, compactions: previous.compactions };
    }
    const byId = new Map(monotonic ? previous.snapshots.map((snapshot) => [snapshot.dedupeId, snapshot]) : []);
    for (const snapshot of snapshots) {
      const existing = byId.get(snapshot.dedupeId);
      if (!existing || Date.parse(snapshot.timestamp) >= Date.parse(existing.timestamp)) byId.set(snapshot.dedupeId, mergeCodexContextSnapshot(existing, snapshot));
    }
    const merged = [...byId.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)).slice(-MAX_LIVE_USAGE_SNAPSHOTS);
    const compactionKey = (compaction) => `${compaction.actorId}:${compaction.timestamp}`;
    const compactionStrength = (compaction) => (compaction.trigger === "unknown" ? 0 : compaction.inferred === true ? 1 : 2);
    const compactionsById = new Map(monotonic ? (previous.compactions || []).map((compaction) => [compactionKey(compaction), compaction]) : []);
    for (const compaction of compactions) {
      const key = compactionKey(compaction);
      const existing = compactionsById.get(key);
      if (!existing || compactionStrength(compaction) > compactionStrength(existing) || (compactionStrength(compaction) === compactionStrength(existing) && existing.preTokens === null && compaction.preTokens !== null)) compactionsById.set(key, compaction);
    }
    const mergedCompactions = [...compactionsById.values()].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)).slice(-MAX_LIVE_COMPACTIONS);
    // Bounded on its own, least recently merged first: the lifetime of normalized
    // context never depends on how long the raw records behind it are retained.
    liveContextUsageCache.delete(file);
    liveContextUsageCache.set(file, { identity: generation.identity, size: generation.size, mtimeMs: generation.mtimeMs, suffixBytes: generation.suffixBytes, suffixDigest: generation.suffixDigest, snapshots: merged, compactions: mergedCompactions });
    while (liveContextUsageCache.size > scanLimit) liveContextUsageCache.delete(liveContextUsageCache.keys().next().value);
    return { snapshots: merged, compactions: mergedCompactions };
  }

  async function readRolloutRecords(file, historical, liveMaximumBytes = maximumLiveTailBytes, strict = false) {
    let stat;
    try { stat = fs.statSync(file); } catch {
      invalidateRolloutFile(file, { clearContext: true });
      return { records: [], generation: null };
    }
    if (!stat.isFile() || stat.size <= 0) {
      invalidateRolloutFile(file, { clearContext: true });
      return { records: [], generation: null };
    }
    const bytes = historical ? stat.size : Math.min(stat.size, liveMaximumBytes);
    const identity = rolloutIdentity(stat);
    const key = `${historical ? "history" : "live"}:${identity}:${stat.size}:${stat.mtimeMs}:${bytes}`;
    const cached = rolloutCache.get(file);
    if (cached?.key === key && (!strict || cached.complete === true)) {
      if (priorSourceSuffixMatches(file, cached.generation)) {
        rolloutStats.cacheHits += 1;
        rolloutCache.delete(file);
        rolloutCache.set(file, cached);
        return { records: cached.records, generation: cached.generation };
      }
      invalidateRolloutFile(file, { clearContext: true });
    }
    const records = [];
    const decoder = new StringDecoder("utf8");
    let remainder = "";
    let malformed = false;
    let offset = 0;
    let suffix = Buffer.alloc(0);
    let discardFirst = !historical && stat.size > bytes;
    let descriptor;
    try {
      descriptor = fs.openSync(file, "r");
      while (offset < bytes) {
        const length = Math.min(64 * 1024, bytes - offset);
        const buffer = Buffer.alloc(length);
        const position = (historical ? 0 : stat.size - bytes) + offset;
        if (fs.readSync(descriptor, buffer, 0, length, position) !== length) throw new Error("Incomplete Codex rollout read");
        offset += length;
        suffix = Buffer.concat([suffix, buffer]).subarray(Math.max(0, suffix.length + buffer.length - 256));
        const lines = (remainder + decoder.write(buffer)).split(/\r?\n/);
        remainder = lines.pop() || "";
        for (const line of lines) {
          if (discardFirst) { discardFirst = false; continue; }
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
          } catch { malformed = true; }
        }
        await yieldControl();
      }
      remainder += decoder.end();
      if (!discardFirst && remainder.trim()) {
        try {
          const record = JSON.parse(remainder);
          if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
        } catch { malformed = true; }
      }
    } catch {
      invalidateRolloutFile(file, { clearContext: true });
      return { records: [], generation: null };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    let confirmed;
    try { confirmed = fs.statSync(file); } catch {
      invalidateRolloutFile(file, { clearContext: true });
      return { records: [], generation: null };
    }
    if (!confirmed.isFile() || confirmed.size !== stat.size || confirmed.mtimeMs !== stat.mtimeMs || rolloutIdentity(confirmed) !== identity) {
      invalidateRolloutFile(file, { clearContext: true });
      return { records: [], generation: null };
    }
    if (strict && malformed) return { records: [], generation: null };
    rolloutStats.reads += 1;
    rolloutStats.bytes += bytes;
    const suffixBytes = suffix.length;
    const generation = { identity, size: stat.size, mtimeMs: stat.mtimeMs, suffixBytes, suffixDigest: digest(suffix) };
    dropRolloutRecords(file);
    // A read larger than the whole bound is handed to its caller and never retained.
    if (bytes <= recordByteLimit) {
      rolloutCache.set(file, { key, records, generation, complete: !malformed, bytes });
      retainedRecordBytes += bytes;
      while (retainedRecordBytes > recordByteLimit || rolloutCache.size > scanLimit) {
        dropRolloutRecords(rolloutCache.keys().next().value);
      }
    }
    return { records, generation };
  }

  /** The sessions the latest catalog pass lists as live; only their families keep records. */
  function retainRecordsForSessions(localSessionIds) {
    liveSessionIds = new Set(localSessionIds);
  }

  /**
   * Call once a session's normalized evidence is built. Nothing reads a settled session's
   * unchanged files again on a routine path, so its family holds no parsed records. A
   * live family keeps them under the byte bound: a complete-history replay rereads the
   * appended file and reuses the unchanged ones. The latest catalog pass decides which
   * sessions are live; before the first pass, only the reader's own view is available.
   */
  function releaseSettledRecords(localSessionId, historical, files) {
    const settled = liveSessionIds ? !liveSessionIds.has(localSessionId) : historical;
    if (!settled) return;
    for (const file of files) if (file && dropRolloutRecords(file)) rolloutStats.recordReleases += 1;
  }

  function pruneKnownFiles(knownRolloutFiles) {
    for (const cache of [liveExecutionTaskCache, liveCurrentActivityCache, liveAgentAssignmentCache, liveAgentRuntimeCache, liveApprovalModeCache]) {
      for (const file of cache.keys()) if (!knownRolloutFiles.has(file)) cache.delete(file);
    }
  }

  function stats(reset = false) {
    const value = {
      ...rolloutStats,
      cacheEntries: rolloutCache.size,
      retainedRecordBytes,
      liveContextUsageEntries: liveContextUsageCache.size,
      liveExecutionTaskEntries: liveExecutionTaskCache.size,
      liveAgentRuntimeEntries: liveAgentRuntimeCache.size,
      liveCurrentActivityEntries: liveCurrentActivityCache.size,
      liveApprovalModeEntries: liveApprovalModeCache.size,
      livePlanTaskEntries: livePlanTaskCache.size,
    };
    if (reset) Object.assign(rolloutStats, { reads: 0, bytes: 0, cacheHits: 0, taskHydrationReads: 0, taskHydrationBytes: 0, approvalHydrationReads: 0, approvalHydrationBytes: 0, recordReleases: 0 });
    return value;
  }

  return {
    assignmentCollaborations,
    hydrateLiveAgentAssignments,
    hydrateLiveApprovalMode,
    hydrateLiveStateEvidence,
    hasLiveContextContinuity,
    liveAgentAssignmentCache,
    liveApprovalModeCache,
    liveContextUsageCache,
    liveCurrentActivityCache,
    liveExecutionTaskCache,
    livePlanTaskCache,
    mergeLiveContextEvidence,
    pruneKnownFiles,
    readRolloutRecords,
    releaseSettledRecords,
    rememberLiveAgentAssignments,
    resolveLiveAgentRuntime,
    retainRecordsForSessions,
    reusableLiveAgentAssignments,
    reusableLiveApprovalMode,
    reusableLiveCurrentActivity,
    reusableLivePlanTasks,
    reusableLiveTaskState,
    stats,
  };
}
