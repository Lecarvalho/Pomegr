import fs from "node:fs";
import path from "node:path";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\\\\[.?][\\/])/u;
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/u;
const PRIVATE_ROOTS = new Set([".claude", ".codex"]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
/** Cached validator defaults; the final TTL is a security-review decision, not a perf tuning knob. */
export const DEFAULT_REPOSITORY_PATH_CACHE_TTL_MS = 5_000;
export const DEFAULT_REPOSITORY_PATH_CACHE_MAX_ENTRIES = 4_096;
/** The root's realpath/identity is re-checked at most this often, and never less often than the entry TTL. */
export const DEFAULT_ROOT_IDENTITY_RECHECK_MS = 1_000;
const MAX_MEMOIZED_ROOTS = 64;

function containedBy(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function realPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function isWindowsDeviceSegment(segment) {
  // Windows ignores a final run of spaces and periods before resolving a name.
  const normalized = segment.replace(/[. ]+$/u, "");
  const basename = normalized.split(".", 1)[0].replace(/[. ]+$/u, "");
  return WINDOWS_DEVICE.test(normalized) || WINDOWS_DEVICE.test(basename);
}

function existingPathStaysContained(root, target, segments, forbiddenRoots) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      fs.lstatSync(current);
    } catch (error) {
      // A missing final path is valid only while its known parent was contained.
      if (error && error.code === "ENOENT") return true;
      return false;
    }
    const resolved = realPath(current);
    if (!resolved || !containedBy(root, resolved)) return false;
    if (forbiddenRoots.some((forbiddenRoot) => containedBy(forbiddenRoot, resolved))) return false;
  }
  return containedBy(root, target);
}

/**
 * Every rejection here needs no filesystem access and is root-independent (aside from the root's
 * own shape): control characters, non-relative/absolute spellings, traversal segments, reserved
 * Windows device names, and caller-private root segments. These are already as cheap as a cache
 * lookup, so a cached validator never needs to cache them -- it can fail the same way immediately.
 * Returns the normalized slash segments on success, or null on syntax rejection.
 */
function syntaxCheckedSegments(value, repositoryRoot, forbiddenRoots) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || CONTROL.test(value)) return null;
  if (typeof repositoryRoot !== "string" || repositoryRoot.length < 1 || repositoryRoot.length > 32_768
    || CONTROL.test(repositoryRoot) || !path.isAbsolute(repositoryRoot)) return null;
  if (!Array.isArray(forbiddenRoots)) return null;
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || WINDOWS_ABSOLUTE.test(value) || DRIVE_RELATIVE.test(value)) return null;
  const segments = value.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":")
    || WINDOWS_DEVICE.test(segment) || isWindowsDeviceSegment(segment) || /[. ]$/u.test(segment))) return null;
  if (segments.some((segment) => PRIVATE_ROOTS.has(segment.toLowerCase()))) return null;
  return segments;
}

/**
 * Validate one repository-relative path against a recognized monitor-private
 * repository root. The returned slash-separated path is safe for committed
 * normalized evidence; the root and source spelling stay private.
 */
export function repositoryRelativePath(value, repositoryRoot, options = {}) {
  const forbiddenRoots = options?.forbiddenRoots ?? [];
  const segments = syntaxCheckedSegments(value, repositoryRoot, forbiddenRoots);
  if (!segments) return null;
  const root = path.resolve(repositoryRoot);
  const resolvedRoot = realPath(root);
  if (!resolvedRoot) return null;
  const target = path.resolve(root, ...segments);
  if (!containedBy(root, target)) return null;
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  const resolvedForbiddenRoots = [];
  for (const forbiddenRoot of forbiddenRoots) {
    if (typeof forbiddenRoot !== "string" || forbiddenRoot.length < 1 || CONTROL.test(forbiddenRoot)
      || !path.isAbsolute(forbiddenRoot)) return null;
    const forbidden = path.resolve(forbiddenRoot);
    if (containedBy(forbidden, target)) return null;
    const resolvedForbidden = realPath(forbidden);
    if (resolvedForbidden) resolvedForbiddenRoots.push(resolvedForbidden);
  }
  if (!existingPathStaysContained(resolvedRoot, resolvedTarget, segments, resolvedForbiddenRoots)) return null;
  return segments.join("/");
}

export function isRepositoryRelativePath(value, repositoryRoot, options) {
  return repositoryRelativePath(value, repositoryRoot, options) !== null;
}

/** One realpath + stat of the recognized root; a changed root yields a different identity. */
function currentRootIdentity(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) return null;
  const resolvedRoot = realPath(path.resolve(repositoryRoot));
  if (!resolvedRoot) return null;
  let stat;
  try { stat = fs.statSync(resolvedRoot); } catch { return null; }
  const inode = Number.isFinite(stat.ino) && stat.ino > 0 ? stat.ino : null;
  const identity = inode !== null
    ? `${stat.dev}:${inode}`
    : `birth:${Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : "unknown"}:${stat.mtimeMs}`;
  return { resolvedRoot, identity };
}

/**
 * A TTL-bounded cache in front of `repositoryRelativePath` for a caller that revalidates the same
 * (root, value) pair repeatedly on a hot path -- one file-change candidate per successful tool call
 * is the motivating case. The recognized root's realpath and stat identity are re-checked at most
 * once per `rootRecheckMs` (never per path segment, and never less often than the entry TTL); a
 * root whose realpath or identity changed produces a different cache key, so its prior entries are
 * never served after that re-check. An unresolvable root is never memoized. A rejection is cached as a
 * rejection for the same TTL as an acceptance; only pure-syntax rejections skip the filesystem and
 * the cache entirely, since they are already cheaper than a lookup. `repositoryRelativePath` itself
 * stays uncached and unchanged for every other caller.
 */
export function createRepositoryPathValidator({
  ttlMs = DEFAULT_REPOSITORY_PATH_CACHE_TTL_MS,
  maxEntries = DEFAULT_REPOSITORY_PATH_CACHE_MAX_ENTRIES,
  now = () => Date.now(),
  rootRecheckMs = Math.min(ttlMs, DEFAULT_ROOT_IDENTITY_RECHECK_MS),
} = {}) {
  const entries = new Map();
  const rootIdentities = new Map();
  function memoizedRootIdentity(repositoryRoot, currentTime) {
    const memo = rootIdentities.get(repositoryRoot);
    if (memo && memo.checkedAt + rootRecheckMs > currentTime) return memo.identity;
    const identity = currentRootIdentity(repositoryRoot);
    rootIdentities.delete(repositoryRoot);
    if (identity) {
      rootIdentities.set(repositoryRoot, { identity, checkedAt: currentTime });
      while (rootIdentities.size > MAX_MEMOIZED_ROOTS) rootIdentities.delete(rootIdentities.keys().next().value);
    }
    return identity;
  }
  return function validateRepositoryRelativePath(value, repositoryRoot, options = {}) {
    const forbiddenRoots = options?.forbiddenRoots ?? [];
    const segments = syntaxCheckedSegments(value, repositoryRoot, forbiddenRoots);
    if (!segments) return null;
    const currentTime = now();
    const identity = memoizedRootIdentity(repositoryRoot, currentTime);
    if (!identity) return null;
    const key = `${identity.resolvedRoot}\u0000${identity.identity}\u0000${forbiddenRoots.join("\u0000")}\u0000${value}`;
    const cached = entries.get(key);
    if (cached && cached.expiresAt > currentTime) {
      entries.delete(key);
      entries.set(key, cached);
      return cached.result;
    }
    // A miss validates against the root as it is now, which may differ from the memoized
    // identity; the result is cached only under a root identity observed unchanged on both
    // sides of the validation, so a retarget and return (A -> B -> A) cannot file B's answer
    // under A's key.
    const before = currentRootIdentity(repositoryRoot);
    const result = repositoryRelativePath(value, repositoryRoot, options);
    const after = currentRootIdentity(repositoryRoot);
    if (!before || !after || before.resolvedRoot !== after.resolvedRoot || before.identity !== after.identity) {
      rootIdentities.delete(repositoryRoot);
      return result;
    }
    rootIdentities.delete(repositoryRoot);
    rootIdentities.set(repositoryRoot, { identity: after, checkedAt: currentTime });
    while (rootIdentities.size > MAX_MEMOIZED_ROOTS) rootIdentities.delete(rootIdentities.keys().next().value);
    const verifiedKey = `${after.resolvedRoot}\u0000${after.identity}\u0000${forbiddenRoots.join("\u0000")}\u0000${value}`;
    entries.delete(verifiedKey);
    entries.set(verifiedKey, { result, expiresAt: currentTime + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return result;
  };
}
