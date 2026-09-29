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
  return summarizeSessionFiles(walkJsonl(projectsRoot), statSafe);
}

function summarizeSessionFiles(walkedFiles, statFor) {
  const marker = `${path.sep}subagents${path.sep}`;
  const primaryFiles = new Set();
  const activityByPrimary = new Map();

  for (const file of walkedFiles) {
    const stat = statFor(file);
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

const DIRECTORY_SETTLE_MS = 2_000;
const FILE_STAT_BATCH = 32;

function directoryIdentity(stat) {
  return Number.isFinite(stat.ino) && stat.ino > 0 ? `${stat.dev}:${stat.ino}` : `birth:${stat.birthtimeMs}`;
}

function jsonlEntries(dirents) {
  const entries = [];
  for (const entry of dirents) {
    if (entry.isDirectory()) entries.push({ name: entry.name, directory: true });
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) entries.push({ name: entry.name, directory: false });
  }
  return entries;
}

/**
 * A `listSessionFiles` equivalent that reuses each directory's previous listing while the
 * directory's identity and modification time are unchanged. Adding, removing, or renaming an
 * entry advances its parent directory's modification time, so only changed directories are
 * read again; every transcript is still stat-ed on every pass because appends do not touch
 * the directory. A listing is trusted only once its directory had been settled for
 * `settleMs` when it was read, so a change inside the timestamp granularity is never missed.
 * Output equals `listSessionFiles` for the same tree: same traversal order, depth limit,
 * dirent classification, missing-directory handling, and thrown read errors. `listAsync`
 * does the same walk through `fs.promises`, so the event loop is free between directory
 * reads and file-stat batches. Listings live only in memory and are replaced by each
 * completed pass, so they are bounded by the current tree and never persisted or logged.
 * @param {{fs?: typeof fs, now?: () => number, settleMs?: number, maxDepth?: number}} [options]
 */
export function createSessionFileLister({ fs: operations = fs, now = Date.now, settleMs = DIRECTORY_SETTLE_MS, maxDepth = 6 } = {}) {
  let listings = new Map();

  function reusable(cached, stat) {
    return Boolean(cached) && cached.mtimeMs === stat.mtimeMs && cached.identity === directoryIdentity(stat)
      && cached.readAt - stat.mtimeMs > settleMs;
  }

  function remember(next, directory, stat, readAt, dirents) {
    const listing = { mtimeMs: stat.mtimeMs, identity: directoryIdentity(stat), readAt, entries: jsonlEntries(dirents) };
    next.set(directory, listing);
    return listing;
  }

  function walkSync(directory, depth, next, files) {
    if (!directory || depth > maxDepth) return;
    let stat;
    try { stat = operations.statSync(directory); } catch { return; }
    let listing = listings.get(directory);
    if (reusable(listing, stat)) next.set(directory, listing);
    else {
      const readAt = now();
      listing = remember(next, directory, stat, readAt, operations.readdirSync(directory, { withFileTypes: true }));
    }
    for (const entry of listing.entries) {
      const full = path.join(directory, entry.name);
      if (entry.directory) walkSync(full, depth + 1, next, files);
      else files.push(full);
    }
  }

  async function walkAsync(directory, depth, next, files) {
    if (!directory || depth > maxDepth) return;
    let stat;
    try { stat = await operations.promises.stat(directory); } catch { return; }
    let listing = listings.get(directory);
    if (reusable(listing, stat)) next.set(directory, listing);
    else {
      const readAt = now();
      listing = remember(next, directory, stat, readAt, await operations.promises.readdir(directory, { withFileTypes: true }));
    }
    for (const entry of listing.entries) {
      const full = path.join(directory, entry.name);
      if (entry.directory) await walkAsync(full, depth + 1, next, files);
      else files.push(full);
    }
  }

  return Object.freeze({
    list(projectsRoot) {
      const next = new Map();
      const files = [];
      walkSync(projectsRoot, 0, next, files);
      listings = next;
      return summarizeSessionFiles(files, (file) => {
        try { return operations.statSync(file); } catch { return null; }
      });
    },
    async listAsync(projectsRoot) {
      const next = new Map();
      const files = [];
      await walkAsync(projectsRoot, 0, next, files);
      listings = next;
      const stats = new Map();
      for (let index = 0; index < files.length; index += FILE_STAT_BATCH) {
        const batch = files.slice(index, index + FILE_STAT_BATCH);
        const results = await Promise.all(batch.map((file) => operations.promises.stat(file).catch(() => null)));
        batch.forEach((file, offset) => stats.set(file, results[offset]));
      }
      return summarizeSessionFiles(files, (file) => stats.get(file) || null);
    },
  });
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
