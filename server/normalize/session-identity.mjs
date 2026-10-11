
import os from "node:os";
import path from "node:path";

const UNKNOWN_PROJECT = "Unknown project";
const MULTIPLE_PROJECT = "Multiple repositories";
const FALLBACK_PROJECT = "Repository";

const DEFAULT_RESOLVER_TIMEOUT_MS = 400;

function normalizeProvenRepositories(value) {
  if (!value) return [];
  const source = typeof value.values === "function" ? value.values() : value;
  const result = [];
  for (const entry of source) {
    if (entry && typeof entry.repositoryId === "string" && entry.repositoryId
      && typeof entry.root === "string" && entry.root) {
      result.push(entry);
    }
  }
  return result;
}

function namingRoot(entry) {
  return typeof entry?.mainRoot === "string" && entry.mainRoot ? entry.mainRoot : entry.root;
}

function sameCheckout(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function basenameOf(directory) {
  if (typeof directory !== "string" || !directory) return "";
  const trimmed = directory.replace(/[\\/]+$/u, "");
  const segments = trimmed.split(/[\\/]+/u).filter(Boolean);
  return segments.at(-1) || "";
}

const MAX_DISPLAY_NAME = 128;
const HOME_DIRECTORY = (() => { try { return path.resolve(os.homedir()).toLowerCase(); } catch { return ""; } })();

function launchDirectoryName(directory) {
  if (typeof directory !== "string" || !directory || /[\u0000-\u001f\u007f]/u.test(directory)) return "";
  const segments = directory.replace(/[\\/]+$/u, "").split(/[\\/]+/u).filter(Boolean);
  if (/^[\\/]{2}/u.test(directory) && segments.length <= 2) return "";
  try { if (HOME_DIRECTORY && path.resolve(directory).toLowerCase() === HOME_DIRECTORY) return ""; } catch { return ""; }
  const name = segments.at(-1) || "";
  if (!name || name.length > MAX_DISPLAY_NAME || name.startsWith(".") || /^[a-z]:$/iu.test(name) || /[<>:"|?*]/u.test(name)) return "";
  return name;
}

const UNANSWERED = Symbol("unanswered");

function boundedResolve(resolveRepository, cwd, options, timeoutMs) {
  const settled = Promise.resolve()
    .then(() => resolveRepository(cwd, options))
    .catch(() => UNANSWERED);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return settled;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(UNANSWERED), timeoutMs);
    settled.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

/**
 * @param {{
 *   launchCwd?: string|null,
 *   recordedBranch?: string|null,
 *   provenRepositories?: Map<string, { repositoryId: string, root: string, mainRoot?: string }> | Iterable<{ repositoryId: string, root: string, mainRoot?: string }> | null,
 *   resolveRepository?: (cwd: string, options?: { requireGit?: boolean }) => Promise<{ repositoryId: string, root: string, mainRoot?: string } | null> | { repositoryId: string, root: string, mainRoot?: string } | null,
 *   resolverTimeoutMs?: number,
 * }} [input]
 * @returns {Promise<{ state: "single"|"multiple"|"unknown", repositoryId: string|null, project: string, recordedBranch: string|null, root: string|null }>}
 */
export async function resolveSessionIdentity({
  launchCwd = null,
  recordedBranch = null,
  provenRepositories = null,
  resolveRepository = null,
  resolverTimeoutMs = DEFAULT_RESOLVER_TIMEOUT_MS,
} = {}) {
  const canResolve = typeof resolveRepository === "function";
  const hasLaunchCwd = typeof launchCwd === "string" && launchCwd.length > 0;
  const proven = normalizeProvenRepositories(provenRepositories);
  const distinctIds = [...new Set(proven.map((entry) => entry.repositoryId))];

  if (distinctIds.length >= 2) {
    return { state: "multiple", repositoryId: null, project: MULTIPLE_PROJECT, recordedBranch: null, root: null };
  }

  const provenMatch = distinctIds.length === 1 ? proven.find((entry) => entry.repositoryId === distinctIds[0]) : null;

  const hasBranchCandidate = typeof recordedBranch === "string" && recordedBranch.length > 0;
  // The Git lookup and the branch check's launch identity run together, never in sequence.
  const [launchRepository, launchIdentity] = await Promise.all([
    !provenMatch && hasLaunchCwd && canResolve
      ? boundedResolve(resolveRepository, launchCwd, { requireGit: true }, resolverTimeoutMs) : UNANSWERED,
    hasBranchCandidate && hasLaunchCwd && canResolve
      ? boundedResolve(resolveRepository, launchCwd, {}, resolverTimeoutMs) : UNANSWERED,
  ]);

  const resolved = provenMatch
    ? { repositoryId: provenMatch.repositoryId, root: provenMatch.root, namingRoot: namingRoot(provenMatch) }
    : (launchRepository && launchRepository !== UNANSWERED && typeof launchRepository.repositoryId === "string" && typeof launchRepository.root === "string"
      ? { repositoryId: launchRepository.repositoryId, root: launchRepository.root, namingRoot: namingRoot(launchRepository) }
      : null);

  if (!resolved) {
    const answeredNotGit = !provenMatch && hasLaunchCwd && canResolve && launchRepository !== UNANSWERED;
    return { state: "unknown", repositoryId: null, project: (answeredNotGit && launchDirectoryName(launchCwd)) || UNKNOWN_PROJECT, recordedBranch: null, root: null };
  }

  const validatedBranch = hasBranchCandidate && launchIdentity !== UNANSWERED
    && launchIdentity?.repositoryId === resolved.repositoryId
    && (typeof launchIdentity.root !== "string" || sameCheckout(launchIdentity.root, resolved.root)) ? recordedBranch : null;

  return {
    state: "single",
    repositoryId: resolved.repositoryId,
    project: basenameOf(resolved.namingRoot) || FALLBACK_PROJECT,
    recordedBranch: validatedBranch,
    root: resolved.root,
  };
}

/**
 * @param {(cwd: string, options?: { requireGit?: boolean }) => unknown} resolveRepository
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
export function memoizeRepositoryResolver(resolveRepository, { ttlMs = 300_000, maxEntries = 256, now = Date.now } = {}) {
  const entries = new Map();
  return function memoizedResolveRepository(/** @type {string} */ cwd, /** @type {{ requireGit?: boolean }} */ options = {}) {
    const key = `${options?.requireGit ? 1 : 0}\u0000${cwd}`;
    const cached = entries.get(key);
    if (cached && now() - cached.at < ttlMs) return cached.value;
    const value = Promise.resolve().then(() => resolveRepository(cwd, options));
    const entry = { at: now(), value };
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    value.catch(() => { if (entries.get(key) === entry) entries.delete(key); });
    return value;
  };
}
