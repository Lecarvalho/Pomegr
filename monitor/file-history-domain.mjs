// Committed source for file history served from the monitor's checkpoint-backed SQLite
// index (`monitor/file-change-index.mjs`): per-session touched-file summaries (folded into
// the `repository` session domain's `fileHistory` block), a per-repository file/folder
// listing, and a per-file grouped session history. Every public lookup below is a pure
// in-memory map read; all SQLite reads happen inside the `file-history-domain` monitor-store
// contributor's `onCheckpoint`, registered after the file-change-index contributor so it
// always groups already-committed rows. See docs/OBSERVATION_CACHE.md ("Approved
// file-history persistence contract" and "Monitor SQLite store") for the runtime contract
// this follows, and AGENTS.md's "File-change history" privacy bullet for the served shape.
//
// Privacy: every response carries only normalized repository/session/agent identities, an
// opaque file identity (`f<integer>`), bounded repository-relative paths re-validated with
// `isSafeRecordedRepositoryPath`, fixed change kinds, bounded counts, and ISO timestamps.
// Never commands, tool arguments, provider paths, or transcript paths. Session and agent
// attribution appears only where a recorded `file_changes` row proves it; a Git-only move
// (source: `git` in `file_paths`) contributes path continuity only, never attribution.

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
const MAX_REPOSITORY_FILES = 5000;
const MAX_HISTORY_SESSIONS = 100;
// Defensive resource-exhaustion guards; the contract above only bounds files/sessions, not
// these intermediate row counts, so a pathological repository or file cannot balloon memory.
const MAX_FOLDER_PAIRS = 50_000;
const MAX_FILE_HISTORY_ROWS = 20_000;

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
function readinessOverride(monitorStoreRuntime) {
  if (!monitorStoreRuntime.store()) return "unavailable";
  if (storageReadinessKind(monitorStoreRuntime) === "rebuilding") return "rebuilding";
  return null;
}

/** Session files: file_changes for the session grouped by file; newest kind, count, newest time. */
function buildSessionFiles(store, sessionId) {
  const rows = store.database.prepare(`
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
  const kindStatement = store.database.prepare(
    "SELECT kind FROM file_changes WHERE file_id = ? AND session_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1",
  );
  const files = bounded.map((row) => ({
    fileId: `f${row.fileId}`,
    path: row.path,
    kind: kindStatement.get(row.fileId, sessionId)?.kind || "edited",
    changeCount: row.changeCount,
    lastObservedAt: isoOrNull(row.newestAt),
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

/** Repository listing: every file with a distinct attributed-session count, plus folder rollups. */
function buildRepositoryListing(store, repositoryId) {
  const fileRows = store.database.prepare(`
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

  const pairRows = store.database.prepare(`
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

/** Resolves a query target to a tracked file row: by ID, by current path, else by any path it ever held. */
function resolveFileTarget(store, repositoryId, target) {
  if (typeof target.fileId === "string") {
    const id = Number(target.fileId.slice(1));
    const row = store.database.prepare("SELECT id, current_path AS path FROM files WHERE id = ? AND repository_id = ?").get(id, repositoryId);
    return row ? { fileId: row.id, currentPath: row.path } : { fileId: null, currentPath: null };
  }
  const requestedPath = target.path;
  let row = store.database.prepare("SELECT id, current_path AS path FROM files WHERE repository_id = ? AND current_path = ?").get(repositoryId, requestedPath);
  if (!row) {
    row = store.database.prepare(`
      SELECT f.id AS id, f.current_path AS path
      FROM file_paths fp JOIN files f ON f.id = fp.file_id
      WHERE f.repository_id = ? AND fp.path = ?
      ORDER BY fp.valid_from DESC LIMIT 1
    `).get(repositoryId, requestedPath) || null;
  }
  return row ? { fileId: row.id, currentPath: row.path } : { fileId: null, currentPath: null };
}

/** File history: file_changes for one file grouped by session, newest first, bounded. */
function buildFileHistory(store, repositoryId, target, catalogFn, agentLabelFn) {
  const requestedPath = typeof target.path === "string" ? target.path : null;
  const resolved = resolveFileTarget(store, repositoryId, target);
  // A resolved row whose stored path fails re-validation (a corrupted or pre-validator row)
  // is served exactly like no match at all, never an unsafe path.
  if (resolved.fileId !== null && !isSafeRecordedRepositoryPath(resolved.currentPath)) resolved.fileId = null;
  if (resolved.fileId === null) {
    return {
      kind: "history", readiness: "ready", repositoryId,
      fileId: null, path: requestedPath, sessions: [], unattributedChanges: 0, truncated: false,
    };
  }
  const rows = store.database.prepare(`
    SELECT session_id AS sessionId, agent_id AS agentId, kind, observed_at AS observedAt
    FROM file_changes
    WHERE file_id = ?
    ORDER BY observed_at DESC, id DESC
    LIMIT ?
  `).all(resolved.fileId, MAX_FILE_HISTORY_ROWS);

  const bySession = new Map();
  let unattributedChanges = 0;
  for (const row of rows) {
    if (row.sessionId === null || row.sessionId === undefined) { unattributedChanges += 1; continue; }
    let entry = bySession.get(row.sessionId);
    if (!entry) {
      // Rows arrive newest-first, so a session's first occurrence here is its newest change.
      entry = { newestAt: row.observedAt, newestKind: row.kind, editCount: 0, createdInSession: false, agentIds: new Set() };
      bySession.set(row.sessionId, entry);
    }
    if (row.kind === "edited") entry.editCount += 1;
    if (row.kind === "created") entry.createdInSession = true;
    if (typeof row.agentId === "string" && row.agentId) entry.agentIds.add(row.agentId);
  }

  const sessionIds = [...bySession.keys()]; // already newest-session-first, see comment above
  const truncated = sessionIds.length > MAX_HISTORY_SESSIONS;
  const catalogById = new Map(safeArray(catalogFn).map((entry) => [entry?.id, entry]));
  const pathAtTimeStatement = store.database.prepare(`
    SELECT path FROM file_paths WHERE file_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY valid_from DESC LIMIT 1
  `);
  const sessions = sessionIds.slice(0, MAX_HISTORY_SESSIONS).map((sessionId) => {
    const entry = bySession.get(sessionId);
    const catalogEntry = catalogById.get(sessionId) || null;
    const provider = catalogEntry?.provider === "claude" || catalogEntry?.provider === "codex" ? catalogEntry.provider : null;
    const pathAtTimeRow = pathAtTimeStatement.get(resolved.fileId, entry.newestAt, entry.newestAt);
    const pathAtTime = pathAtTimeRow && pathAtTimeRow.path !== resolved.currentPath && isSafeRecordedRepositoryPath(pathAtTimeRow.path)
      ? pathAtTimeRow.path : null;
    const agents = [...entry.agentIds].map((agentId) => ({ id: agentId, label: safeAgentLabel(agentLabelFn, sessionId, agentId) }));
    return {
      sessionId,
      title: typeof catalogEntry?.title === "string" ? catalogEntry.title : null,
      provider,
      live: catalogEntry?.isLive === true,
      kind: entry.createdInSession ? "created" : entry.newestKind,
      editCount: entry.editCount,
      newestAt: isoOrNull(entry.newestAt),
      agents,
      pathAtTime,
    };
  });

  return {
    kind: "history", readiness: "ready", repositoryId,
    fileId: `f${resolved.fileId}`, path: resolved.currentPath,
    sessions, unattributedChanges, truncated,
  };
}

/**
 * Commits session/repository/file file-history blocks on the monitor-store checkpoint
 * cycle. Registers a `file-history-domain` contributor (always `rebuildComplete: true`:
 * this is a derived cache over already-committed SQLite tables, never a rebuild target
 * itself). `sessionFiles`/`repositoryFiles`/`fileHistory` are pure in-memory map reads, safe
 * to call from a serving-side GET; `repositoryFiles`/`fileHistory` self-queue hydration for a
 * missing key, and `requestSessionFiles` lets the session-domain store's `onDemand` nudge a
 * newly demanded session's first build.
 */
export function createFileHistorySource({ monitorStoreRuntime, catalog, agentLabel, demandedSessionIds, onSessionChange, now = Date.now } = {}) {
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

  // Per-cycle build order: keys with no committed block first, then rebuilds of existing
  // blocks, each newest-touched first, so a fresh selection is never starved by older keys.
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
    const nowMs = Number.isFinite(cycleNow) ? cycleNow : now();

    let sessionIds;
    try { sessionIds = demandedSessionIds(); } catch { sessionIds = null; }
    if (Array.isArray(sessionIds)) {
      for (const sessionId of sessionIds.slice(0, MAX_DEMANDED_SESSIONS_PER_CYCLE)) {
        if (typeof sessionId !== "string" || sessionId.length === 0) continue;
        pendingSessionRequests.delete(sessionId);
        let nextBlock;
        try { nextBlock = buildSessionFiles(store, sessionId); } catch { continue; }
        const nextSerialized = JSON.stringify(nextBlock);
        if (sessionSerialized.get(sessionId) === nextSerialized) continue;
        sessionBlocks.set(sessionId, nextBlock);
        sessionSerialized.set(sessionId, nextSerialized);
        try { onSessionChange(sessionId); } catch { /* one failing subscriber cannot break the cycle */ }
      }
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
    /** Pure map lookup; never touches SQLite. Safe to call from a serving-side GET. */
    sessionFiles(sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return LOADING_SESSION_FILES;
      const override = readinessOverride(monitorStoreRuntime);
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
    /** Pure map lookup; self-queues hydration and returns the loading factory on a miss. */
    repositoryFiles(repositoryId) {
      if (typeof repositoryId !== "string" || !REPOSITORY_ID_PATTERN.test(repositoryId)) return loadingRepositoryFiles(String(repositoryId || ""));
      touchBounded(listingRequestedAt, listingBlocks, listingSerialized, repositoryId, now(), MAX_LISTINGS, [listingRevisions]);
      const override = readinessOverride(monitorStoreRuntime);
      if (override) return loadingRepositoryFiles(repositoryId, override);
      const block = listingBlocks.get(repositoryId);
      if (!block) { nudge(); return loadingRepositoryFiles(repositoryId, "loading"); }
      return block;
    },
    /** Pure map lookup; self-queues hydration and returns the loading factory on a miss. */
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
      const override = readinessOverride(monitorStoreRuntime);
      if (override) return loadingFileHistory(repositoryId, requestedPath, override);
      const block = historyBlocks.get(key);
      if (!block) { nudge(); return loadingFileHistory(repositoryId, requestedPath, "loading"); }
      return block;
    },
  });
}

/**
 * Observation-runtime wiring helper: registers the file-change index contributor (unchanged
 * from before this module existed) and then this module's own `file-history-domain`
 * contributor, in that order, so `observation-runtime.mjs` replaces one call with another
 * instead of duplicating both registrations inline.
 */
export function attachFileHistory(monitorStoreRuntime, {
  resolveRepository, checkpointStore, readRenames, now,
  catalog, agentLabel, demandedSessionIds, onSessionChange,
} = {}) {
  registerFileChangeIndexContributor(monitorStoreRuntime, { resolveRepository, checkpointStore, readRenames, now });
  return createFileHistorySource({ monitorStoreRuntime, catalog, agentLabel, demandedSessionIds, onSessionChange, now });
}
