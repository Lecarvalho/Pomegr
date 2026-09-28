import path from "node:path";
import { isLiveSessionActivity, SESSION_LIVE_WINDOW_MS, SESSION_REGISTRY_GRACE_MS, statSafe, walkJsonl } from "../session-discovery.mjs";
import { fileIdentity } from "./claude-file-generation.mjs";

const MAX_INDEX_ENTRIES = 4_096;

/**
 * A bounded sessionId -> main-file index, fed by every full discovery pass
 * the Claude provider already runs (`listSessions`, `readSession`'s own
 * fallback, `observerSource`). It exists so a `readSession` call for an
 * already-known session never has to re-walk `~/.claude/projects` (391
 * files/88 ms on a real profile) just to find one file it has already seen.
 *
 * This module never walks a directory tree itself: `index()` only records
 * what a caller's own walk already found, and `locate()` only verifies one
 * candidate file with a single `stat`.
 */
export function createClaudeSessionLocator() {
  /** @type {Map<string, {file: string, identity: string}>} */
  const bySessionId = new Map();

  return Object.freeze({
    /** Record every `{file}` a full discovery pass just found. */
    index(files) {
      // Discovery lists newest activity first. Walking it backwards makes the newest
      // copy of a duplicated session ID win, as discovery's first match does, and
      // leaves the newest sessions last in insertion order, so eviction drops the oldest.
      for (const entry of [...(Array.isArray(files) ? files : [])].reverse()) {
        const file = entry?.file;
        if (typeof file !== "string" || !file) continue;
        const stat = statSafe(file);
        if (!stat) continue;
        const sessionId = path.basename(file, ".jsonl");
        bySessionId.delete(sessionId);
        bySessionId.set(sessionId, { file, identity: fileIdentity(stat) });
      }
      while (bySessionId.size > MAX_INDEX_ENTRIES) bySessionId.delete(bySessionId.keys().next().value);
    },
    /**
     * The verified, current main file for this session, or null on a miss
     * (never indexed) or a stale entry (the file at that path is gone or is
     * now a different file — a replacement, not an append). A stale entry is
     * dropped so a caller's own full discovery can re-establish it.
     */
    locate(sessionId) {
      const entry = bySessionId.get(sessionId);
      if (!entry) return null;
      const stat = statSafe(entry.file);
      if (!stat || fileIdentity(stat) !== entry.identity) {
        bySessionId.delete(sessionId);
        return null;
      }
      return entry.file;
    },
    forget(sessionId) { bySessionId.delete(sessionId); },
    size() { return bySessionId.size; },
  });
}

/**
 * The single-file equivalent of `liveSessionFiles` from `session-discovery.mjs`,
 * for one already-resolved main file, so the fast lookup above never needs a
 * full-catalog liveness comparison to answer the same `historical` question
 * `discoveredSessions()` would. Semantics are copied, not reinterpreted:
 * an explicit session is live only if it is the selected file; a registered
 * session is always live; a session the registry has recorded closed is
 * never live; otherwise liveness follows recorded activity (the main file's
 * own mtime and every file under its own `subagents` tree) within the same
 * registry-aware window `liveSessionFiles` uses.
 *
 * @param {string} file
 * @param {{explicitFile?: string | null, registrySessionIds?: Iterable<string>, closedSessionIds?: Set<string>, registryAvailable?: boolean, nowMs?: number, agentDir?: string}} [options]
 */
export function isClaudeSessionFileLive(file, {
  explicitFile = null,
  registrySessionIds,
  closedSessionIds = new Set(),
  registryAvailable = false,
  nowMs = Date.now(),
  agentDir,
} = {}) {
  if (explicitFile) return file === explicitFile;
  const sessionId = path.basename(file, ".jsonl");
  const registered = new Set(registrySessionIds || []);
  if (registered.has(sessionId)) return true;
  if (closedSessionIds.has(sessionId)) return false;
  let activityMs = statSafe(file)?.mtimeMs || 0;
  for (const child of walkJsonl(agentDir)) {
    const childMtimeMs = statSafe(child)?.mtimeMs || 0;
    if (childMtimeMs > activityMs) activityMs = childMtimeMs;
  }
  return isLiveSessionActivity(activityMs, nowMs, registryAvailable ? SESSION_REGISTRY_GRACE_MS : SESSION_LIVE_WINDOW_MS);
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Resolves one session's main file, live/historical state and registry snapshot:
 * from the verified index when it knows the session, otherwise from the caller's
 * full discovery. The explicit session file and malformed IDs always take discovery.
 */
export function createClaudeSessionResolver({ locator, discover, readRegistry, explicitFile, registryAvailable, now, selectFile }) {
  return (localSessionId) => {
    const explicit = explicitFile();
    const indexed = localSessionId && SESSION_ID_PATTERN.test(localSessionId)
      && !(explicit && path.basename(explicit, ".jsonl") === localSessionId)
      ? locator.locate(localSessionId)
      : null;
    if (indexed) {
      const { registry, closedSessionIds } = readRegistry();
      const historical = !isClaudeSessionFileLive(indexed, {
        explicitFile: explicit,
        registrySessionIds: registry.keys(),
        closedSessionIds,
        registryAvailable: registryAvailable(),
        nowMs: now(),
        agentDir: path.join(path.dirname(indexed), path.basename(indexed, ".jsonl"), "subagents"),
      });
      return { mainFile: indexed, historical, registry };
    }
    const discovered = discover();
    const mainFile = localSessionId ? selectFile(localSessionId, discovered.files) : discovered.liveFile;
    return mainFile ? { mainFile, historical: !discovered.liveFiles.has(mainFile), registry: discovered.registry } : null;
  };
}
