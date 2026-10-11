import { preparedStatement } from "../persistence/prepared-statements.mjs";
import path from "node:path";
import { repositoryRelativePath } from "../normalize/repository-path.mjs";
import { isSafeRecordedRepositoryPath } from "./repository-snapshot.mjs";
import { readGitRenamesAsync } from "./git-state.mjs";
import { recordFileChangeAgents } from "./file-change-agents.mjs";

const CHANGE_KINDS = new Set(["created", "edited", "deleted", "moved"]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const MAX_CHANGES_PER_CALL = 64;
const GIT_CHECK_MIN_INTERVAL_MS = 60_000;
const MAX_GIT_RENAMES = 512;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const FILE_INDEX_VERSION = "2";
const FILE_AGENTS_VERSION = "1";

function readMeta(store, key) {
  const row = preparedStatement(store.database, "SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function writeMeta(store, key, value) {
  preparedStatement(store.database, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function findFile(store, repositoryId, currentPath) {
  return preparedStatement(store.database, "SELECT id, deleted_at AS deletedAt FROM files WHERE repository_id = ? AND current_path = ?")
    .get(repositoryId, currentPath) || null;
}

function ensureFile(store, repositoryId, currentPath, observedAt) {
  preparedStatement(store.database, "INSERT OR IGNORE INTO files (repository_id, current_path, first_seen_at, deleted_at) VALUES (?, ?, ?, NULL)")
    .run(repositoryId, currentPath, observedAt);
  const row = findFile(store, repositoryId, currentPath);
  const openPath = preparedStatement(store.database, "SELECT 1 AS present FROM file_paths WHERE file_id = ? AND valid_to IS NULL").get(row.id);
  if (!openPath) {
    preparedStatement(store.database, "INSERT OR IGNORE INTO file_paths (file_id, path, valid_from, valid_to, source) VALUES (?, ?, ?, NULL, 'recorded')")
      .run(row.id, currentPath, observedAt);
  }
  return row;
}

function closeOpenPath(store, fileId, validTo) {
  preparedStatement(store.database, "UPDATE file_paths SET valid_to = ? WHERE file_id = ? AND valid_to IS NULL").run(validTo, fileId);
}

function openPath(store, fileId, newPath, validFrom, source) {
  preparedStatement(store.database, "INSERT OR IGNORE INTO file_paths (file_id, path, valid_from, valid_to, source) VALUES (?, ?, ?, NULL, ?)")
    .run(fileId, newPath, validFrom, source);
}

function recordChange(store, fileId, change) {
  preparedStatement(store.database, `
    INSERT INTO file_changes (file_id, session_id, agent_id, kind, observed_at, request_number)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(fileId, change.sessionId, change.agentId, change.kind, change.observedAt);
}

function applyMutation(store, repositoryId, change) {
  const row = ensureFile(store, repositoryId, change.path, change.observedAt);
  if (change.kind === "deleted") {
    preparedStatement(store.database, "UPDATE files SET deleted_at = ? WHERE id = ?").run(change.observedAt, row.id);
  } else if (row.deletedAt !== null) {
    preparedStatement(store.database, "UPDATE files SET deleted_at = NULL WHERE id = ?").run(row.id);
  }
  recordChange(store, row.id, change);
}

function applyMove(store, repositoryId, change) {
  const source = change.previousPath ? findFile(store, repositoryId, change.previousPath) : null;
  const liveSource = source && source.deletedAt === null ? source : null;
  if (!liveSource) {
    const row = ensureFile(store, repositoryId, change.path, change.observedAt);
    if (row.deletedAt !== null) preparedStatement(store.database, "UPDATE files SET deleted_at = NULL WHERE id = ?").run(row.id);
    recordChange(store, row.id, change);
    return;
  }
  const conflict = findFile(store, repositoryId, change.path);
  if (conflict && conflict.id !== liveSource.id) {
    recordChange(store, conflict.id, change);
    return;
  }
  preparedStatement(store.database, "UPDATE files SET current_path = ?, deleted_at = NULL WHERE id = ?").run(change.path, liveSource.id);
  closeOpenPath(store, liveSource.id, change.observedAt);
  openPath(store, liveSource.id, change.path, change.observedAt, "shell_move");
  recordChange(store, liveSource.id, change);
}

function isRecorded(store, repositoryId, change) {
  return Boolean(preparedStatement(store.database, `
    SELECT 1 AS present
    FROM file_changes fc
    JOIN files f ON f.id = fc.file_id
    WHERE fc.session_id = ? AND fc.agent_id = ? AND fc.kind = ? AND fc.observed_at = ?
      AND f.repository_id = ?
      AND (f.current_path = ? OR EXISTS (SELECT 1 FROM file_paths p WHERE p.file_id = f.id AND p.path = ?))
    LIMIT 1
  `).get(change.sessionId, change.agentId, change.kind, change.observedAt, repositoryId, change.path, change.path));
}

function applyChange(store, repositoryId, change) {
  if (isRecorded(store, repositoryId, change)) return;
  if (change.kind === "moved") applyMove(store, repositoryId, change);
  else applyMutation(store, repositoryId, change);
}

function rebasedPath(root, cwd, relativeToCwd) {
  const prefix = path.relative(root, cwd).split(path.sep).filter(Boolean).join("/");
  return prefix ? `${prefix}/${relativeToCwd}` : relativeToCwd;
}

function safeRebasedPath(root, cwd, relativeToCwd) {
  if (typeof relativeToCwd !== "string" || relativeToCwd.length === 0 || relativeToCwd.length > 512) return null;
  return repositoryRelativePath(rebasedPath(root, cwd, relativeToCwd), root);
}

function collectChanges(snapshot, sessionId, root, cwd, fallbackRepositoryId) {
  const toolCalls = Array.isArray(snapshot?.evidence?.toolCalls) ? snapshot.evidence.toolCalls : [];
  const changes = [];
  for (const toolCall of toolCalls) {
    const entries = Array.isArray(toolCall?.fileChanges) ? toolCall.fileChanges : [];
    if (entries.length === 0) continue;
    const observedAt = Date.parse(toolCall?.timestamp || "");
    const agentId = typeof toolCall?.actor?.id === "string" && toolCall.actor.id ? toolCall.actor.id : null;
    if (!Number.isFinite(observedAt) || !agentId) continue;
    for (const entry of entries.slice(0, MAX_CHANGES_PER_CALL)) {
      if (!entry || typeof entry !== "object" || !CHANGE_KINDS.has(entry.kind)) continue;
      const boundRepositoryId = typeof entry.repositoryId === "string" && REPOSITORY_ID.test(entry.repositoryId)
        ? entry.repositoryId : null;
      const repositoryId = boundRepositoryId || fallbackRepositoryId;
      if (!repositoryId) continue;
      const safePath = boundRepositoryId
        ? (isSafeRecordedRepositoryPath(entry.path) ? entry.path : null)
        : safeRebasedPath(root, cwd, entry.path);
      if (!safePath) continue;
      let safePreviousPath = null;
      if (entry.kind === "moved") {
        safePreviousPath = boundRepositoryId
          ? (isSafeRecordedRepositoryPath(entry.previousPath) ? entry.previousPath : null)
          : safeRebasedPath(root, cwd, entry.previousPath);
        if (!safePreviousPath) continue;
      }
      changes.push({ repositoryId, change: { sessionId, agentId, kind: entry.kind, path: safePath, previousPath: safePreviousPath, observedAt } });
    }
  }
  return changes;
}

function sessionFallbackRepositoryId(snapshot) {
  const session = snapshot?.evidence?.session;
  return session?.repositoryAttribution === "single" && REPOSITORY_ID.test(session.repositoryId || "")
    ? session.repositoryId : "";
}

async function applySnapshot(store, snapshot, resolveRepository) {
  const providerId = snapshot?.providerId;
  const localSessionId = snapshot?.localSessionId;
  const cwd = snapshot?.evidence?.session?.cwd;
  if (typeof providerId !== "string" || !providerId || typeof localSessionId !== "string" || !localSessionId) return;
  const hasBoundChanges = Array.isArray(snapshot?.evidence?.toolCalls) && snapshot.evidence.toolCalls
    .some((call) => Array.isArray(call?.fileChanges) && call.fileChanges.some((entry) => REPOSITORY_ID.test(entry?.repositoryId || "")));
  const legacyLaunch = snapshot?.evidence?.session?.repositoryAttribution === "launch";
  let fallbackRepositoryId = sessionFallbackRepositoryId(snapshot);
  if (!hasBoundChanges && !fallbackRepositoryId && !legacyLaunch) return;
  let root = "";
  if ((fallbackRepositoryId || legacyLaunch) && typeof cwd === "string" && cwd) {
    try {
      const resolved = await resolveRepository(cwd);
      const resolvedId = typeof resolved?.repositoryId === "string" ? resolved.repositoryId : "";
      if (legacyLaunch && resolvedId) fallbackRepositoryId = resolvedId;
      if (resolvedId && resolvedId === fallbackRepositoryId && typeof resolved.root === "string" && resolved.root) root = resolved.root;
    } catch { root = ""; }
  }
  if (!hasBoundChanges && !fallbackRepositoryId) return;
  const sessionId = `${providerId}:${localSessionId}`;
  const changes = collectChanges(snapshot, sessionId, root, cwd || "", fallbackRepositoryId);
  const agentIds = new Set(changes.map(({ change }) => change.agentId));
  const observedAt = Math.max(0, ...changes.map(({ change }) => change.observedAt));
  store.transaction(() => {
    for (const { repositoryId, change } of changes) applyChange(store, repositoryId, change);
    recordFileChangeAgents(store, sessionId, agentIds, snapshot?.publicState?.agents, observedAt);
  });
}

function applyGitRename(store, repositoryId, rename, observedAt) {
  if (!rename || typeof rename.from !== "string" || typeof rename.to !== "string") return;
  const source = findFile(store, repositoryId, rename.from);
  if (!source || source.deletedAt !== null) return;
  const conflict = findFile(store, repositoryId, rename.to);
  if (conflict && conflict.id !== source.id) return;
  preparedStatement(store.database, "UPDATE files SET current_path = ? WHERE id = ?").run(rename.to, source.id);
  closeOpenPath(store, source.id, observedAt);
  openPath(store, source.id, rename.to, observedAt, "git");
}

function normalizeLimit(limit) {
  const value = Number.isSafeInteger(limit) ? limit : DEFAULT_LIMIT;
  return Math.min(Math.max(value, 1), MAX_LIMIT);
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function createFileChangeIndexContributor({ resolveRepository, checkpointStore, readRenames, now = Date.now } = {}) {
  if (typeof resolveRepository !== "function") {
    throw new TypeError("File-change index contributor requires resolveRepository");
  }
  let rebuildStarted = false;
  let rebuildDone = false;
  const gitCheckedAt = new Map();

  async function ensureRebuilt(store) {
    if (rebuildDone || rebuildStarted) return;
    rebuildStarted = true;
    const priorVersion = readMeta(store, "file_index_version");
    const needsRebuild = store.rebuilt === true || priorVersion !== FILE_INDEX_VERSION;
    const needsAgentBackfill = readMeta(store, "file_agents_version") !== FILE_AGENTS_VERSION;
    if (needsRebuild || needsAgentBackfill) {
      let loaded;
      if (checkpointStore) {
        try { loaded = await checkpointStore.load(); } catch {
          rebuildStarted = false;
          return;
        }
      }
      // v1 Codex rows were assigned through session.cwd and cannot be trusted.
      if (needsRebuild) store.transaction(() => {
        if (store.rebuilt === true) {
          preparedStatement(store.database, "DELETE FROM file_changes").run();
        } else if (priorVersion !== FILE_INDEX_VERSION) {
          preparedStatement(store.database, `
            DELETE FROM file_changes
            WHERE file_id IN (
              SELECT DISTINCT file_id FROM file_changes WHERE session_id LIKE 'codex:%'
            )
          `).run();
        }
        preparedStatement(store.database, "DELETE FROM file_paths WHERE file_id NOT IN (SELECT DISTINCT file_id FROM file_changes)").run();
        preparedStatement(store.database, "DELETE FROM files WHERE id NOT IN (SELECT DISTINCT file_id FROM file_changes)").run();
        preparedStatement(store.database, `
          DELETE FROM file_change_agents
          WHERE NOT EXISTS (
            SELECT 1 FROM file_changes fc
            WHERE fc.session_id = file_change_agents.session_id AND fc.agent_id = file_change_agents.agent_id
          )
        `).run();
      });
      for (const record of loaded?.records || []) {
        try { await applySnapshot(store, record, resolveRepository); } catch { /* one bad retained checkpoint cannot block the rest */ }
      }
    }
    store.transaction(() => {
      writeMeta(store, "file_index_version", FILE_INDEX_VERSION);
      writeMeta(store, "file_agents_version", FILE_AGENTS_VERSION);
    });
    rebuildDone = true;
  }

  async function repositoriesInCycle(snapshots) {
    const found = new Map();
    for (const snapshot of snapshots) {
      const cwd = snapshot?.evidence?.session?.cwd;
      if (typeof cwd !== "string" || !cwd) continue;
      let resolved;
      try { resolved = await resolveRepository(cwd); } catch { resolved = null; }
      const root = typeof resolved?.mainRoot === "string" && resolved.mainRoot ? resolved.mainRoot : resolved?.root;
      if (resolved && typeof resolved.repositoryId === "string" && resolved.repositoryId
        && typeof root === "string" && root && !found.has(resolved.repositoryId)) {
        found.set(resolved.repositoryId, root);
      }
    }
    return found;
  }

  async function applyGitContinuity(store, snapshots, nowMs) {
    if (typeof readRenames !== "function") return;
    const repositories = await repositoriesInCycle(snapshots);
    for (const [repositoryId, root] of repositories) {
      // -Infinity (never checked) so a caller-supplied nowMs of 0 still runs the first check.
      const lastChecked = gitCheckedAt.has(repositoryId) ? gitCheckedAt.get(repositoryId) : -Infinity;
      if (nowMs - lastChecked < GIT_CHECK_MIN_INTERVAL_MS) continue;
      gitCheckedAt.set(repositoryId, nowMs);
      const storedHead = readMeta(store, `git_head:${repositoryId}`);
      let result;
      try { result = await readRenames(root, { sinceHead: storedHead || undefined }); } catch { continue; }
      if (!result || typeof result.head !== "string" || !result.head) continue;
      store.transaction(() => {
        if (storedHead) {
          const renames = Array.isArray(result.renames) ? result.renames.slice(0, MAX_GIT_RENAMES) : [];
          for (const rename of renames) applyGitRename(store, repositoryId, rename, nowMs);
        }
        writeMeta(store, `git_head:${repositoryId}`, result.head);
      });
    }
  }

  return {
    name: "file-changes",
    async onCheckpoint(store, { now: cycleNow, snapshots } = {}) {
      const nowMs = Number.isFinite(cycleNow) ? cycleNow : now();
      await ensureRebuilt(store);
      const queued = Array.isArray(snapshots) ? snapshots : [];
      for (const snapshot of queued) await applySnapshot(store, snapshot, resolveRepository);
      await applyGitContinuity(store, queued, nowMs);
    },
    rebuildComplete: () => rebuildDone,
  };
}

export function registerFileChangeIndexContributor(monitorStoreRuntime, { resolveRepository, checkpointStore, readRenames = readGitRenamesAsync, now } = {}) {
  if (typeof resolveRepository !== "function") return;
  const contributor = createFileChangeIndexContributor({ resolveRepository, checkpointStore, readRenames, now });
  monitorStoreRuntime.registerContributor(contributor);
  return contributor;
}

export function listSessionFileChanges(store, sessionId, { limit, before } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return [];
  const boundedLimit = normalizeLimit(limit);
  const beforeMs = Number.isSafeInteger(before) ? before : null;
  const rows = preparedStatement(store.database, `
    SELECT fc.id AS id, fc.kind AS kind, fc.observed_at AS observedAt, fc.agent_id AS agentId,
           fc.request_number AS requestNumber, f.id AS fileId, f.current_path AS path
    FROM file_changes fc
    JOIN files f ON f.id = fc.file_id
    WHERE fc.session_id = ? AND (? IS NULL OR fc.observed_at < ?)
    ORDER BY fc.observed_at DESC, fc.id DESC
    LIMIT ?
  `).all(sessionId, beforeMs, beforeMs, boundedLimit);
  return rows.map((row) => ({
    id: row.id, fileId: row.fileId, path: row.path, kind: row.kind,
    observedAt: isoOrNull(row.observedAt), agentId: row.agentId ?? null, requestNumber: row.requestNumber ?? null,
  }));
}

export function listRepositoryFiles(store, repositoryId, { historical = false, limit, after } = {}) {
  if (typeof repositoryId !== "string" || repositoryId.length === 0) return [];
  const boundedLimit = normalizeLimit(limit);
  const afterId = Number.isSafeInteger(after) ? after : 0;
  const deletedClause = historical ? "" : "AND deleted_at IS NULL";
  const rows = preparedStatement(store.database, `
    SELECT id, current_path AS path, first_seen_at AS firstSeenAt, deleted_at AS deletedAt
    FROM files
    WHERE repository_id = ? AND id > ? ${deletedClause}
    ORDER BY id ASC
    LIMIT ?
  `).all(repositoryId, afterId, boundedLimit);
  return rows.map((row) => ({
    id: row.id, path: row.path, firstSeenAt: isoOrNull(row.firstSeenAt),
    deletedAt: row.deletedAt === null || row.deletedAt === undefined ? null : isoOrNull(row.deletedAt),
  }));
}

export function fileHistory(store, fileId, { limit, before } = {}) {
  if (!Number.isSafeInteger(fileId)) return [];
  const boundedLimit = normalizeLimit(limit);
  const beforeMs = Number.isSafeInteger(before) ? before : null;
  const rows = preparedStatement(store.database, `
    SELECT id, session_id AS sessionId, agent_id AS agentId, kind, observed_at AS observedAt, request_number AS requestNumber
    FROM file_changes
    WHERE file_id = ? AND (? IS NULL OR observed_at < ?)
    ORDER BY observed_at DESC, id DESC
    LIMIT ?
  `).all(fileId, beforeMs, beforeMs, boundedLimit);
  return rows.map((row) => ({
    id: row.id, sessionId: row.sessionId ?? null, agentId: row.agentId ?? null,
    kind: row.kind, observedAt: isoOrNull(row.observedAt), requestNumber: row.requestNumber ?? null,
  }));
}
