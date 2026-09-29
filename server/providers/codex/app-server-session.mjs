import { parseCodexCanonicalActivityEvents, parseCodexCanonicalTurns } from "./activity-events.mjs";
import { parseCodexCanonicalExecutionTasks } from "./execution-tasks.mjs";
import { parseCodexCanonicalPullRequests } from "./pull-requests.mjs";
import { parseCodexCanonicalSkillUsage } from "./skill-usage.mjs";
import {
  appServerResponseData,
  appServerResponseThread,
  mergeCodexMetadata,
  trustedAppServerRolloutFile,
} from "./session-discovery.mjs";
import { isTopLevelCodexSession, normalizeCodexThreadMetadata, readCodexSessionIndex } from "./session-metadata.mjs";

const TOP_LEVEL_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const ALL_SOURCE_KINDS = [
  ...TOP_LEVEL_SOURCE_KINDS,
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
];

/**
 * Catalog, session-tree, and canonical-turn evidence read from the owning Codex app server.
 * Rollout files remain the independent fallback source, so every read here degrades to a null
 * or unavailable result instead of failing the session: the adapter then keeps recorded evidence.
 */
export function createCodexAppServerSessionReader({
  appServer, request, indexFile, includeArchived, scanLimit, rolloutRoots,
}) {
  function normalizeAppServerMetadata(thread, metadataOptions = {}) {
    const metadata = normalizeCodexThreadMetadata(thread, metadataOptions);
    if (!metadata) return null;
    const rolloutFile = trustedAppServerRolloutFile(thread, rolloutRoots);
    return rolloutFile ? { ...metadata, rolloutFile } : metadata;
  }

  async function readCatalog() {
    if (!appServer) return null;
    const indexNames = readCodexSessionIndex(indexFile);
    const filters = includeArchived ? [false, true] : [false];
    try {
      const pages = await Promise.all(filters.map(async (archived) => {
        const response = await request("thread/list", {
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

  /** @param {{ onBatch?: (batch: any[]) => boolean | Promise<boolean>, signal?: AbortSignal }} [options] */
  async function enumerateSessionHeaders(options = {}) {
    const { onBatch, signal } = options;
    if (!appServer || typeof onBatch !== "function") return { complete: true };
    const filters = includeArchived ? [false, true] : [false];
    for (const archived of filters) {
      let cursor = null;
      let previousCursor = Symbol("initial");
      while (!signal?.aborted) {
        let response;
        try {
          response = await request("thread/list", {
            limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ALL_SOURCE_KINDS, archived,
            ...(cursor ? { cursor } : {}),
          });
        } catch { return { complete: false }; }
        const data = appServerResponseData(response);
        if (data === null) return { complete: false };
        const headers = data.flatMap((thread) => {
          const metadata = normalizeAppServerMetadata(thread, { archived });
          return metadata && isTopLevelCodexSession(metadata) ? [metadata] : [];
        });
        for (let offset = 0; offset < headers.length; offset += 100) {
          if (await onBatch(headers.slice(offset, offset + 100)) === false) return { complete: false };
        }
        const value = response?.result ?? response;
        const nextCursor = typeof value?.nextCursor === "string" && value.nextCursor ? value.nextCursor : null;
        if (!nextCursor) break;
        if (nextCursor === previousCursor) return { complete: false };
        previousCursor = nextCursor;
        cursor = nextCursor;
      }
      if (signal?.aborted) return { complete: false };
    }
    return { complete: true };
  }

  async function readSessionMetadata(localSessionId) {
    if (!appServer) return null;
    try {
      const response = await request("thread/read", { threadId: localSessionId, includeTurns: false });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== localSessionId) return null;
      const indexed = readCodexSessionIndex(indexFile).get(localSessionId);
      return normalizeAppServerMetadata(thread, { indexName: indexed?.title });
    } catch {
      return null;
    }
  }

  async function readSessionTree(localSessionId) {
    const root = await readSessionMetadata(localSessionId);
    if (!root) return { metadata: [], descendantIds: new Set(), freshIds: new Set() };
    const discovered = [root];
    const descendantIds = new Set();
    const freshIds = new Set([root.localId]);
    const filters = includeArchived ? [false, true] : [false];
    try {
      const pages = await Promise.all(filters.map(async (archived) => {
        const response = await request("thread/list", {
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

  /** @param {{ cwd?: string, forbiddenRoots?: string[], deferFileChanges?: boolean }} [fileChangeOptions] */
  async function readThreadEvidence(threadId, actor, fallbackTimestamp, fileChangeOptions = {}) {
    const unavailable = { available: false, toolCalls: [], activity: [], executionTasks: [], skills: [], pullRequestCreations: [] };
    if (!appServer) return unavailable;
    try {
      const response = await request("thread/read", { threadId, includeTurns: true });
      const thread = appServerResponseThread(response);
      if (!thread || thread.id !== threadId || !Array.isArray(thread.turns)) return unavailable;
      return {
        available: true,
        toolCalls: parseCodexCanonicalTurns(thread.turns, {
          actor, fallbackTimestamp, cwd: fileChangeOptions.cwd, forbiddenRoots: fileChangeOptions.forbiddenRoots,
          deferFileChanges: fileChangeOptions.deferFileChanges === true,
        }),
        activity: parseCodexCanonicalActivityEvents(thread.turns, { actor }),
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

  return { normalizeAppServerMetadata, readCatalog, enumerateSessionHeaders, readSessionMetadata, readSessionTree, readThreadEvidence };
}
