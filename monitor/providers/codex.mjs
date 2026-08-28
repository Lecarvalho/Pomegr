import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { applyWaitingStatus } from "../agent-metadata.mjs";
import { defineProvider } from "./provider-contract.mjs";
import { createCodexIncrementalObserver } from "./codex-observation.mjs";
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
import {
  latestCodexPlanSnapshot,
  parseCodexApprovalPlanRecords,
} from "./codex-approval-plan.mjs";
import { parseCodexContextRecords } from "./codex-context.mjs";
import { parseCodexCurrentActivityStateRecords } from "./codex-current-activity.mjs";
import { buildCodexAgentTree, parseCodexAgentRecords } from "./codex-agent-metadata.mjs";
import {
  mergeCodexPullRequestCreations,
  parseCodexCanonicalPullRequests,
  parseCodexPullRequestRecords,
} from "./codex-pull-requests.mjs";
import {
  mergeCodexSignals,
  parseCodexSignalRecords,
  readCodexSignals,
} from "./codex-session-signals.mjs";
import { parseCodexCanonicalSkillUsage, parseCodexSkillUsageRecords } from "./codex-skill-usage.mjs";
import { createCodexUsageLimitsCoordinator } from "./codex-usage-limits.mjs";
import { createCodexLivenessCoordinator, resolveCodexLivenessRoot } from "./codex-liveness.mjs";
import { createCodexLiveState } from "./codex-live-state.mjs";
import {
  appServerResponseData,
  appServerResponseThread,
  boundedInteger,
  compareCodexMetadata,
  expandCodexSelectedMetadata,
  mergeCodexMetadata,
  mergeFreshCodexSessionTreeMetadata,
  trustedAppServerRolloutFile,
} from "./codex-session-discovery.mjs";
import { readLatestPomegrPluginMetadata } from "./pomegr-plugin-metadata.mjs";
import {
  DEFAULT_CODEX_CATALOG_LIMIT,
  DEFAULT_CODEX_SCAN_LIMIT,
  isSafeCodexSessionId,
  isTopLevelCodexSession,
  listCodexRolloutMetadata,
  normalizeCodexThreadMetadata,
  readCodexSessionIndex,
} from "./codex-session-metadata.mjs";

const TOP_LEVEL_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
export const CODEX_LIVE_STATE_MAX_TAIL_BYTES = 512 * 1024;
export const CODEX_LIVE_TASK_HISTORY_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_LIVE_EXECUTION_TASK_CACHE_SCHEMA = 2;
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
  // This reader is intentionally account-only. Unlike `appServer`, it must
  // never supply session, catalog, liveness, or canonical-turn evidence.
  const rateLimitsReader = options.rateLimitsReader || null;
  const now = options.now || (() => Date.now());
  const includeArchived = options.includeArchived ?? true;
  const catalogLimit = boundedInteger(options.catalogLimit, DEFAULT_CODEX_CATALOG_LIMIT, 200);
  const scanLimit = Math.max(catalogLimit, boundedInteger(options.scanLimit, DEFAULT_CODEX_SCAN_LIMIT, DEFAULT_CODEX_SCAN_LIMIT));
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : 1500;
  const maximumLiveTailBytes = Number.isInteger(options.maximumStateTailBytes)
    ? Math.max(1, Math.min(4 * 1024 * 1024, options.maximumStateTailBytes))
    : CODEX_LIVE_STATE_MAX_TAIL_BYTES;
  const maximumLiveTaskHistoryBytes = Number.isInteger(options.maximumTaskHistoryBytes)
    ? Math.max(maximumLiveTailBytes, Math.min(8 * 1024 * 1024, options.maximumTaskHistoryBytes))
    : Math.max(maximumLiveTailBytes, CODEX_LIVE_TASK_HISTORY_MAX_BYTES);
  const liveness = createCodexLivenessCoordinator({
    root: livenessRoot,
    writerLocksRoot: path.join(codexHome, "thread-writer-locks"),
    now,
    cacheMs,
    maximumBridgeFiles: options.maximumBridgeFiles,
    maximumTailBytes: options.maximumTailBytes,
  });
  const usageLimits = createCodexUsageLimitsCoordinator({
    now,
    request: async () => {
      if (rateLimitsReader) {
        if (typeof rateLimitsReader.readRateLimits !== "function") {
          throw new Error("Codex rate limits are unavailable");
        }
        const response = await rateLimitsReader.readRateLimits();
        if (response === null || response === undefined) throw new Error("Codex rate limits are unavailable");
        return response;
      }
      // Preserve the explicitly supplied owning-app-server test seam. The
      // production registry injects the separate account-only reader above.
      if (!appServer) throw new Error("Codex app-server is unavailable");
      const response = await appServerCall("account/rateLimits/read");
      if (response === null || response === undefined) throw new Error("Codex rate limits are unavailable");
      return response;
    },
  }).get;
  let catalogCache = null;
  let catalogPending = null;
  const liveState = createCodexLiveState({
    scanLimit,
    maximumLiveTailBytes,
    maximumLiveTaskHistoryBytes,
  });
  const transcriptPathsBySessionId = new Map();
  const {
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
    resolveLiveAgentRuntime,
    reusableLiveAgentAssignments,
    reusableLiveApprovalMode,
    reusableLiveCurrentActivity,
    reusableLivePlanTasks,
    reusableLiveTaskState,
  } = liveState;

  function normalizeAppServerMetadata(thread, metadataOptions = {}) {
    const metadata = normalizeCodexThreadMetadata(thread, metadataOptions);
    if (!metadata) return null;
    const rolloutFile = trustedAppServerRolloutFile(thread, [sessionsRoot, archivedRoot]);
    return rolloutFile ? { ...metadata, rolloutFile } : metadata;
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
      return mergeCodexMetadata(pages.flat()).slice(0, scanLimit);
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
        ? mergeCodexMetadata([...fallbackMetadata, ...appServerMetadata])
        : fallbackMetadata;
      const value = combined;
      const knownRolloutFiles = new Set(value.map((item) => item.rolloutFile).filter(Boolean));
      pruneKnownFiles(knownRolloutFiles);
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
      const state = sessions.get(thread.localId) || { isLive: false, needsInput: false, activityStatus: "unknown", observedAt: null };
      return {
        localId: thread.localId,
        title: thread.title,
        project: thread.project,
        updatedAt: [thread.updatedAt, thread.createdAt, state.observedAt].filter(Boolean).sort().at(-1) || new Date(0).toISOString(),
        isLive: state.isLive,
        needsInput: state.needsInput,
        activityStatus: state.activityStatus,
        resourceOwner: state.resourceOwner || null,
      };
    }).sort(compareCodexMetadata).slice(0, catalogLimit);
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
    return { metadata: mergeCodexMetadata(discovered), descendantIds, freshIds };
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
    const completeStory = readOptions.completeStory === true;
    const incrementalRecordsByFile = readOptions.incrementalRecordsByFile instanceof Map
      ? readOptions.incrementalRecordsByFile
      : null;
    const incrementalGenerationsByFile = readOptions.incrementalGenerationsByFile instanceof Map
      ? readOptions.incrementalGenerationsByFile
      : null;
    const discovered = await discoveredMetadata();
    const appServerTree = await readAppServerSessionTree(localSessionId);
    const mergedMetadata = mergeFreshCodexSessionTreeMetadata(discovered, appServerTree);
    const metadataById = new Map(mergedMetadata.map((item) => [item.localId, item]));
    const rootMetadata = metadataById.get(localSessionId) || null;
    if (appServer && !appServerTree.metadata.length && !rootMetadata?.rolloutFile) return null;
    if (!rootMetadata || !isTopLevelCodexSession(rootMetadata)) return null;
    const selectedIds = new Set([localSessionId, ...appServerTree.descendantIds]);
    expandCodexSelectedMetadata(metadataById, selectedIds);
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
        const incremental = incrementalRecordsByFile
          ? {
            records: incrementalRecordsByFile.get(thread.rolloutFile) || [],
            generation: incrementalGenerationsByFile?.get(thread.rolloutFile) || null,
          }
          : null;
        const { records, generation } = incremental || readRolloutRecords(
          thread.rolloutFile,
          historical || completeStory,
          thread.approvalReviewer ? maximumLiveTaskHistoryBytes : maximumLiveTailBytes,
        );
        recordsByThreadId.set(thread.localId, records);
        if (generation) generationsByThreadId.set(thread.localId, generation);
        let summary = parseCodexAgentRecords(records, thread);
        if (!historical && generation) {
          summary = { ...summary, runtime: resolveLiveAgentRuntime(thread.rolloutFile, thread.localId, generation, thread, summary.runtime) };
          const retained = reusableLiveAgentAssignments(thread.rolloutFile, thread.localId, generation)
            ?? hydrateLiveAgentAssignments(thread.rolloutFile, generation, thread);
          const collaborations = assignmentCollaborations([...retained, ...summary.collaborations]);
          summary = { ...summary, collaborations: [...collaborations, ...summary.collaborations] };
          liveAgentAssignmentCache.delete(thread.rolloutFile);
          liveAgentAssignmentCache.set(thread.rolloutFile, { threadId: thread.localId, generation, collaborations });
          while (liveAgentAssignmentCache.size > scanLimit) {
            liveAgentAssignmentCache.delete(liveAgentAssignmentCache.keys().next().value);
          }
        }
        if (summary.localId) summaries.set(summary.localId, summary);
        for (const collaboration of summary.collaborations || []) {
          if (metadataById.has(collaboration.childThreadId)) selectedIds.add(collaboration.childThreadId);
        }
      }
      expandCodexSelectedMetadata(metadataById, selectedIds);
    }
    const selectedMetadata = mergedMetadata.filter((item) => selectedIds.has(item.localId));
    const allMetadata = liveness.observe(selectedMetadata, { historical }).threads;
    const metadata = allMetadata.find((item) => item.localId === localSessionId) || rootMetadata;
    const agents = /** @type {any[]} */ (buildCodexAgentTree({
      rootThreadId: localSessionId,
      threads: allMetadata,
      summaries,
      historical,
    }));
    const transcriptPaths = new Map();
    for (const agent of agents) {
      const threadId = agent.id === "primary" ? localSessionId : agent.id.slice("agent-".length);
      const transcriptPath = metadataById.get(threadId)?.rolloutFile || null;
      agent.transcriptAvailable = agent.id !== "primary" && Boolean(transcriptPath);
      if (agent.transcriptAvailable) transcriptPaths.set(agent.id, transcriptPath);
    }
    transcriptPathsBySessionId.delete(localSessionId);
    transcriptPathsBySessionId.set(localSessionId, transcriptPaths);
    while (transcriptPathsBySessionId.size > 64) transcriptPathsBySessionId.delete(transcriptPathsBySessionId.keys().next().value);
    const startedAt = agents.map((agent) => agent.startedAt).filter(Boolean).sort()[0] || metadata.createdAt;
    const updatedAt = agents.map((agent) => agent.updatedAt).filter(Boolean).sort().at(-1)
      || metadata.updatedAt
      || startedAt;
    const rootRecords = recordsByThreadId.get(metadata.localId) || [];
    const pomegrPlugin = metadata.rolloutFile
      ? await readLatestPomegrPluginMetadata(metadata.rolloutFile, "codex")
      : null;
    const parsedApprovalPlan = metadata.rolloutFile
      ? parseCodexApprovalPlanRecords(rootRecords)
      : { approvalMode: null, planTasks: [] };
    let approvalMode = parsedApprovalPlan.approvalMode;
    let planTasks = parsedApprovalPlan.planTasks;
    const rootGeneration = generationsByThreadId.get(metadata.localId) || null;
    if (!historical && metadata.rolloutFile && rootGeneration) {
      const cachedApproval = reusableLiveApprovalMode(metadata.rolloutFile, metadata.localId, rootGeneration);
      const skippedApprovalGap = cachedApproval
        && rootGeneration.size - cachedApproval.generation.size > maximumLiveTailBytes;
      const needsApprovalHydration = !approvalMode && (!cachedApproval || skippedApprovalGap);
      const hydratedApproval = needsApprovalHydration
        ? hydrateLiveApprovalMode(metadata.rolloutFile, rootGeneration)
        : null;
      approvalMode = approvalMode
        ?? hydratedApproval?.approvalMode
        ?? cachedApproval?.approvalMode
        ?? null;
      const approvalCacheGeneration = needsApprovalHydration && !hydratedApproval && cachedApproval
        ? cachedApproval.generation
        : rootGeneration;
      const approvalEvidenceAvailable = Boolean(approvalMode)
        || Boolean(cachedApproval)
        || Boolean(hydratedApproval)
        || rootGeneration.size <= maximumLiveTailBytes;
      liveApprovalModeCache.delete(metadata.rolloutFile);
      if (approvalEvidenceAvailable) {
        liveApprovalModeCache.set(metadata.rolloutFile, {
          threadId: metadata.localId,
          generation: approvalCacheGeneration,
          approvalMode,
        });
      }
      while (liveApprovalModeCache.size > scanLimit) {
        liveApprovalModeCache.delete(liveApprovalModeCache.keys().next().value);
      }
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
    const approvalPlan = { approvalMode, planTasks };
    const actorByThreadId = new Map(agents.map((agent) => [
      agent.id === "primary" ? localSessionId : agent.id.slice("agent-".length),
      { id: agent.id, label: agent.label },
    ]));
    const rolloutTasksByActor = new Map();
    const rolloutActivityByActor = new Map();
    const rolloutHeuristicIdleActors = new Set();
    const rolloutSignalsByActor = new Map();
    const rolloutSkillsByActor = new Map();
    const usageSnapshots = [];
    const compactions = [];
    const pullRequestCreationGroups = [];
    let rolloutEvidenceAvailable = false;
    const liveSignalsByThreadId = historical ? new Map() : new Map(await Promise.all(
      allMetadata
        .filter((thread) => thread.rolloutFile)
        .map(async (thread) => [
          thread.localId,
          await readCodexSignals(
            thread.rolloutFile,
            recordsByThreadId.get(thread.localId) || [],
            generationsByThreadId.get(thread.localId) || null,
          ),
        ]),
    ));
    const rolloutCalls = allMetadata.flatMap((thread) => {
      const actor = actorByThreadId.get(thread.localId);
      if (!actor || !thread.rolloutFile) return [];
      rolloutEvidenceAvailable ||= fs.existsSync(thread.rolloutFile);
      const records = recordsByThreadId.get(thread.localId) || [];
      const fallbackTimestamp = summaries.get(thread.localId)?.updatedAt || thread.updatedAt || updatedAt;
      const generation = generationsByThreadId.get(thread.localId) || null;
      const agentStatus = agents.find((agent) => agent.id === actor.id)?.status;
      const rolloutHeuristicIdle = agentStatus === "idle"
        && thread.liveness?.source === "rollout_activity_heuristic";
      if (rolloutHeuristicIdle) rolloutHeuristicIdleActors.add(actor.id);
      const cachedCurrentActivity = historical
        ? null
        : reusableLiveCurrentActivity(thread.rolloutFile, thread.localId, generation);
      const context = parseCodexContextRecords(records, {
        actorId: actor.id,
        fallbackTimestamp,
        sourceKey: thread.localId,
        stableFallbackIdentity: !historical,
      });
      let existingState = historical
        ? null
        : reusableLiveTaskState(thread.rolloutFile, thread.localId, generation);
      let hydratedStateEvidence = null;
      const previousContext = liveContextUsageCache.get(thread.rolloutFile);
      const skippedContextGap = previousContext && generation
        && (!hasLiveContextContinuity(thread.rolloutFile, generation) || generation.size - previousContext.size > maximumLiveTailBytes);
      const skippedActivityGap = cachedCurrentActivity
        && generation
        && generation.size - cachedCurrentActivity.generation.size > maximumLiveTailBytes;
      const needsContextHydration = !historical
        && generation?.size > maximumLiveTailBytes
        && (!previousContext || skippedContextGap);
      const needsActivityHydration = !historical
        && generation?.size > maximumLiveTailBytes
        && (!cachedCurrentActivity || skippedActivityGap);
      if (!historical && (!existingState || needsContextHydration || needsActivityHydration)) {
        hydratedStateEvidence = hydrateLiveStateEvidence(thread.rolloutFile, generation, {
          fallbackTimestamp,
          actorId: actor.id,
          sourceKey: thread.localId,
          currentActivityOptions: {
            existingState: cachedCurrentActivity?.state,
            agentStatus,
            rolloutHeuristicIdle,
          },
        });
        existingState = hydratedStateEvidence?.taskState || null;
      }
      const rolloutTaskState = parseCodexExecutionTaskStateRecords(records, {
        fallbackTimestamp,
        existingState,
      });
      rolloutTasksByActor.set(actor.id, rolloutTaskState.tasks);
      if (!historical && generation) {
        liveExecutionTaskCache.delete(thread.rolloutFile);
        liveExecutionTaskCache.set(thread.rolloutFile, {
          schemaVersion: CODEX_LIVE_EXECUTION_TASK_CACHE_SCHEMA,
          threadId: thread.localId,
          generation,
          state: rolloutTaskState,
        });
        while (liveExecutionTaskCache.size > scanLimit) {
          liveExecutionTaskCache.delete(liveExecutionTaskCache.keys().next().value);
        }
      }
      const currentActivityState = parseCodexCurrentActivityStateRecords(records, {
        historical,
        agentStatus,
        rolloutHeuristicIdle,
        existingState: hydratedStateEvidence?.currentActivityState || cachedCurrentActivity?.state,
      });
      rolloutActivityByActor.set(actor.id, currentActivityState.currentActivity);
      if (!historical && generation) {
        liveCurrentActivityCache.delete(thread.rolloutFile);
        liveCurrentActivityCache.set(thread.rolloutFile, {
          threadId: thread.localId,
          generation,
          state: currentActivityState,
        });
        while (liveCurrentActivityCache.size > scanLimit) {
          liveCurrentActivityCache.delete(liveCurrentActivityCache.keys().next().value);
        }
      }
      rolloutSignalsByActor.set(actor.id, historical
        ? parseCodexSignalRecords(records)
        : liveSignalsByThreadId.get(thread.localId) || parseCodexSignalRecords(records));
      rolloutSkillsByActor.set(actor.id, parseCodexSkillUsageRecords(records));
      pullRequestCreationGroups.push(parseCodexPullRequestRecords(records, {
        actorId: actor.id,
        fallbackTimestamp,
        sourceKey: thread.localId,
      }));
      const normalizedContext = historical
        ? { snapshots: context.usageSnapshots, compactions: context.compactions }
        : mergeLiveContextEvidence(thread.rolloutFile, generation, {
          usageSnapshots: [...(hydratedStateEvidence?.usageSnapshots || []), ...context.usageSnapshots],
          compactions: [...(hydratedStateEvidence?.compactions || []), ...context.compactions],
          // An unhydrated bounded tail cannot replace the prior complete context.
          preservePreviousOnDiscontinuity: !(hydratedStateEvidence || generation?.size <= maximumLiveTailBytes),
        });
      usageSnapshots.push(...normalizedContext.snapshots);
      compactions.push(...normalizedContext.compactions);
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
    const allSignals = { agent: null, session: null, progress: null, tasks: new Map() };
    const signalsByActor = new Map();
    for (const actor of actorByThreadId.values()) {
      const signals = mergeCodexSignals(
        { agent: null, session: null, progress: null, tasks: new Map() },
        rolloutSignalsByActor.get(actor.id) || { agent: null, session: null, progress: null, tasks: new Map() },
      );
      signalsByActor.set(actor.id, signals);
      mergeCodexSignals(allSignals, signals);
    }
    for (const agent of agents) {
      agent.workflowId = null;
      agent.workflowPhaseId = null;
      agent.workflowOrder = null;
      agent.workflowState = null;
      const signals = signalsByActor.get(agent.id) || { agent: null, session: null, tasks: new Map() };
      agent.signal = signals.agent;
      const currentActivity = rolloutActivityByActor.get(agent.id);
      if (currentActivity) {
        agent.currentActivity = currentActivity;
        if (agent.status === "idle" && rolloutHeuristicIdleActors.has(agent.id)) agent.status = "active";
      }
      const rolloutSkills = rolloutSkillsByActor.get(agent.id) || [];
      agent.skills = mergeSkillUsage([rolloutSkills.length ? rolloutSkills : canonicalByActor.get(agent.id)?.skills || []]);
      agent.toolCalls = callsByActor.get(agent.id) || 0;
      agent.executionTasks = mergeCodexExecutionTasks([
        rolloutTasksByActor.get(agent.id) || [],
        canonicalTasksByActor.get(agent.id) || [],
      ], { historical, sessionUpdatedAt: updatedAt, taskSignals: allSignals.tasks });
    }
    if (!historical) applyWaitingStatus(agents);
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
        // Session progress is scoped to the primary rollout only.
        progress: signalsByActor.get("primary")?.progress || null,
        pomegrPlugin,
      },
      agents,
      workflows: [],
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
        cacheUsageClassification: false,
      },
      pullRequestCreations: mergeCodexPullRequestCreations(pullRequestCreationGroups),
    };
  }
  const capabilityManifest = {
    approvalMode: { status: "supported" },
    automaticCompactions: { status: "supported" },
    contextMachinery: { status: "unsupported", limitation: { code: "provider_does_not_expose", documentation: "Codex session evidence does not expose normalized context-machinery categories." } },
    estimatedCost: { status: "unsupported", limitation: { code: "provider_does_not_expose", documentation: "Codex session evidence does not expose a provider cost estimate." } },
    liveSessions: { status: "supported" },
    needsInput: { status: "supported" },
    planTasks: { status: "supported" },
    cacheWriteUsage: { status: "unsupported", limitation: { code: "provider_does_not_expose", documentation: "Codex usage evidence does not provide normalized cache-write tokens." } },
    cacheUsageClassification: { status: "unsupported", limitation: { code: "provider_does_not_expose", documentation: "Codex usage evidence cannot safely classify cache-write behavior." } },
    sessionSummary: { status: "unsupported", limitation: { code: "provider_does_not_expose", documentation: "Codex session evidence does not expose a bounded provider session summary." } },
    signals: { status: "supported" },
    usageLimits: { status: "supported" },
    workflows: { status: "unsupported", limitation: { code: "unsupported_transcript_format", documentation: "Codex does not expose the structured workflow artifacts required by the normalized workflow contract." } },
  };

  async function readTranscriptPath(localSessionId = "", agentId = "") {
    if (!transcriptPathsBySessionId.has(localSessionId)) await readSession(localSessionId, { historical: true });
    return transcriptPathsBySessionId.get(localSessionId)?.get(agentId) || null;
  }

  const watchTargets = [sessionsRoot, ...(includeArchived ? [archivedRoot] : []), indexFile, livenessRoot];
  return defineProvider({
    id: "codex",
    source: "Codex",
    capabilityManifest,
    homePolicy: {
      requestModelObservations: true,
      modelSelection: true,
      usageLimitActivity: {
        enabled: true,
        weeklyLimitIds: null,
        trackedLimitIds: null,
        modelScopes: [],
        selection: {
          mode: "dominant_model_window",
          defaultWindow: "7d",
          defaultExcludedLimitSegments: ["gpt-5.3-codex-spark"],
          overrides: [{
            models: ["gpt-5.3-codex-spark"],
            window: "5h",
            preferredLimitSegments: ["gpt-5.3-codex-spark"],
          }],
        },
      },
    },
    readinessCapabilities: ["usageLimits"],
    async resolveReadiness() {
      let usageLimitsAvailable = Boolean(appServer);
      if (rateLimitsReader) {
        usageLimitsAvailable = typeof rateLimitsReader.isAvailable === "function"
          ? await rateLimitsReader.isAvailable()
          : typeof rateLimitsReader.readRateLimits === "function";
      }
      return {
        usageLimits: usageLimitsAvailable
          ? { status: "ready" }
          : { status: "unavailable", reason: "runtime_unavailable" },
      };
    },
    listSessions,
    readSession,
    createObserver: () => createCodexIncrementalObserver({ list: listSessions, readEvidence: readSession, discoveredMetadata, transcriptPathsBySessionId, intervalMs: options.observerIntervalMs ?? 10_000, concurrency: options.observerConcurrency ?? 2, watchTargets }),
    readTranscriptPath,
    readUsageLimits: usageLimits,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : "No Codex sessions found.";
    },
    qaStats(reset = false) {
      const livenessStats = liveness.stats();
      return {
        ...liveState.stats(reset),
        catalogPending: Boolean(catalogPending),
        livenessRolloutFiles: livenessStats.rolloutFiles,
        livenessRolloutBytes: livenessStats.rolloutBytes,
      };
    },
    watchTargets,
  });
}

export const codexProvider = createCodexProvider();
