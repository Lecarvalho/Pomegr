import fs from "node:fs";
import path from "node:path";

export const SESSION_LIVE_WINDOW_MS = 5 * 60_000;
export const SESSION_REGISTRY_GRACE_MS = 15_000;

export function walkJsonl(root, maxDepth = 6, depth = 0) {
  if (!root || !fs.existsSync(root) || depth > maxDepth) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...walkJsonl(full, maxDepth, depth + 1));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(full);
  }
  return results;
}

export function statSafe(file) {
  try { return fs.statSync(file); } catch { return null; }
}

export function isLiveSessionActivity(activityMs, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
  return Number.isFinite(activityMs)
    && activityMs > 0
    && nowMs - activityMs <= windowMs;
}

export function liveSessionFiles(files, registrySessionIds, {
  explicitFile = null,
  registryAvailable = false,
  closedSessionIds = new Set(),
  nowMs = Date.now(),
} = {}) {
  if (explicitFile) return new Set([explicitFile]);
  const registered = new Set(registrySessionIds || []);
  return new Set(files.filter(({ file, activityMs }) => {
    const sessionId = path.basename(file, ".jsonl");
    if (registered.has(sessionId)) return true;
    if (closedSessionIds.has(sessionId)) return false;
    return isLiveSessionActivity(activityMs, nowMs, registryAvailable ? SESSION_REGISTRY_GRACE_MS : SESSION_LIVE_WINDOW_MS);
  }).map(({ file }) => file));
}

export function repositoryProjectName(cwd) {
  if (!cwd) return "";
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return path.basename(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.basename(path.resolve(cwd));
}

export function findLatestSession(projectsRoot, explicitSession) {
  if (explicitSession && fs.existsSync(explicitSession)) return explicitSession;

  return listSessionFiles(projectsRoot)[0]?.file || null;
}

export function listSessionFiles(projectsRoot) {
  const marker = `${path.sep}subagents${path.sep}`;
  const primaryFiles = new Set();
  const activityByPrimary = new Map();

  for (const file of walkJsonl(projectsRoot)) {
    const stat = statSafe(file);
    if (!stat) continue;
    const markerIndex = file.indexOf(marker);
    const primaryFile = markerIndex >= 0
      ? `${file.slice(0, markerIndex)}.jsonl`
      : file;

    if (markerIndex < 0) primaryFiles.add(file);
    activityByPrimary.set(
      primaryFile,
      Math.max(activityByPrimary.get(primaryFile) || 0, stat.mtimeMs),
    );
  }

  return [...primaryFiles]
    .map((file) => ({ file, activityMs: activityByPrimary.get(file) || 0 }))
    .sort((a, b) => b.activityMs - a.activityMs);
}

export function findSessionById(projectsRoot, sessionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId || "")) return null;
  return listSessionFiles(projectsRoot)
    .find(({ file }) => path.basename(file, ".jsonl") === sessionId)?.file || null;
}

/**
 * The single-file equivalent of `liveSessionFiles` above, for one already-resolved main
 * file, so a fast lookup (e.g. through a session-to-file index) never needs a full-catalog
 * liveness comparison to answer the same `historical` question `liveSessionFiles` would.
 * Semantics are copied, not reinterpreted: an explicit session is live only if it is the
 * selected file; a registered session is always live; a session the registry has recorded
 * closed is never live; otherwise liveness follows recorded activity (the main file's own
 * mtime and every file under its own `subagents` tree) within the same registry-aware
 * window `liveSessionFiles` uses.
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
