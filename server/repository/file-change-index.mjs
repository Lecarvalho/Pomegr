import path from "node:path";
import { repositoryRelativePath } from "../normalize/repository-path.mjs";
import { isSafeRecordedRepositoryPath } from "./repository-snapshot.mjs";
import { readGitRenamesAsync } from "./git-state.mjs";

const CHANGE_KINDS = new Set(["created", "edited", "deleted", "moved"]);
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const MAX_CHANGES_PER_CALL = 64;
const GIT_CHECK_MIN_INTERVAL_MS = 60_000;
const MAX_GIT_RENAMES = 512;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
// v2 stops replaying unbound Codex paths through session.cwd. Old rows can be
// attributed to the wrong checkout, so rebuilds discard this derived index.
const FILE_INDEX_VERSION = "2";

function readMeta(store, key) {
  const row = store.database.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function writeMeta(store, key, value) {
  store.database.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value);
}

function findFile(store, repositoryId, currentPath) {
  return store.database.prepare("SELECT id, deleted_at AS deletedAt FROM files WHERE repository_id = ? AND current_path = ?")
    .get(repositoryId, currentPath) || null;
}

function ensureFile(store, repositoryId, currentPath, observedAt) {
  store.database.prepare("INSERT OR IGNORE INTO files (repository_id, current_path, first_seen_at, deleted_at) VALUES (?, ?, ?, NULL)")
    .run(repositoryId, currentPath, observedAt);
  const row = findFile(store, repositoryId, currentPath);
  const openPath = store.database.prepare("SELECT 1 AS present FROM file_paths WHERE file_id = ? AND valid_to IS NULL").get(row.id);
  if (!openPath) {
    store.database.prepare("INSERT OR IGNORE INTO file_paths (file_id, path, valid_from, valid_to, source) VALUES (?, ?, ?, NULL, 'recorded')")
      .run(row.id, currentPath, observedAt);
  }
  return row;
}

function closeOpenPath(store, fileId, validTo) {
  store.database.prepare("UPDATE file_paths SET valid_to = ? WHERE file_id = ? AND valid_to IS NULL").run(validTo, fileId);
}

function openPath(store, fileId, newPath, validFrom, source) {
  store.database.prepare("INSERT OR IGNORE INTO file_paths (file_id, path, valid_from, valid_to, source) VALUES (?, ?, ?, NULL, ?)")
    .run(fileId, newPath, validFrom, source);
}

function recordChange(store, fileId, change) {
  store.database.prepare(`
    INSERT INTO file_changes (file_id, session_id, agent_id, kind, observed_at, request_number)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(fileId, change.sessionId, change.agentId, change.kind, change.observedAt);
}

/** created/edited/deleted: a single tracked path, keyed by (repository_id, current_path). */
function applyMutation(store, repositoryId, change) {
  const row = ensureFile(store, repositoryId, change.path, change.observedAt);
  if (change.kind === "deleted") {
    store.database.prepare("UPDATE files SET deleted_at = ? WHERE id = ?").run(change.observedAt, row.id);
  } else if (row.deletedAt !== null) {
    // A recorded create/edit at a path this index last saw deleted proves the file
    // currently exists again; clear the tombstone rather than leaving it stale.
    store.database.prepare("UPDATE files SET deleted_at = NULL WHERE id = ?").run(row.id);
  }
  recordChange(store, row.id, change);
}

/**
 * moved: rewrites current_path on the source file's row, closing its open `file_paths`
 * row and opening a new `shell_move` one. Continuity is skipped (the event is still
 * recorded, against whichever row already occupies the target path) whenever the source
 * identity is unknown or the target path already belongs to a different tracked file —
 * `files_repository_path` is unique on (repository_id, current_path) regardless of
 * whether that other row is live or tombstoned.
 */
function applyMove(store, repositoryId, change) {
  const source = change.previousPath ? findFile(store, repositoryId, change.previousPath) : null;
  const liveSource = source && source.deletedAt === null ? source : null;
  if (!liveSource) {
    const row = ensureFile(store, repositoryId, change.path, change.observedAt);
    if (row.deletedAt !== null) store.database.prepare("UPDATE files SET deleted_at = NULL WHERE id = ?").run(row.id);
    recordChange(store, row.id, change);
    return;
  }
  const conflict = findFile(store, repositoryId, change.path);
  if (conflict && conflict.id !== liveSource.id) {
    recordChange(store, conflict.id, change);
    return;
  }
  store.database.prepare("UPDATE files SET current_path = ?, deleted_at = NULL WHERE id = ?").run(change.path, liveSource.id);
  closeOpenPath(store, liveSource.id, change.observedAt);
  openPath(store, liveSource.id, change.path, change.observedAt, "shell_move");
  recordChange(store, liveSource.id, change);
}

/**
 * True when this exact recorded change (session, agent, kind, timestamp, path) is already
 * indexed. The path matches the file's current path or any path it ever held, so a later
 * Git or shell move does not make a replayed change look new.
 */
function isRecorded(store, repositoryId, change) {
  return Boolean(store.database.prepare(`
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

/**
 * Turns one checkpoint snapshot's `evidence.toolCalls[].fileChanges` into re-validated,
 * repository-rooted change records. The evidence side already bounds and validates each
 * entry relative to the session cwd; every path is re-validated here against the real
 * Git root before it can reach the store.
 */
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
      // An entry without its own per-call binding and no single-repository session
      // identity to fall back on (an old checkpoint, an incomplete observation, or a
      // session whose identity is multiple/unknown) is never reinterpreted through a
      // navigated cwd; see resolveSessionIdentity in server/normalize/session-identity.mjs.
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

/**
 * The fallback repository for entries with no per-call binding of their own,
 * read only from the session's own recorded identity (evidence.session.repositoryAttribution/
 * repositoryId; see server/normalize/session-identity.mjs) — never from a fresh resolveRepository(cwd)
 * call, and never gated on providerId. A multiple or unknown identity (or an evidence
 * shape recorded before this rule existed) has no fallback repository. Legacy "launch"
 * evidence (repository-snapshot.mjs withLegacyRepositoryAttribution) is resolved from its
 * launch cwd in applySnapshot, exactly as before the rule.
 */
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
  // Only fetch the real root (needed to rebase an unbound path) once the session's own
  // identity already proved a single repository, or its legacy evidence was launch-bound.
  // A proven identity is never re-derived: a cwd that resolves elsewhere supplies no root.
  let root = "";
  if ((fallbackRepositoryId || legacyLaunch) && typeof cwd === "string" && cwd) {
    try {
      // The inventory's cached lookup (no Git subprocess per snapshot). A proven identity
      // accepts only the root of the same repository ID; launch evidence also accepts the
      // non-Git fallback root, as before the rule.
      const resolved = await resolveRepository(cwd);
      const resolvedId = typeof resolved?.repositoryId === "string" ? resolved.repositoryId : "";
      if (legacyLaunch && resolvedId) fallbackRepositoryId = resolvedId;
      if (resolvedId && resolvedId === fallbackRepositoryId && typeof resolved.root === "string" && resolved.root) root = resolved.root;
    } catch { root = ""; }
  }
  if (!hasBoundChanges && !fallbackRepositoryId) return;
  const sessionId = `${providerId}:${localSessionId}`;
  const changes = collectChanges(snapshot, sessionId, root, cwd || "", fallbackRepositoryId);
  // Additive: live evidence is a bounded tail (Claude transcript tail, Codex tool-call cap),
  // so a snapshot that no longer carries early tool calls must never delete their committed
  // rows. Already-recorded changes are skipped, which keeps replaying a checkpoint idempotent.
  store.transaction(() => {
    for (const { repositoryId, change } of changes) applyChange(store, repositoryId, change);
  });
}

/**
 * Git-only rename continuity: current_path + a `git` `file_paths` row, never a
 * `file_changes` row and never session/agent/request attribution. Skipped when the
 * source path has no live tracked identity (nothing to continue) or the target path
 * already belongs to a different tracked file (would collide on the unique index).
 */
function applyGitRename(store, repositoryId, rename, observedAt) {
  if (!rename || typeof rename.from !== "string" || typeof rename.to !== "string") return;
  const source = findFile(store, repositoryId, rename.from);
  if (!source || source.deletedAt !== null) return;
  const conflict = findFile(store, repositoryId, rename.to);
  if (conflict && conflict.id !== source.id) return;
  store.database.prepare("UPDATE files SET current_path = ? WHERE id = ?").run(rename.to, source.id);
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

/**
 * Creates the monitor-store contributor that keeps `files`/`file_paths`/`file_changes`
 * in sync with committed checkpoints, plus asynchronous Git rename continuity. Registered
 * once with `monitorStoreRuntime.registerContributor`; every write happens inside
 * `store.transaction`, and the contributor never runs during a GET.
 */
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
    if (needsRebuild) {
      let loaded;
      if (checkpointStore) {
        try { loaded = await checkpointStore.load(); } catch {
          rebuildStarted = false;
          return;
        }
      }
      // v1 Codex rows were assigned through session.cwd and cannot be trusted.
      // Keep Claude's longer-lived additive history; only a database-declared
      // full rebuild clears every provider.
      store.transaction(() => {
        if (store.rebuilt === true) {
          store.database.prepare("DELETE FROM file_changes").run();
        } else if (priorVersion !== FILE_INDEX_VERSION) {
          // A v1 Codex move/delete may have rewritten the shared `files` row
          // and its path timeline before this migration starts. Removing only
          // the Codex change would leave that false path/deletion attached to
          // a surviving Claude row, so discard every identity touched by an
          // unbound legacy Codex change. Untouched Claude identities remain.
          store.database.prepare(`
            DELETE FROM file_changes
            WHERE file_id IN (
              SELECT DISTINCT file_id FROM file_changes WHERE session_id LIKE 'codex:%'
            )
          `).run();
        }
        store.database.prepare("DELETE FROM file_paths WHERE file_id NOT IN (SELECT DISTINCT file_id FROM file_changes)").run();
        store.database.prepare("DELETE FROM files WHERE id NOT IN (SELECT DISTINCT file_id FROM file_changes)").run();
      });
      for (const record of loaded?.records || []) {
        try { await applySnapshot(store, record, resolveRepository); } catch { /* one bad retained checkpoint cannot block the rest */ }
      }
    }
    store.transaction(() => writeMeta(store, "file_index_version", FILE_INDEX_VERSION));
    rebuildDone = true;
  }

  async function repositoriesInCycle(snapshots) {
    const found = new Map();
    for (const snapshot of snapshots) {
      const cwd = snapshot?.evidence?.session?.cwd;
      if (typeof cwd !== "string" || !cwd) continue;
      let resolved;
      try { resolved = await resolveRepository(cwd); } catch { resolved = null; }
      if (resolved && typeof resolved.repositoryId === "string" && resolved.repositoryId
        && typeof resolved.root === "string" && resolved.root && !found.has(resolved.repositoryId)) {
        found.set(resolved.repositoryId, resolved.root);
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
        // With no stored head yet, this is the first time the contributor has seen the
        // repository: baseline the head without applying renames (there is no prior
        // observation to continue from).
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

/**
 * Observation-runtime wiring helper: builds the contributor and registers it, unless the
 * given `repositoryInventory`-style `resolveRepository` isn't a function (a pre-this-
 * contributor test double for `repositoryInventory`), in which case it is a no-op. Keeps
 * `observation-runtime.mjs` to one call instead of duplicating this guard there.
 */
export function registerFileChangeIndexContributor(monitorStoreRuntime, { resolveRepository, checkpointStore, readRenames = readGitRenamesAsync, now } = {}) {
  if (typeof resolveRepository !== "function") return;
  const contributor = createFileChangeIndexContributor({ resolveRepository, checkpointStore, readRenames, now });
  monitorStoreRuntime.registerContributor(contributor);
  return contributor;
}

/** Newest-first, keyset-paged file-change history for one session. */
export function listSessionFileChanges(store, sessionId, { limit, before } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return [];
  const boundedLimit = normalizeLimit(limit);
  const beforeMs = Number.isSafeInteger(before) ? before : null;
  const rows = store.database.prepare(`
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

/** ID-ascending, keyset-paged file listing for one repository. */
export function listRepositoryFiles(store, repositoryId, { historical = false, limit, after } = {}) {
  if (typeof repositoryId !== "string" || repositoryId.length === 0) return [];
  const boundedLimit = normalizeLimit(limit);
  const afterId = Number.isSafeInteger(after) ? after : 0;
  const deletedClause = historical ? "" : "AND deleted_at IS NULL";
  const rows = store.database.prepare(`
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

/** Newest-first, keyset-paged change history for one file identity. */
export function fileHistory(store, fileId, { limit, before } = {}) {
  if (!Number.isSafeInteger(fileId)) return [];
  const boundedLimit = normalizeLimit(limit);
  const beforeMs = Number.isSafeInteger(before) ? before : null;
  const rows = store.database.prepare(`
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
