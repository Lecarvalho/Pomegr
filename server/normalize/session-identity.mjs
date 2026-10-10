/**
 * Provider-neutral session-identity rule (ACOS part 6 of plan 2026-09-27-provider-seams).
 *
 * Approved by the product owner on 2026-09-27: the directory a session started in
 * (`launchCwd`) names the project unless proven mutation evidence points elsewhere.
 * `launchCwd`/roots are monitor-private inputs; only a project label and an opaque
 * `repositoryId` are meant to reach the browser. Callers must never forward `root`
 * outside monitor-private bookkeeping.
 *
 * Decided by the product owner on 2026-10-10: a linked Git worktree belongs to its main
 * repository. The resolver answers the main repository's ID for a directory inside a
 * worktree, with `root` the worktree's own top level and `mainRoot` the main repository's
 * folder. The project label is the main repository's name; `root` stays the checkout the
 * session works in, so its Git state is read there and never from the main checkout.
 *
 * Resolution order:
 *   1. Two or more distinct proven mutation repositories -> "multiple". Permanent
 *      ambiguity: no single-repository project or Git branch summary.
 *   2. Exactly one proven mutation repository -> "single", that repository. This
 *      covers both "unchanged" (the proven repository is the launch repository) and
 *      "refine" (the proven repository differs from wherever the session launched).
 *   3. No proven mutation and `launchCwd` resolves through the repository inventory
 *      to a recognized Git repository -> "single", that repository.
 *   4. No proven mutation and the resolver answered that `launchCwd` is not inside a
 *      recognized Git repository -> "unknown", project is the launch directory's own
 *      basename when it is a safe display name (never a drive, UNC host, dot-directory,
 *      the user's home directory, control characters, or over 128 characters).
 *   5. No proven mutation and no answer (no `launchCwd`, no resolver capability, a
 *      resolver error, or a bounded timeout) -> "unknown", "Unknown project". An
 *      unanswered lookup never names a nested subdirectory of a repository.
 *
 * `recordedBranch` is kept only when it validates against the resolved root: the
 * resolver's own (non-`requireGit`) identity for `launchCwd` must match the
 * resolved repository and, when both name a root, the same checkout. A branch recorded
 * for a different launch directory than the one that was actually mutated (another
 * repository, or another checkout of the same one) is never attributed to it.
 */

import os from "node:os";
import path from "node:path";

const UNKNOWN_PROJECT = "Unknown project";
const MULTIPLE_PROJECT = "Multiple repositories";
const FALLBACK_PROJECT = "Repository";

/** A resolver call must not hang session-identity resolution: unavailable, slow,
 * or erroring resolution degrades to "not confirmed" instead of blocking. */
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

/** The folder that names a resolved repository: its main root when the resolver gave one. */
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

/** The basename of a non-Git launch directory, or "" when it is not a safe display
 * name: a drive or device root, a UNC host or share, a dot-directory (provider
 * configuration such as `.codex`), the user's home directory, control characters,
 * or more than 128 characters. */
function launchDirectoryName(directory) {
  if (typeof directory !== "string" || !directory || /[\u0000-\u001f\u007f]/u.test(directory)) return "";
  const segments = directory.replace(/[\\/]+$/u, "").split(/[\\/]+/u).filter(Boolean);
  if (/^[\\/]{2}/u.test(directory) && segments.length <= 2) return "";
  try { if (HOME_DIRECTORY && path.resolve(directory).toLowerCase() === HOME_DIRECTORY) return ""; } catch { return ""; }
  const name = segments.at(-1) || "";
  if (!name || name.length > MAX_DISPLAY_NAME || name.startsWith(".") || /^[a-z]:$/iu.test(name) || /[<>:"|?*]/u.test(name)) return "";
  return name;
}

/** Runs `resolveRepository(cwd, options)` but never lets it block past `timeoutMs`,
 * and never lets it reject: an unavailable, slow, or erroring resolver call simply
 * cannot confirm anything, which the caller treats the same as "not proven". The
 * underlying call keeps running in the background (its result is only dropped, not
 * cancelled), so a resolver's own cache can still warm up for the next call. */
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
    // Only an answered "not a Git repository" names the launch directory itself; an
    // unanswered lookup (none possible, error, timeout) could be a nested repository
    // subdirectory, so it stays fully unknown.
    const answeredNotGit = !provenMatch && hasLaunchCwd && canResolve && launchRepository !== UNANSWERED;
    return { state: "unknown", repositoryId: null, project: (answeredNotGit && launchDirectoryName(launchCwd)) || UNKNOWN_PROJECT, recordedBranch: null, root: null };
  }

  // One repository ID can hold several checkouts (a main checkout and its linked worktrees),
  // each on its own branch: the launch branch describes the launch checkout only.
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
 * Memoize a repository resolver per (cwd, requireGit) for catalog-header lookups:
 * concurrent and repeated rows for one launch directory share one call, and a call
 * that outlives the identity bound still fills the entry for the next poll. Entries
 * expire after `ttlMs`; a rejected call is not retained. Bounded LRU.
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
