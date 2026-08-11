import os from "node:os";
import path from "node:path";
import { defineProvider } from "./provider-contract.mjs";
import {
  mergeCodexToolCalls,
  parseCodexCanonicalTurns,
  readCodexActivityRollout,
} from "./codex-activity-events.mjs";
import {
  mergeCodexExecutionTasks,
  parseCodexCanonicalExecutionTasks,
  readCodexExecutionTaskRollout,
} from "./codex-execution-tasks.mjs";
import { buildCodexAgentTree, readCodexAgentRollout } from "./codex-agent-metadata.mjs";
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
      archived: item.archived && previous.archived,
      rolloutFile: item.rolloutFile || previous.rolloutFile,
    });
  }
  return [...byId.values()].sort(compareMetadata);
}

function appServerResponseData(response) {
  const value = response?.result ?? response;
  return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null;
}

function appServerResponseThread(response) {
  const value = response?.result ?? response;
  return value?.thread && typeof value.thread === "object" ? value.thread : null;
}

/** @returns {import("./provider-contract").ProviderAdapter} */
export function createCodexProvider(options = {}) {
  const codexHome = resolveCodexHome(options);
  const sessionsRoot = options.sessionsRoot || path.join(codexHome, "sessions");
  const archivedRoot = options.archivedRoot || path.join(codexHome, "archived_sessions");
  const indexFile = options.indexFile || path.join(codexHome, "session_index.jsonl");
  const appServer = options.appServer || null;
  const includeArchived = options.includeArchived ?? true;
  const catalogLimit = boundedInteger(options.catalogLimit, DEFAULT_CODEX_CATALOG_LIMIT, 200);
  const scanLimit = Math.max(catalogLimit, boundedInteger(options.scanLimit, DEFAULT_CODEX_SCAN_LIMIT, DEFAULT_CODEX_SCAN_LIMIT));
  const cacheMs = Number.isFinite(options.cacheMs) ? Math.max(0, options.cacheMs) : 1500;
  let catalogCache = null;

  async function appServerCall(method, params) {
    if (!appServer) return null;
    if (typeof appServer.request === "function") return appServer.request(method, params);
    if (method === "thread/list" && typeof appServer.listThreads === "function") return appServer.listThreads(params);
    if (method === "thread/read" && typeof appServer.readThread === "function") return appServer.readThread(params);
    return null;
  }

  async function readAppServerCatalog() {
    if (!appServer) return null;
    const indexNames = readCodexSessionIndex(indexFile);
    const filters = includeArchived ? [false, true] : [false];
    try {
      const pages = await Promise.all(filters.map(async (archived) => {
        const response = await appServerCall("thread/list", {
          limit: catalogLimit,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: TOP_LEVEL_SOURCE_KINDS,
          archived,
        });
        const data = appServerResponseData(response);
        if (data === null) throw new Error("Invalid Codex app-server thread/list response");
        return data.flatMap((thread) => {
          const indexed = indexNames.get(thread?.id);
          const metadata = normalizeCodexThreadMetadata(thread, { archived, indexName: indexed?.title });
          return metadata && isTopLevelCodexSession(metadata) ? [metadata] : [];
        });
      }));
      return mergeMetadata(pages.flat()).slice(0, catalogLimit);
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

  function readFallbackCatalog() {
    return mergeMetadata(readFallbackMetadata().filter(isTopLevelCodexSession)).slice(0, catalogLimit);
  }

  async function discoveredMetadata() {
    const now = Date.now();
    if (catalogCache && now < catalogCache.expiresAt) return catalogCache.value;
    const appServerMetadata = await readAppServerCatalog();
    const value = appServerMetadata?.length ? appServerMetadata : readFallbackCatalog();
    catalogCache = { expiresAt: now + cacheMs, value };
    return value;
  }

  async function listSessions() {
    return (await discoveredMetadata()).map((metadata) => ({
      localId: metadata.localId,
      title: metadata.title,
      project: metadata.project,
      updatedAt: metadata.updatedAt || metadata.createdAt || new Date(0).toISOString(),
      isLive: false,
      needsInput: false,
    }));
  }

  async function readAppServerSession(localSessionId) {
    if (!appServer) return null;
    try {
      const response = await appServerCall("thread/read", { threadId: localSessionId, includeTurns: false });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== localSessionId) return null;
      const indexed = readCodexSessionIndex(indexFile).get(localSessionId);
      return normalizeCodexThreadMetadata(thread, { indexName: indexed?.title });
    } catch {
      return null;
    }
  }

  async function readAppServerSessionTree(localSessionId) {
    const root = await readAppServerSession(localSessionId);
    if (!root) return [];
    const discovered = [root];
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
        return data.flatMap((thread) => {
          const metadata = normalizeCodexThreadMetadata(thread, { archived });
          return metadata ? [metadata] : [];
        });
      }));
      discovered.push(...pages.flat());
    } catch {
      // Descendant filtering is experimental; rollout relationships remain the fallback.
    }
    return mergeMetadata(discovered);
  }

  async function readAppServerThreadEvidence(threadId, actor, fallbackTimestamp) {
    if (!appServer) return { toolCalls: [], executionTasks: [] };
    try {
      const response = await appServerCall("thread/read", { threadId, includeTurns: true });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== threadId) return { toolCalls: [], executionTasks: [] };
      return {
        toolCalls: parseCodexCanonicalTurns(thread.turns, { actor, fallbackTimestamp }),
        executionTasks: parseCodexCanonicalExecutionTasks(thread.turns, { fallbackTimestamp }),
      };
    } catch {
      return { toolCalls: [], executionTasks: [] };
    }
  }

  async function readSession(localSessionId = "") {
    if (!isSafeCodexSessionId(localSessionId)) return null;
    const fallbackMetadata = readFallbackMetadata();
    const appServerMetadata = await readAppServerSessionTree(localSessionId);
    const allMetadata = mergeMetadata([...fallbackMetadata, ...appServerMetadata]);
    const metadata = allMetadata.find((item) => item.localId === localSessionId) || null;
    if (!metadata || !isTopLevelCodexSession(metadata)) return null;
    const summaries = new Map();
    for (const thread of allMetadata) {
      if (!thread.rolloutFile) continue;
      const summary = readCodexAgentRollout(thread.rolloutFile, thread);
      if (summary.localId) summaries.set(summary.localId, summary);
    }
    const agents = buildCodexAgentTree({
      rootThreadId: localSessionId,
      threads: allMetadata,
      summaries,
      historical: true,
    });
    const startedAt = agents.map((agent) => agent.startedAt).filter(Boolean).sort()[0] || metadata.createdAt;
    const updatedAt = agents.map((agent) => agent.updatedAt).filter(Boolean).sort().at(-1)
      || metadata.updatedAt
      || startedAt;
    const actorByThreadId = new Map(agents.map((agent) => [
      agent.id === "primary" ? localSessionId : agent.id.slice("agent-".length),
      { id: agent.id, label: agent.label },
    ]));
    const rolloutTasksByActor = new Map();
    const rolloutCalls = allMetadata.flatMap((thread) => {
      const actor = actorByThreadId.get(thread.localId);
      if (!actor || !thread.rolloutFile) return [];
      rolloutTasksByActor.set(actor.id, readCodexExecutionTaskRollout(thread.rolloutFile, {
        fallbackTimestamp: summaries.get(thread.localId)?.updatedAt || thread.updatedAt || updatedAt,
      }));
      return readCodexActivityRollout(thread.rolloutFile, {
        actor,
        fallbackTimestamp: summaries.get(thread.localId)?.updatedAt || thread.updatedAt || updatedAt,
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
    for (const agent of agents) {
      agent.toolCalls = callsByActor.get(agent.id) || 0;
      agent.executionTasks = mergeCodexExecutionTasks([
        rolloutTasksByActor.get(agent.id) || [],
        canonicalTasksByActor.get(agent.id) || [],
      ], { historical: true, sessionUpdatedAt: updatedAt });
    }
    return {
      localId: metadata.localId,
      historical: true,
      session: {
        title: metadata.title,
        project: metadata.project,
        cwd: metadata.cwd,
        startedAt,
        updatedAt,
        recordedGitBranch: metadata.recordedGitBranch,
        cost: null,
        approvalMode: null,
        contextMachinery: null,
        summary: null,
        signal: null,
      },
      agents,
      usageSnapshots: [],
      toolCalls,
      activity: [],
      planTasks: [],
      compactions: [],
      pullRequestUrls: [],
    };
  }

  return defineProvider({
    id: "codex",
    source: "Codex",
    capabilities: {},
    listSessions,
    readSession,
    unavailableMessage(localSessionId = "") {
      return localSessionId ? "The selected session is no longer available." : "No Codex sessions found.";
    },
    watchTargets: [sessionsRoot, ...(includeArchived ? [archivedRoot] : []), indexFile],
  });
}

export const codexProvider = createCodexProvider();
