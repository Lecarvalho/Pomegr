import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { readFileChangeAgents, SAFE_FILE_CHANGE_AGENT_ID as SAFE_AGENT_ID } from "./file-change-agents.mjs";
import { registerFileChangeIndexContributor } from "./file-change-index.mjs";
import { isSafeRecordedRepositoryPath } from "./repository-snapshot.mjs";

const REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
const FILE_ID_PATTERN = /^f[1-9][0-9]{0,15}$/u;

const MAX_DEMANDED_SESSIONS_PER_CYCLE = 32;
const MAX_LISTING_REQUESTS_PER_CYCLE = 8;
const MAX_HISTORY_REQUESTS_PER_CYCLE = 32;
const MAX_LISTINGS = 64;
const MAX_HISTORIES = 256;
const IDLE_MS = 10 * 60_000;

const MAX_SESSION_FILES = 200;
const MAX_SESSION_FILE_AGENTS = 12;
const MAX_REPOSITORY_FILES = 5000;
const MAX_HISTORY_SESSIONS = 100;
const MAX_FOLDER_PAIRS = 50_000;

function isoOrNull(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function safeArray(fn) {
  try {
    const result = fn();
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

function safeAgentLabel(agentLabelFn, sessionId, agentId) {
  try {
    const label = agentLabelFn(sessionId, agentId);
    return typeof label === "string" && label.length > 0 && label.length <= 200 ? label : null;
  } catch {
    return null;
  }
}

function historyAgents(store, sessionId, agentIds, agentLabelFn) {
  const ids = [...(agentIds || [])];
  const identities = readFileChangeAgents(store, sessionId, new Set(ids));
  return ids.map((agentId) => {
    const identity = identities.get(agentId);
    return {
      id: agentId,
      label: safeAgentLabel(agentLabelFn, sessionId, agentId) ?? identity?.label ?? null,
      assignment: identity?.assignment ?? null,
      model: identity?.model ?? null,
    };
  });
}

const EMPTY_SESSION_FILES = Object.freeze({ files: Object.freeze([]), truncated: false });
function sessionFilesFactory(readinessValue) {
  return Object.freeze({ readiness: readinessValue, ...EMPTY_SESSION_FILES });
}
const LOADING_SESSION_FILES = sessionFilesFactory("loading");
const UNAVAILABLE_SESSION_FILES = sessionFilesFactory("unavailable");
const REBUILDING_SESSION_FILES = sessionFilesFactory("rebuilding");

function loadingRepositoryFiles(repositoryId, readinessValue = "loading") {
  return Object.freeze({
    kind: "files", revision: 0, readiness: readinessValue, repositoryId,
    files: Object.freeze([]), folders: Object.freeze([]), historicalFolders: Object.freeze([]), truncated: false,
  });
}
function loadingFileHistory(repositoryId, path, readinessValue = "loading") {
  return Object.freeze({
    kind: "history", revision: 0, readiness: readinessValue, repositoryId,
    fileId: null, path: path ?? null, sessions: Object.freeze([]), unattributedChanges: 0, truncated: false,
  });
}

function storageReadinessKind(monitorStoreRuntime) {
  try {
    return monitorStoreRuntime.serveStorage?.()?.snapshot?.value?.readiness ?? null;
  } catch {
    return null;
  }
}

/** `null` when a committed block should be served as-is; otherwise the live override kind. */
function readinessOverride(monitorStoreRuntime, indexReady) {
  if (!monitorStoreRuntime.store()) return "unavailable";
  if (indexReady && !indexReady()) return "rebuilding";
  if (storageReadinessKind(monitorStoreRuntime) === "rebuilding") return "rebuilding";
  return null;
}

function buildSessionFiles(store, sessionId) {
  const repositories = preparedStatement(store.database, `
    SELECT DISTINCT f.repository_id AS repositoryId
    FROM file_changes fc JOIN files f ON f.id = fc.file_id
    WHERE fc.session_id = ? LIMIT 2
  `).all(sessionId);
  if (repositories.length > 1) return UNAVAILABLE_SESSION_FILES;
  const rows = preparedStatement(store.database, `
    SELECT f.id AS fileId, f.current_path AS path, COUNT(*) AS changeCount, MAX(fc.observed_at) AS newestAt
    FROM file_changes fc
    JOIN files f ON f.id = fc.file_id
    WHERE fc.session_id = ?
    GROUP BY f.id
    ORDER BY newestAt DESC
    LIMIT ?
  `).all(sessionId, MAX_SESSION_FILES + 1);
  const truncated = rows.length > MAX_SESSION_FILES;
  const bounded = rows.slice(0, MAX_SESSION_FILES).filter((row) => isSafeRecordedRepositoryPath(row.path));
  const kindStatement = preparedStatement(store.database, 
    "SELECT kind FROM file_changes WHERE file_id = ? AND session_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
  );
  const agentStatement = preparedStatement(store.database, `
    SELECT agent_id AS agentId, COUNT(*) AS changeCount, MAX(observed_at) AS newestAt
    FROM file_changes
    WHERE file_id = ? AND session_id = ? AND agent_id IS NOT NULL
    GROUP BY agent_id
    ORDER BY newestAt DESC, agent_id
    LIMIT ?
  `);
  const agentsByFile = new Map(bounded.map((row) => [row.fileId, agentStatement.all(row.fileId, sessionId, MAX_SESSION_FILE_AGENTS)
    .filter((agent) => typeof agent.agentId === "string" && SAFE_AGENT_ID.test(agent.agentId))]));
  const identities = readFileChangeAgents(store, sessionId, new Set([...agentsByFile.values()].flat().map((agent) => agent.agentId)));
  const files = bounded.map((row) => ({
    fileId: `f${row.fileId}`,
    path: row.path,
    kind: kindStatement.get(row.fileId, sessionId)?.kind || "edited",
    changeCount: row.changeCount,
    lastObservedAt: isoOrNull(row.newestAt),
    agents: agentsByFile.get(row.fileId).map((agent) => ({
      agentId: agent.agentId, changeCount: agent.changeCount,
      label: identities.get(agent.agentId)?.label ?? null,
      assignment: identities.get(agent.agentId)?.assignment ?? null,
      model: identities.get(agent.agentId)?.model ?? null,
    })),
  }));
  return Object.freeze({ readiness: "ready", files: Object.freeze(files), truncated });
}

function rollupFolders(pairs) {
  const bySessions = new Map();
  for (const { path, sessionId } of pairs) {
    const segments = path.split("/");
    segments.pop(); // drop the filename; only ancestor folders roll up
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      let sessions = bySessions.get(prefix);
      if (!sessions) { sessions = new Set(); bySessions.set(prefix, sessions); }
      sessions.add(sessionId);
    }
  }
  return [...bySessions.entries()]
    .map(([path, sessions]) => ({ path, sessionCount: sessions.size }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function buildRepositoryListing(store, repositoryId) {
  const fileRows = preparedStatement(store.database, `
    SELECT f.id AS fileId, f.current_path AS path, f.deleted_at AS deletedAt,
           COUNT(DISTINCT fc.session_id) AS sessionCount
    FROM files f
    LEFT JOIN file_changes fc ON fc.file_id = f.id AND fc.session_id IS NOT NULL
    WHERE f.repository_id = ?
    GROUP BY f.id
    ORDER BY f.current_path ASC
    LIMIT ?
  `).all(repositoryId, MAX_REPOSITORY_FILES + 1);
  const truncated = fileRows.length > MAX_REPOSITORY_FILES;
  const boundedRows = fileRows.slice(0, MAX_REPOSITORY_FILES).filter((row) => isSafeRecordedRepositoryPath(row.path));
  const files = boundedRows.map((row) => ({
    fileId: `f${row.fileId}`, path: row.path, sessionCount: row.sessionCount, deleted: row.deletedAt !== null,
  }));

  const pairRows = preparedStatement(store.database, `
    SELECT DISTINCT f.current_path AS path, f.deleted_at AS deletedAt, fc.session_id AS sessionId
    FROM files f
    JOIN file_changes fc ON fc.file_id = f.id
    WHERE f.repository_id = ? AND fc.session_id IS NOT NULL
    LIMIT ?
  `).all(repositoryId, MAX_FOLDER_PAIRS);
  const safePairs = pairRows.filter((row) => isSafeRecordedRepositoryPath(row.path));
  const folders = rollupFolders(safePairs.filter((row) => row.deletedAt === null));
  const historicalFolders = rollupFolders(safePairs);

  return {
    kind: "files", readiness: "ready", repositoryId,
    files, folders, historicalFolders, truncated,
  };
}

function resolveFileTarget(store, repositoryId, target) {
  if (typeof target.fileId === "string") {
    const id = Number(target.fileId.slice(1));
    const row = preparedStatement(store.database, "SELECT id, current_path AS path FROM files WHERE id = ? AND repository_id = ?").get(id, repositoryId);
    return row ? { fileId: row.id, currentPath: row.path } : { fileId: null, currentPath: null };
  }
  const requestedPath = target.path;
  let row = preparedStatement(store.database, "SELECT id, current_path AS path FROM files WHERE repository_id = ? AND current_path = ?").get(repositoryId, requestedPath);
  if (!row) {
    row = preparedStatement(store.database, `
      SELECT f.id AS id, f.current_path AS path
      FROM file_paths fp JOIN files f ON f.id = fp.file_id
      WHERE f.repository_id = ? AND fp.path = ?
      ORDER BY fp.valid_from DESC LIMIT 1
    `).get(repositoryId, requestedPath) || null;
  }
  return row ? { fileId: row.id, currentPath: row.path } : { fileId: null, currentPath: null };
}

function buildFileHistory(store, repositoryId, target, catalogFn, agentLabelFn) {
  const requestedPath = typeof target.path === "string" ? target.path : null;
  const resolved = resolveFileTarget(store, repositoryId, target);
  if (resolved.fileId !== null && !isSafeRecordedRepositoryPath(resolved.currentPath)) resolved.fileId = null;
  if (resolved.fileId === null) {
    return {
      kind: "history", readiness: "ready", repositoryId,
      fileId: null, path: requestedPath, sessions: [], unattributedChanges: 0, truncated: false,
    };
  }
  // Aggregate in SQLite before applying the public 100-session bound.
  const rows = preparedStatement(store.database, `
    WITH sessions AS (
      SELECT session_id AS sessionId, MAX(observed_at) AS newestAt,
             MAX(id) AS newestId,
             SUM(CASE WHEN kind = 'edited' THEN 1 ELSE 0 END) AS editCount,
             MAX(CASE WHEN kind = 'created' THEN 1 ELSE 0 END) AS createdInSession
      FROM file_changes
      WHERE file_id = ? AND session_id IS NOT NULL
      GROUP BY session_id
    )
    SELECT sessions.sessionId, sessions.newestAt, sessions.newestId,
           sessions.editCount, sessions.createdInSession, newest.kind AS newestKind
    FROM sessions
    JOIN file_changes newest ON newest.id = (
      SELECT id FROM file_changes
      WHERE file_id = ? AND session_id = sessions.sessionId
      ORDER BY observed_at DESC, id DESC LIMIT 1
    )
    ORDER BY sessions.newestAt DESC, sessions.newestId DESC
    LIMIT ?
  `).all(resolved.fileId, resolved.fileId, MAX_HISTORY_SESSIONS + 1);
  const sessionIds = rows.map((row) => row.sessionId);
  const truncated = sessionIds.length > MAX_HISTORY_SESSIONS;
  const selectedRows = rows.slice(0, MAX_HISTORY_SESSIONS);
  const selectedSessionIds = selectedRows.map((row) => row.sessionId);
  const agentIdsBySession = new Map(selectedSessionIds.map((sessionId) => [sessionId, new Set()]));
  if (selectedSessionIds.length) {
    const placeholders = selectedSessionIds.map(() => "?").join(", ");
    const agentRows = preparedStatement(store.database, `
      SELECT DISTINCT session_id AS sessionId, agent_id AS agentId
      FROM file_changes
      WHERE file_id = ? AND session_id IN (${placeholders}) AND agent_id IS NOT NULL
    `).all(resolved.fileId, ...selectedSessionIds);
    for (const row of agentRows) {
      if (typeof row.agentId === "string" && row.agentId) agentIdsBySession.get(row.sessionId)?.add(row.agentId);
    }
  }
  const unattributedChanges = preparedStatement(store.database, 
    "SELECT COUNT(*) AS count FROM file_changes WHERE file_id = ? AND session_id IS NULL",
  ).get(resolved.fileId)?.count || 0;
  const catalogById = new Map(safeArray(catalogFn).map((entry) => [entry?.id, entry]));
  const pathAtTimeStatement = preparedStatement(store.database, `
    SELECT path FROM file_paths WHERE file_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY valid_from DESC LIMIT 1
  `);
  const sessions = selectedRows.map((entry) => {
    const sessionId = entry.sessionId;
    const catalogEntry = catalogById.get(sessionId) || null;
    const provider = catalogEntry?.provider === "claude" || catalogEntry?.provider === "codex" ? catalogEntry.provider : null;
    const pathAtTimeRow = pathAtTimeStatement.get(resolved.fileId, entry.newestAt, entry.newestAt);
    const pathAtTime = pathAtTimeRow && pathAtTimeRow.path !== resolved.currentPath && isSafeRecordedRepositoryPath(pathAtTimeRow.path)
      ? pathAtTimeRow.path : null;
    return {
      sessionId,
      title: typeof catalogEntry?.title === "string" ? catalogEntry.title : null,
      provider,
      live: catalogEntry?.isLive === true,
      kind: entry.createdInSession ? "created" : entry.newestKind,
      editCount: entry.editCount,
      newestAt: isoOrNull(entry.newestAt),
      agents: historyAgents(store, sessionId, agentIdsBySession.get(sessionId), agentLabelFn),
      pathAtTime,
    };
  });

  return {
    kind: "history", readiness: "ready", repositoryId,
    fileId: `f${resolved.fileId}`, path: resolved.currentPath,
    sessions, unattributedChanges, truncated,
  };
}

export function createFileHistorySource({ monitorStoreRuntime, catalog, agentLabel, demandedSessionIds, onSessionChange, indexReady = () => true, now = Date.now } = {}) {
  if (!monitorStoreRuntime || typeof monitorStoreRuntime.registerContributor !== "function" || typeof monitorStoreRuntime.store !== "function") {
    throw new TypeError("File history source requires a monitor store runtime");
  }
  if (typeof demandedSessionIds !== "function" || typeof onSessionChange !== "function") {
    throw new TypeError("File history source requires demandedSessionIds() and onSessionChange()");
  }
  const catalogFn = typeof catalog === "function" ? catalog : () => [];
  const agentLabelFn = typeof agentLabel === "function" ? agentLabel : () => null;

  const sessionBlocks = new Map();
  const sessionSerialized = new Map();
  const pendingSessionRequests = new Set();

  const listingBlocks = new Map();
  const listingSerialized = new Map();
  const listingRevisions = new Map();
  const listingRequestedAt = new Map();

  const historyBlocks = new Map();
  const historySerialized = new Map();
  const historyRevisions = new Map();
  const historyRequestedAt = new Map();
  const historyTargets = new Map();

  function nudge() {
    try { monitorStoreRuntime.afterCheckpointWrite?.(); } catch { /* best-effort nudge */ }
  }

  function touchBounded(requestedAt, blocks, serialized, key, nowMs, maxEntries, extraMaps = []) {
    requestedAt.delete(key);
    requestedAt.set(key, nowMs);
    while (requestedAt.size > maxEntries) {
      const oldest = requestedAt.keys().next().value;
      requestedAt.delete(oldest);
      blocks.delete(oldest);
      serialized.delete(oldest);
      for (const extra of extraMaps) extra.delete(oldest);
    }
  }

  function cycleOrder(requestedAt, blocks) {
    const newestFirst = [...requestedAt.keys()].reverse();
    return [...newestFirst.filter((key) => !blocks.has(key)), ...newestFirst.filter((key) => blocks.has(key))];
  }

  function historyKey(repositoryId, target) {
    return typeof target.fileId === "string"
      ? `${repositoryId}\u0000f\u0000${target.fileId}`
      : `${repositoryId}\u0000p\u0000${target.path}`;
  }

  async function onCheckpoint(store, { now: cycleNow } = {}) {
    if (!indexReady()) return;
    const nowMs = Number.isFinite(cycleNow) ? cycleNow : now();

    let demandedIds;
    try { demandedIds = demandedSessionIds(); } catch { demandedIds = null; }
    if (Array.isArray(demandedIds)) {
      const sessionIds = [...new Set([...pendingSessionRequests, ...demandedIds])];
      for (const sessionId of sessionIds.slice(0, MAX_DEMANDED_SESSIONS_PER_CYCLE)) {
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          pendingSessionRequests.delete(sessionId);
          continue;
        }
        pendingSessionRequests.delete(sessionId);
        let nextBlock;
        try { nextBlock = buildSessionFiles(store, sessionId); } catch { continue; }
        const nextSerialized = JSON.stringify(nextBlock);
        if (sessionSerialized.get(sessionId) === nextSerialized) continue;
        sessionBlocks.set(sessionId, nextBlock);
        sessionSerialized.set(sessionId, nextSerialized);
        try { onSessionChange(sessionId); } catch { /* one failing subscriber cannot break the cycle */ }
      }
      if (pendingSessionRequests.size > 0) nudge();
    }

    for (const [key, at] of listingRequestedAt) {
      if (nowMs - at < IDLE_MS) continue;
      listingRequestedAt.delete(key); listingBlocks.delete(key); listingSerialized.delete(key); listingRevisions.delete(key);
    }
    let listingBudget = MAX_LISTING_REQUESTS_PER_CYCLE;
    for (const repositoryId of cycleOrder(listingRequestedAt, listingBlocks)) {
      if (listingBudget <= 0) break;
      listingBudget -= 1;
      let candidate;
      try { candidate = buildRepositoryListing(store, repositoryId); } catch { continue; }
      const comparable = JSON.stringify(candidate);
      if (listingSerialized.get(repositoryId) === comparable) continue;
      const revision = (listingRevisions.get(repositoryId) || 0) + 1;
      listingRevisions.set(repositoryId, revision);
      listingBlocks.set(repositoryId, Object.freeze({ ...candidate, revision }));
      listingSerialized.set(repositoryId, comparable);
    }

    for (const [key, at] of historyRequestedAt) {
      if (nowMs - at < IDLE_MS) continue;
      historyRequestedAt.delete(key); historyBlocks.delete(key); historySerialized.delete(key);
      historyRevisions.delete(key); historyTargets.delete(key);
    }
    let historyBudget = MAX_HISTORY_REQUESTS_PER_CYCLE;
    for (const key of cycleOrder(historyRequestedAt, historyBlocks)) {
      if (historyBudget <= 0) break;
      historyBudget -= 1;
      const info = historyTargets.get(key);
      if (!info) continue;
      let candidate;
      try { candidate = buildFileHistory(store, info.repositoryId, info.target, catalogFn, agentLabelFn); } catch { continue; }
      const comparable = JSON.stringify(candidate);
      if (historySerialized.get(key) === comparable) continue;
      const revision = (historyRevisions.get(key) || 0) + 1;
      historyRevisions.set(key, revision);
      historyBlocks.set(key, Object.freeze({ ...candidate, revision }));
      historySerialized.set(key, comparable);
    }
  }

  monitorStoreRuntime.registerContributor(Object.freeze({
    name: "file-history-domain",
    onCheckpoint,
    rebuildComplete: () => true,
  }));

  return Object.freeze({
    /** Pure map lookup; never touches SQLite. */
    sessionFiles(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return LOADING_SESSION_FILES;
      const override = readinessOverride(monitorStoreRuntime, indexReady);
      if (override === "unavailable") return UNAVAILABLE_SESSION_FILES;
      if (override === "rebuilding") return REBUILDING_SESSION_FILES;
      return sessionBlocks.get(sessionId) || LOADING_SESSION_FILES;
    },
    /** Queues asynchronous hydration for a newly demanded session with no block yet; never inline. */
    requestSessionFiles(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      if (sessionBlocks.has(sessionId) || pendingSessionRequests.has(sessionId)) return;
      pendingSessionRequests.add(sessionId);
      nudge();
    },
    repositoryFiles(repositoryId) {
      if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) return loadingRepositoryFiles(String(repositoryId || ""));
      touchBounded(listingRequestedAt, listingBlocks, listingSerialized, repositoryId, now(), MAX_LISTINGS, [listingRevisions]);
      const override = readinessOverride(monitorStoreRuntime, indexReady);
      if (override) return loadingRepositoryFiles(repositoryId, override);
      const block = listingBlocks.get(repositoryId);
      if (!block) { nudge(); return loadingRepositoryFiles(repositoryId, "loading"); }
      return block;
    },
    fileHistory(repositoryId, target) {
      const requestedPath = target && typeof target.path === "string" ? target.path : null;
      const validTarget = target && typeof target === "object"
        && ((typeof target.fileId === "string" && FILE_ID_PATTERN.test(target.fileId))
          || (typeof target.path === "string" && isSafeRecordedRepositoryPath(target.path)));
      if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId) || !validTarget) {
        return loadingFileHistory(String(repositoryId || ""), requestedPath);
      }
      const key = historyKey(repositoryId, target);
      historyTargets.set(key, { repositoryId, target });
      touchBounded(historyRequestedAt, historyBlocks, historySerialized, key, now(), MAX_HISTORIES, [historyRevisions, historyTargets]);
      const override = readinessOverride(monitorStoreRuntime, indexReady);
      if (override) return loadingFileHistory(repositoryId, requestedPath, override);
      const block = historyBlocks.get(key);
      if (!block) { nudge(); return loadingFileHistory(repositoryId, requestedPath, "loading"); }
      return block;
    },
  });
}

export function attachFileHistory(monitorStoreRuntime, {
  resolveRepository, checkpointStore, readRenames, now,
  catalog, agentLabel, demandedSessionIds, onSessionChange,
} = {}) {
  const index = registerFileChangeIndexContributor(monitorStoreRuntime, { resolveRepository, checkpointStore, readRenames, now });
  return createFileHistorySource({ monitorStoreRuntime, catalog, agentLabel, demandedSessionIds, onSessionChange, now,
    indexReady: () => index?.rebuildComplete() ?? true,
  });
}
