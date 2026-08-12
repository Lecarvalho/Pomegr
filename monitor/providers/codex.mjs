import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { defineProvider } from "./provider-contract.mjs";
import {
  mergeCodexToolCalls,
  parseCodexCanonicalTurns,
  parseCodexActivityRecords,
} from "./codex-activity-events.mjs";
import {
  mergeCodexExecutionTasks,
  parseCodexCanonicalExecutionTasks,
  parseCodexExecutionTaskStateRecords,
} from "./codex-execution-tasks.mjs";
import { latestCodexPlanSnapshot, parseCodexApprovalPlanRecords } from "./codex-approval-plan.mjs";
import { parseCodexContextRecords } from "./codex-context.mjs";
import { parseCodexCurrentActivityRecords } from "./codex-current-activity.mjs";
import { buildCodexAgentTree, parseCodexAgentRecords } from "./codex-agent-metadata.mjs";
import {
  mergeCodexPullRequestCreations,
  parseCodexCanonicalPullRequests,
  parseCodexPullRequestRecords,
} from "./codex-pull-requests.mjs";
import {
  mergeCodexSignals,
  parseCodexSignalRecords,
} from "./codex-session-signals.mjs";
import { parseCodexCanonicalSkillUsage, parseCodexSkillUsageRecords } from "./codex-skill-usage.mjs";
import { createCodexUsageLimitsCoordinator } from "./codex-usage-limits.mjs";
import { createCodexLivenessCoordinator, resolveCodexLivenessRoot } from "./codex-liveness.mjs";
import {
  DEFAULT_CODEX_CATALOG_LIMIT,
  DEFAULT_CODEX_SCAN_LIMIT,
  isSafeCodexSessionId,
  isTopLevelCodexSession,
  listCodexRolloutMetadata,
  normalizeCodexThreadMetadata,
  readCodexRolloutHeader,
  readCodexSessionIndex,
} from "./codex-session-metadata.mjs";

const TOP_LEVEL_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
export const CODEX_LIVE_STATE_MAX_TAIL_BYTES = 512 * 1024;
const ALL_SOURCE_KINDS = [
  ...TOP_LEVEL_SOURCE_KINDS,
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
];

export function resolveCodexHome(options = {}) {
  const environment = options.env ?? process.env;
  const configured = options.codexHome ?? environment.CODEX_HOME;
  return path.resolve(configured || path.join(options.homeDir || os.homedir(), ".codex"));
}

function timestampValue(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareMetadata(left, right) {
  const updated = timestampValue(right.updatedAt) - timestampValue(left.updatedAt);
  if (updated) return updated;
  return left.localId.localeCompare(right.localId);
}

function boundedInteger(value, fallback, maximum) {
  return Number.isInteger(value) ? Math.max(1, Math.min(maximum, value)) : fallback;
}

function mergeMetadata(items) {
  const byId = new Map();
  for (const item of [...items].sort(compareMetadata)) {
    const previous = byId.get(item.localId);
    if (!previous) {
      byId.set(item.localId, item);
      continue;
    }
    const preferred = timestampValue(item.updatedAt) > timestampValue(previous.updatedAt) ? item : previous;
    const alternate = preferred === item ? previous : item;
    byId.set(item.localId, {
      ...preferred,
      title: preferred.title !== "Untitled session" ? preferred.title : alternate.title,
      cwd: preferred.cwd || alternate.cwd,
      project: preferred.cwd ? preferred.project : alternate.project,
      createdAt: preferred.createdAt || alternate.createdAt,
      recordedGitBranch: preferred.recordedGitBranch || alternate.recordedGitBranch,
      sessionId: preferred.sessionId || alternate.sessionId,
      parentThreadId: preferred.parentThreadId || alternate.parentThreadId,
      forkedFromId: preferred.forkedFromId || alternate.forkedFromId,
      agentNickname: preferred.agentNickname || alternate.agentNickname,
      agentRole: preferred.agentRole || alternate.agentRole,
      runtimeStatus: preferred.runtimeStatus || alternate.runtimeStatus,
      liveStatus: preferred.liveStatus || alternate.liveStatus,
      liveness: preferred.liveness || alternate.liveness,
      archived: item.archived && previous.archived,
      rolloutFile: item.rolloutFile || previous.rolloutFile,
    });
  }
  return [...byId.values()].sort(compareMetadata);
}

function expandSelectedMetadata(metadataById, selectedIds) {
  let changed = true;
  while (changed) {
    changed = false;
    const relatedSessionIds = new Set(
      [...selectedIds].flatMap((id) => {
        const sessionId = metadataById.get(id)?.sessionId;
        return sessionId ? [id, sessionId] : [id];
      }),
    );
    for (const metadata of metadataById.values()) {
      if (selectedIds.has(metadata.localId)) continue;
      const hasSelectedParent = [metadata.parentThreadId, metadata.forkedFromId]
        .some((id) => id && selectedIds.has(id));
      const sharesSelectedSession = metadata.sessionId
        && metadata.sessionId !== metadata.localId
        && relatedSessionIds.has(metadata.sessionId);
      if (!hasSelectedParent && !sharesSelectedSession) continue;
      selectedIds.add(metadata.localId);
      changed = true;
    }
  }
}

function mergeFreshSessionTreeMetadata(discovered, sessionTree) {
  const merged = mergeMetadata([...discovered, ...sessionTree.metadata]);
  const freshById = new Map(
    sessionTree.metadata
      .filter((item) => sessionTree.freshIds.has(item.localId))
      .map((item) => [item.localId, item]),
  );
  return merged.map((item) => {
    const fresh = freshById.get(item.localId);
    return fresh ? {
      ...item,
      updatedAt: fresh.updatedAt || item.updatedAt,
      sessionId: fresh.sessionId,
      parentThreadId: fresh.parentThreadId,
      forkedFromId: fresh.forkedFromId,
      sourceKind: fresh.sourceKind,
      agentNickname: fresh.agentNickname,
      agentRole: fresh.agentRole,
      runtimeStatus: fresh.runtimeStatus,
    } : item;
  });
}

function appServerResponseData(response) {
  const value = response?.result ?? response;
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null;
}

function appServerResponseThread(response) {
  const value = response?.result ?? response;
  return value?.thread && typeof value.thread === "object" ? value.thread : null;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return Boolean(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function trustedAppServerRolloutFile(thread, roots) {
  if (!isSafeCodexSessionId(thread?.id) || typeof thread?.path !== "string" || !thread.path.trim()) return null;
  let candidate;
  try {
    candidate = fs.realpathSync(path.resolve(thread.path));
    if (!fs.statSync(candidate).isFile()) return null;
  } catch {
    return null;
  }
  const allowed = roots.some((root) => {
    try { return pathIsWithin(fs.realpathSync(root), candidate); } catch { return false; }
  });
  if (!allowed) return null;
  const header = readCodexRolloutHeader(candidate);
  return header?.localId === thread.id ? candidate : null;
}

function mergeSkillUsage(groups) {
  const usage = new Map();
  for (const item of groups.flat()) {
    if (!item) continue;
    const previous = usage.get(item.name);
    usage.set(item.name, {
      name: item.name,
      calls: (previous?.calls || 0) + item.calls,
      lastUsed: !previous?.lastUsed || Date.parse(item.lastUsed || "") >= Date.parse(previous.lastUsed)
        ? item.lastUsed
        : previous.lastUsed,
    });
  }
  return [...usage.values()].sort((left, right) => (
    Date.parse(right.lastUsed || "") - Date.parse(left.lastUsed || "") || left.name.localeCompare(right.name)
  ));
}

/** @returns {import("./provider-contract").ProviderAdapter} */
export function createCodexProvider(options = {}) {
  const codexHome = resolveCodexHome(options);
  const sessionsRoot = options.sessionsRoot || path.join(codexHome, "sessions");
  const archivedRoot = options.archivedRoot || path.join(codexHome, "archived_sessions");
  const indexFile = options.indexFile || path.join(codexHome, "session_index.jsonl");
  const livenessRoot = resolveCodexLivenessRoot({
    root: options.livenessRoot,
    env: options.env,
    homeDir: options.homeDir,
  });
  const appServer = options.appServer || null;
  const now = options.now || (() => Date.now());
  const includeArchived = options.includeArchived ?? true;
  const catalogLimit = boundedInteger(options.catalogLimit, DEFAULT_CODEX_CATALOG_LIMIT, 200);
  const scanLimit = Math.max(catalogLimit, boundedInteger(options.scanLimit, DEFAULT_CODEX_SCAN_LIMIT, DEFAULT_CODEX_SCAN_LIMIT));
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : 1500;
  const maximumLiveTailBytes = Number.isInteger(options.maximumStateTailBytes)
    ? Math.max(1, Math.min(4 * 1024 * 1024, options.maximumStateTailBytes))
    : CODEX_LIVE_STATE_MAX_TAIL_BYTES;
  const liveness = createCodexLivenessCoordinator({
    root: livenessRoot,
    now,
    cacheMs,
    maximumBridgeFiles: options.maximumBridgeFiles,
    maximumTailBytes: options.maximumTailBytes,
  });
  const usageLimits = createCodexUsageLimitsCoordinator({
    now,
    request: async () => {
      if (!appServer) throw new Error("Codex app-server is unavailable");
      const response = await appServerCall("account/rateLimits/read");
      if (response === null || response === undefined) throw new Error("Codex rate limits are unavailable");
      return response;
    },
  }).get;
  let catalogCache = null;
  let catalogPending = null;
  const rolloutCache = new Map();
  const liveExecutionTaskCache = new Map();
  const livePlanTaskCache = new Map();
  const rolloutStats = { reads: 0, bytes: 0, cacheHits: 0 };

  const invalidateRolloutFile = (file) => {
    rolloutCache.delete(file);
    liveExecutionTaskCache.delete(file);
    livePlanTaskCache.delete(file);
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
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        generation.suffixBytes,
        generation.size - generation.suffixBytes,
      );
      return read === generation.suffixBytes && digest(buffer) === generation.suffixDigest;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  function reusableLiveTaskState(file, threadId, generation) {
    const cached = liveExecutionTaskCache.get(file);
    if (!cached || cached.threadId !== threadId || !generation) return null;
    const previous = cached.generation;
    const monotonic = previous
      && previous.identity === generation.identity
      && generation.size >= previous.size
      && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || generation.mtimeMs === previous.mtimeMs);
    if (!monotonic || !priorSuffixStillMatches(file, previous)) {
      liveExecutionTaskCache.delete(file);
      return null;
    }
    return cached.state;
  }

  function reusableLivePlanTasks(file, threadId, generation) {
    const cached = livePlanTaskCache.get(file);
    if (!cached || cached.threadId !== threadId || !generation) return null;
    const previous = cached.generation;
    const monotonic = previous
      && previous.identity === generation.identity
      && generation.size >= previous.size
      && generation.mtimeMs >= previous.mtimeMs
      && (generation.size > previous.size || generation.mtimeMs === previous.mtimeMs);
    if (!monotonic || !priorSuffixStillMatches(file, previous)) {
      livePlanTaskCache.delete(file);
      return null;
    }
    return cached.planTasks;
  }

  function normalizeAppServerMetadata(thread, metadataOptions = {}) {
    const metadata = normalizeCodexThreadMetadata(thread, metadataOptions);
    if (!metadata) return null;
    const rolloutFile = trustedAppServerRolloutFile(thread, [sessionsRoot, archivedRoot]);
    return rolloutFile ? { ...metadata, rolloutFile } : metadata;
  }

  function readRolloutRecords(file, historical) {
    let stat;
    try { stat = fs.statSync(file); } catch {
      invalidateRolloutFile(file);
      return { records: [], generation: null };
    }
    if (!stat.isFile() || stat.size <= 0) {
      invalidateRolloutFile(file);
      return { records: [], generation: null };
    }
    const bytes = historical ? stat.size : Math.min(stat.size, maximumLiveTailBytes);
    const identity = rolloutIdentity(stat);
    const key = `${historical ? "history" : "live"}:${identity}:${stat.size}:${stat.mtimeMs}:${bytes}`;
    const cached = rolloutCache.get(file);
    if (cached?.key === key) {
      if (priorSuffixStillMatches(file, cached.generation)) {
        rolloutStats.cacheHits += 1;
        return { records: cached.records, generation: cached.generation };
      }
      invalidateRolloutFile(file);
    }
    let text = "";
    let buffer;
    let descriptor;
    try {
      descriptor = fs.openSync(file, "r");
      buffer = Buffer.alloc(bytes);
      const read = fs.readSync(descriptor, buffer, 0, bytes, historical ? 0 : Math.max(0, stat.size - bytes));
      if (read !== bytes) throw new Error("Incomplete Codex rollout read");
      text = buffer.toString("utf8");
    } catch {
      invalidateRolloutFile(file);
      return { records: [], generation: null };
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    let confirmed;
    try { confirmed = fs.statSync(file); } catch {
      invalidateRolloutFile(file);
      return { records: [], generation: null };
    }
    if (
      !confirmed.isFile()
      || confirmed.size !== stat.size
      || confirmed.mtimeMs !== stat.mtimeMs
      || rolloutIdentity(confirmed) !== identity
    ) {
      invalidateRolloutFile(file);
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
      } catch {
        // A malformed or partially written line does not invalidate other records.
      }
    }
    rolloutStats.reads += 1;
    rolloutStats.bytes += bytes;
    const suffixBytes = Math.min(256, buffer.length);
    const generation = {
      identity,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      suffixBytes,
      suffixDigest: digest(buffer.subarray(buffer.length - suffixBytes)),
    };
    rolloutCache.delete(file);
    rolloutCache.set(file, { key, records, generation });
    while (rolloutCache.size > scanLimit) {
      const evictedFile = rolloutCache.keys().next().value;
      rolloutCache.delete(evictedFile);
      liveExecutionTaskCache.delete(evictedFile);
      livePlanTaskCache.delete(evictedFile);
    }
    return { records, generation };
  }

  async function appServerCall(method, params) {
    if (!appServer) return null;
    if (typeof appServer.request === "function") return appServer.request(method, params);
    if (method === "thread/list" && typeof appServer.listThreads === "function") return appServer.listThreads(params);
    if (method === "thread/read" && typeof appServer.readThread === "function") return appServer.readThread(params);
    if (method === "account/rateLimits/read" && typeof appServer.readRateLimits === "function") return appServer.readRateLimits();
    return null;
  }

  async function readAppServerCatalog() {
    if (!appServer) return null;
    const indexNames = readCodexSessionIndex(indexFile);
    const filters = includeArchived ? [false, true] : [false];
    try {
      const pages = await Promise.all(filters.map(async (archived) => {
        const response = await appServerCall("thread/list", {
          limit: scanLimit,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: ALL_SOURCE_KINDS,
          archived,
        });
        const data = appServerResponseData(response);
        if (data === null) throw new Error("Invalid Codex app-server thread/list response");
        return data.flatMap((thread) => {
          const indexed = indexNames.get(thread?.id);
          const metadata = normalizeCodexThreadMetadata(thread, { archived, indexName: indexed?.title });
          return metadata ? [metadata] : [];
        });
      }));
      return mergeMetadata(pages.flat()).slice(0, scanLimit);
    } catch {
      return null;
    }
  }

  function readFallbackMetadata() {
    const indexNames = readCodexSessionIndex(indexFile);
    const roots = [{ root: sessionsRoot, archived: false }];
    if (includeArchived) roots.push({ root: archivedRoot, archived: true });
    return roots.flatMap(({ root, archived }) => listCodexRolloutMetadata(root, {
      archived,
      maximumFiles: scanLimit,
    })).map((item) => {
      const indexed = indexNames.get(item.localId);
      return {
        ...item,
        title: indexed?.title || item.title,
        updatedAt: [item.updatedAt, indexed?.updatedAt].filter(Boolean).sort().at(-1) || item.updatedAt,
      };
    });
  }

  async function discoveredMetadata() {
    const checkedAt = now();
    if (catalogCache && checkedAt < catalogCache.expiresAt) return catalogCache.value;
    if (catalogPending) return catalogPending;
    catalogPending = (async () => {
      const appServerMetadata = await readAppServerCatalog();
      const fallbackMetadata = readFallbackMetadata();
      const combined = appServerMetadata?.length
        ? mergeMetadata([...fallbackMetadata, ...appServerMetadata])
        : fallbackMetadata;
      const value = combined;
      const knownRolloutFiles = new Set(value.map((item) => item.rolloutFile).filter(Boolean));
      for (const file of liveExecutionTaskCache.keys()) {
        if (!knownRolloutFiles.has(file)) liveExecutionTaskCache.delete(file);
      }
      catalogCache = { expiresAt: now() + cacheMs, value };
      return value;
    })();
    try {
      return await catalogPending;
    } finally {
      catalogPending = null;
    }
  }

  async function listSessions() {
    const discovered = await discoveredMetadata();
    const { threads, sessions } = liveness.observe(discovered);
    return threads.filter(isTopLevelCodexSession).map((thread) => {
      const state = sessions.get(thread.localId) || { isLive: false, needsInput: false, observedAt: null };
      return {
        localId: thread.localId,
        title: thread.title,
        project: thread.project,
        updatedAt: [thread.updatedAt, thread.createdAt, state.observedAt].filter(Boolean).sort().at(-1) || new Date(0).toISOString(),
        isLive: state.isLive,
        needsInput: state.needsInput,
      };
    }).sort(compareMetadata).slice(0, catalogLimit);
  }

  async function readAppServerSession(localSessionId) {
    if (!appServer) return null;
    try {
      const response = await appServerCall("thread/read", { threadId: localSessionId, includeTurns: false });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== localSessionId) return null;
      const indexed = readCodexSessionIndex(indexFile).get(localSessionId);
      return normalizeAppServerMetadata(thread, { indexName: indexed?.title });
    } catch {
      return null;
    }
  }

  async function readAppServerSessionTree(localSessionId) {
    const root = await readAppServerSession(localSessionId);
    if (!root) return { metadata: [], descendantIds: new Set(), freshIds: new Set() };
    const discovered = [root];
    const descendantIds = new Set();
    const freshIds = new Set([root.localId]);
    const filters = includeArchived ? [false, true] : [false];
    try {
      const pages = await Promise.all(filters.map(async (archived) => {
        const response = await appServerCall("thread/list", {
          limit: scanLimit,
          sortKey: "created_at",
          sortDirection: "asc",
          sourceKinds: ALL_SOURCE_KINDS,
          archived,
          ancestorThreadId: localSessionId,
        });
        const data = appServerResponseData(response);
        if (data === null) throw new Error("Invalid Codex app-server descendant response");
        const metadata = data.flatMap((thread) => {
          const metadata = normalizeAppServerMetadata(thread, { archived });
          return metadata ? [metadata] : [];
        });
        const ignoredAncestorFilter = metadata.some((item) => (
          item.localId === localSessionId
          || (isTopLevelCodexSession(item) && item.localId !== localSessionId)
        ));
        return { metadata, trusted: !ignoredAncestorFilter };
      }));
      for (const page of pages) {
        const pageMetadata = page.trusted ? page.metadata.map((item) => (
          item.sessionId === item.localId && !item.parentThreadId && !item.forkedFromId
            ? { ...item, sessionId: localSessionId }
            : item
        )) : page.metadata;
        discovered.push(...pageMetadata);
        if (!page.trusted) continue;
        for (const item of pageMetadata) {
          descendantIds.add(item.localId);
          freshIds.add(item.localId);
        }
      }
    } catch {
      // Descendant filtering is experimental; rollout relationships remain the fallback.
    }
    return { metadata: mergeMetadata(discovered), descendantIds, freshIds };
  }

  async function readAppServerThreadEvidence(threadId, actor, fallbackTimestamp) {
    const unavailable = {
      available: false,
      toolCalls: [],
      executionTasks: [],
      skills: [],
      pullRequestCreations: [],
    };
    if (!appServer) return unavailable;
    try {
      const response = await appServerCall("thread/read", { threadId, includeTurns: true });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) return unavailable;
      return {
        available: true,
        toolCalls: parseCodexCanonicalTurns(thread.turns, { actor, fallbackTimestamp }),
        executionTasks: parseCodexCanonicalExecutionTasks(thread.turns, { fallbackTimestamp }),
        skills: parseCodexCanonicalSkillUsage(thread.turns),
        pullRequestCreations: parseCodexCanonicalPullRequests(thread.turns, {
          actorId: actor.id,
          fallbackTimestamp,
          sourceKey: threadId,
        }),
      };
    } catch {
      return unavailable;
    }
  }

  async function readSession(localSessionId = "", readOptions = {}) {
    if (!isSafeCodexSessionId(localSessionId)) return null;
    const historical = readOptions.historical !== false;
    const discovered = await discoveredMetadata();
    const appServerTree = await readAppServerSessionTree(localSessionId);
    const mergedMetadata = mergeFreshSessionTreeMetadata(discovered, appServerTree);
    const metadataById = new Map(mergedMetadata.map((item) => [item.localId, item]));
    const rootMetadata = metadataById.get(localSessionId) || null;
    if (appServer && !appServerTree.metadata.length && !rootMetadata?.rolloutFile) return null;
    if (!rootMetadata || !isTopLevelCodexSession(rootMetadata)) return null;
    const selectedIds = new Set([localSessionId, ...appServerTree.descendantIds]);
    expandSelectedMetadata(metadataById, selectedIds);
    const summaries = new Map();
    const recordsByThreadId = new Map();
    const generationsByThreadId = new Map();
    const parsedIds = new Set();
    while (true) {
      const pending = [...selectedIds]
        .filter((id) => !parsedIds.has(id))
        .map((id) => metadataById.get(id))
        .filter(Boolean);
      if (!pending.length) break;
      for (const thread of pending) {
        parsedIds.add(thread.localId);
        if (!thread.rolloutFile) continue;
        const { records, generation } = readRolloutRecords(thread.rolloutFile, historical);
        recordsByThreadId.set(thread.localId, records);
        if (generation) generationsByThreadId.set(thread.localId, generation);
        const summary = parseCodexAgentRecords(records, thread);
        if (summary.localId) summaries.set(summary.localId, summary);
        for (const collaboration of summary.collaborations || []) {
          if (metadataById.has(collaboration.childThreadId)) selectedIds.add(collaboration.childThreadId);
        }
      }
      expandSelectedMetadata(metadataById, selectedIds);
    }
    const selectedMetadata = mergedMetadata.filter((item) => selectedIds.has(item.localId));
    const allMetadata = liveness.observe(selectedMetadata, { historical }).threads;
    const metadata = allMetadata.find((item) => item.localId === localSessionId) || rootMetadata;
    const agents = buildCodexAgentTree({
      rootThreadId: localSessionId,
      threads: allMetadata,
      summaries,
      historical,
    });
    if (!historical) applyWaitingStatus(agents);
    const startedAt = agents.map((agent) => agent.startedAt).filter(Boolean).sort()[0] || metadata.createdAt;
    const updatedAt = agents.map((agent) => agent.updatedAt).filter(Boolean).sort().at(-1)
      || metadata.updatedAt
      || startedAt;
    const rootRecords = recordsByThreadId.get(metadata.localId) || [];
    const parsedApprovalPlan = metadata.rolloutFile
      ? parseCodexApprovalPlanRecords(rootRecords)
      : { approvalMode: null, planTasks: [] };
    let planTasks = parsedApprovalPlan.planTasks;
    const rootGeneration = generationsByThreadId.get(metadata.localId) || null;
    if (!historical && metadata.rolloutFile && rootGeneration) {
      const latestSnapshot = latestCodexPlanSnapshot(rootRecords);
      planTasks = latestSnapshot
        ?? reusableLivePlanTasks(metadata.rolloutFile, metadata.localId, rootGeneration)
        ?? [];
      livePlanTaskCache.delete(metadata.rolloutFile);
      livePlanTaskCache.set(metadata.rolloutFile, {
        threadId: metadata.localId,
        generation: rootGeneration,
        planTasks,
      });
      while (livePlanTaskCache.size > scanLimit) {
        livePlanTaskCache.delete(livePlanTaskCache.keys().next().value);
      }
    }
    const approvalPlan = { ...parsedApprovalPlan, planTasks };
    const actorByThreadId = new Map(agents.map((agent) => [
      agent.id === "primary" ? localSessionId : agent.id.slice("agent-".length),
      { id: agent.id, label: agent.label },
    ]));
    const rolloutTasksByActor = new Map();
    const rolloutActivityByActor = new Map();
    const rolloutSignalsByActor = new Map();
    const rolloutSkillsByActor = new Map();
    const usageSnapshots = [];
    const compactions = [];
    const pullRequestCreationGroups = [];
    let rolloutEvidenceAvailable = false;
    const rolloutCalls = allMetadata.flatMap((thread) => {
      const actor = actorByThreadId.get(thread.localId);
      if (!actor || !thread.rolloutFile) return [];
      rolloutEvidenceAvailable ||= fs.existsSync(thread.rolloutFile);
      const records = recordsByThreadId.get(thread.localId) || [];
      const fallbackTimestamp = summaries.get(thread.localId)?.updatedAt || thread.updatedAt || updatedAt;
      const generation = generationsByThreadId.get(thread.localId) || null;
      const existingState = historical
        ? null
        : reusableLiveTaskState(thread.rolloutFile, thread.localId, generation);
      const rolloutTaskState = parseCodexExecutionTaskStateRecords(records, {
        fallbackTimestamp,
        existingState,
      });
      rolloutTasksByActor.set(actor.id, rolloutTaskState.tasks);
      if (!historical && generation) {
        liveExecutionTaskCache.delete(thread.rolloutFile);
        liveExecutionTaskCache.set(thread.rolloutFile, {
          threadId: thread.localId,
          generation,
          state: rolloutTaskState,
        });
        while (liveExecutionTaskCache.size > scanLimit) {
          liveExecutionTaskCache.delete(liveExecutionTaskCache.keys().next().value);
        }
      }
      rolloutActivityByActor.set(actor.id, parseCodexCurrentActivityRecords(records, {
        historical,
        agentStatus: agents.find((agent) => agent.id === actor.id)?.status,
      }));
      rolloutSignalsByActor.set(actor.id, parseCodexSignalRecords(records));
      rolloutSkillsByActor.set(actor.id, parseCodexSkillUsageRecords(records));
      pullRequestCreationGroups.push(parseCodexPullRequestRecords(records, {
        actorId: actor.id,
        fallbackTimestamp,
        sourceKey: thread.localId,
      }));
      const context = parseCodexContextRecords(records, {
        actorId: actor.id,
        fallbackTimestamp,
        sourceKey: thread.localId,
      });
      usageSnapshots.push(...context.usageSnapshots);
      compactions.push(...context.compactions);
      return parseCodexActivityRecords(records, {
        actor,
        fallbackTimestamp,
        sourceKey: thread.localId,
      });
    });
    const canonicalEvidence = await Promise.all([...actorByThreadId].map(([threadId, actor]) => (
      readAppServerThreadEvidence(threadId, actor, summaries.get(threadId)?.updatedAt || updatedAt)
    )));
    const toolCalls = mergeCodexToolCalls([rolloutCalls, ...canonicalEvidence.map((item) => item.toolCalls)]);
    const callsByActor = new Map();
    for (const call of toolCalls) callsByActor.set(call.actor.id, (callsByActor.get(call.actor.id) || 0) + 1);
    const canonicalTasksByActor = new Map(
      [...actorByThreadId.values()].map((actor, index) => [actor.id, canonicalEvidence[index]?.executionTasks || []]),
    );
    const canonicalByActor = new Map(
      [...actorByThreadId.values()].map((actor, index) => [actor.id, canonicalEvidence[index]]),
    );
    const allSignals = { agent: null, session: null, tasks: new Map() };
    const signalsByActor = new Map();
    for (const actor of actorByThreadId.values()) {
      const signals = mergeCodexSignals(
        { agent: null, session: null, tasks: new Map() },
        rolloutSignalsByActor.get(actor.id) || { agent: null, session: null, tasks: new Map() },
      );
      signalsByActor.set(actor.id, signals);
      mergeCodexSignals(allSignals, signals);
    }
    for (const agent of agents) {
      const signals = signalsByActor.get(agent.id) || { agent: null, session: null, tasks: new Map() };
      agent.signal = signals.agent;
      const currentActivity = rolloutActivityByActor.get(agent.id);
      if (currentActivity) agent.currentActivity = currentActivity;
      const rolloutSkills = rolloutSkillsByActor.get(agent.id) || [];
      agent.skills = mergeSkillUsage([rolloutSkills.length ? rolloutSkills : canonicalByActor.get(agent.id)?.skills || []]);
      agent.toolCalls = callsByActor.get(agent.id) || 0;
      agent.executionTasks = mergeCodexExecutionTasks([
        rolloutTasksByActor.get(agent.id) || [],
        canonicalTasksByActor.get(agent.id) || [],
      ], { historical, sessionUpdatedAt: updatedAt, taskSignals: allSignals.tasks });
    }
    pullRequestCreationGroups.push(...canonicalEvidence.map((item) => item.pullRequestCreations));
    usageSnapshots.sort((left, right) => (
      Date.parse(left.timestamp) - Date.parse(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)
    ));
    compactions.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    return {
      localId: metadata.localId,
      historical,
      session: {
        title: metadata.title,
        project: metadata.project,
        cwd: metadata.cwd,
        startedAt,
        updatedAt,
        recordedGitBranch: metadata.recordedGitBranch,
        cost: null,
        approvalMode: approvalPlan.approvalMode,
        contextMachinery: null,
        summary: null,
        signal: allSignals.session,
      },
      agents,
      usageSnapshots,
      toolCalls,
      activity: [],
      planTasks: approvalPlan.planTasks,
      compactions,
      efficiencyRuleEvidence: {
        repetition: rolloutEvidenceAvailable || canonicalEvidence.some((item) => item.available),
        concurrentMutation: rolloutEvidenceAvailable || canonicalEvidence.some((item) => item.available),
        unsharedContext: (rolloutEvidenceAvailable || canonicalEvidence.some((item) => item.available))
          && usageSnapshots.some((snapshot) => snapshot.actorId === "primary"),
        healthyFallback: rolloutEvidenceAvailable || canonicalEvidence.some((item) => item.available),
        cacheUsageClassification: rolloutEvidenceAvailable && usageSnapshots.length > 0,
      },
      pullRequestCreations: mergeCodexPullRequestCreations(pullRequestCreationGroups),
    };
  }

  return defineProvider({
    id: "codex",
    source: "Codex",
    capabilities: {
      approvalMode: true,
      automaticCompactions: true,
      liveSessions: true,
      needsInput: true,
      planTasks: true,
      cacheUsageClassification: true,
      signals: true,
      usageLimits: true,
    },
    listSessions,
    readSession,
    readUsageLimits: usageLimits,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : "No Codex sessions found.";
    },
    qaStats(reset = false) {
      const livenessStats = liveness.stats();
      const value = {
        ...rolloutStats,
        cacheEntries: rolloutCache.size,
        liveExecutionTaskEntries: liveExecutionTaskCache.size,
        livePlanTaskEntries: livePlanTaskCache.size,
        catalogPending: Boolean(catalogPending),
        livenessRolloutFiles: livenessStats.rolloutFiles,
        livenessRolloutBytes: livenessStats.rolloutBytes,
      };
      if (reset) Object.assign(rolloutStats, { reads: 0, bytes: 0, cacheHits: 0 });
      return value;
    },
    watchTargets: [sessionsRoot, ...(includeArchived ? [archivedRoot] : []), indexFile, livenessRoot],
  });
}

export const codexProvider = createCodexProvider();
