import fs from "node:fs";
import { createHash } from "node:crypto";
import { parseCodexApprovalPlanRecords } from "./codex-approval-plan.mjs";
import { parseCodexAgentRecords } from "./codex-agent-metadata.mjs";
import { parseCodexContextRecords } from "./codex-context.mjs";
import { parseCodexCurrentActivityStateRecords } from "./codex-current-activity.mjs";
import { parseCodexExecutionTaskStateRecords } from "./codex-execution-tasks.mjs";

const MAX_LIVE_USAGE_SNAPSHOTS = 1_000;
const MAX_LIVE_COMPACTIONS = 100;
const CODEX_LIVE_EXECUTION_TASK_CACHE_SCHEMA = 2;

/** Owns bounded live-rollout reads, hydration, and cache reuse for one adapter. */
export function createCodexLiveState({
  scanLimit,
  maximumLiveTailBytes,
  maximumLiveTaskHistoryBytes,
}) {
  const rolloutCache = new Map();
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
  };

  const rolloutIdentity = (stat) => {
    const device = Number.isFinite(stat?.dev) ? stat.dev : null;
    const inode = Number.isFinite(stat?.ino) && stat.ino > 0 ? stat.ino : null;
    return inode !== null
      ? `${device ?? "device"}:${inode}`
      : `birth:${Number.isFinite(stat?.birthtimeMs) ? stat.birthtimeMs : "unknown"}`;
  };
  const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");

  function priorSuffixStillMatches(file, generation) {
    if (!generation?.suffixDigest || !Number.isInteger(generation.suffixBytes) || generation.suffixBytes < 1) return false;
    let descriptor;
    try {
      descriptor = fs.openSync(file, "r");
      const buffer = Buffer.alloc(generation.suffixBytes);
      const read = fs.readSync(descriptor, buffer, 0, generation.suffixBytes, generation.size - generation.suffixBytes);
      return read === generation.suffixBytes && digest(buffer) === generation.suffixDigest;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function invalidateRolloutFile(file, { clearContext = false } = {}) {
    rolloutCache.delete(file);
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
    if (!monotonic || !priorSuffixStillMatches(file, previous)) {
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
    const monotonic = previous && previous.identity === generation.identity && generation.size >= previous.size && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || (generation.mtimeMs === previous.mtimeMs && generation.suffixDigest === previous.suffixDigest))
      && priorSuffixStillMatches(file, previous);
    const byId = new Map(monotonic ? previous.snapshots.map((snapshot) => [snapshot.dedupeId, snapshot]) : []);
    for (const snapshot of snapshots) {
      const existing = byId.get(snapshot.dedupeId);
      if (!existing || Date.parse(snapshot.timestamp) >= Date.parse(existing.timestamp)) byId.set(snapshot.dedupeId, snapshot);
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
    liveContextUsageCache.set(file, { identity: generation.identity, size: generation.size, mtimeMs: generation.mtimeMs, suffixBytes: generation.suffixBytes, suffixDigest: generation.suffixDigest, snapshots: merged, compactions: mergedCompactions });
    return { snapshots: merged, compactions: mergedCompactions };
  }

  function readRolloutRecords(file, historical, liveMaximumBytes = maximumLiveTailBytes) {
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
    if (cached?.key === key) {
      if (priorSuffixStillMatches(file, cached.generation)) {
        rolloutStats.cacheHits += 1;
        return { records: cached.records, generation: cached.generation };
      }
      invalidateRolloutFile(file, { clearContext: true });
    }
    let text = "";
    let buffer;
    let descriptor;
    try {
      descriptor = fs.openSync(file, "r");
      buffer = Buffer.alloc(bytes);
      if (fs.readSync(descriptor, buffer, 0, bytes, historical ? 0 : Math.max(0, stat.size - bytes)) !== bytes) throw new Error("Incomplete Codex rollout read");
      text = buffer.toString("utf8");
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
    if (!historical && stat.size > bytes) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    const records = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      } catch { /* malformed lines do not invalidate other records */ }
    }
    rolloutStats.reads += 1;
    rolloutStats.bytes += bytes;
    const suffixBytes = Math.min(256, buffer.length);
    const generation = { identity, size: stat.size, mtimeMs: stat.mtimeMs, suffixBytes, suffixDigest: digest(buffer.subarray(buffer.length - suffixBytes)) };
    rolloutCache.delete(file);
    rolloutCache.set(file, { key, records, generation });
    while (rolloutCache.size > scanLimit) {
      const evictedFile = rolloutCache.keys().next().value;
      invalidateRolloutFile(evictedFile, { clearContext: true });
    }
    return { records, generation };
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
      liveExecutionTaskEntries: liveExecutionTaskCache.size,
      liveAgentRuntimeEntries: liveAgentRuntimeCache.size,
      liveCurrentActivityEntries: liveCurrentActivityCache.size,
      liveApprovalModeEntries: liveApprovalModeCache.size,
      livePlanTaskEntries: livePlanTaskCache.size,
    };
    if (reset) Object.assign(rolloutStats, { reads: 0, bytes: 0, cacheHits: 0, taskHydrationReads: 0, taskHydrationBytes: 0, approvalHydrationReads: 0, approvalHydrationBytes: 0 });
    return value;
  }

  return {
    assignmentCollaborations,
    hydrateLiveAgentAssignments,
    hydrateLiveApprovalMode,
    hydrateLiveStateEvidence,
    liveAgentAssignmentCache,
    liveApprovalModeCache,
    liveContextUsageCache,
    liveCurrentActivityCache,
    liveExecutionTaskCache,
    livePlanTaskCache,
    mergeLiveContextEvidence,
    pruneKnownFiles,
    readRolloutRecords,
    resolveLiveAgentRuntime,
    reusableLiveAgentAssignments,
    reusableLiveApprovalMode,
    reusableLiveCurrentActivity,
    reusableLivePlanTasks,
    reusableLiveTaskState,
    stats,
  };
}
