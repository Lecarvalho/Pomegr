import fs from "node:fs";
import path from "node:path";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\\\\[.?][\\/])/u;
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/u;
const PRIVATE_ROOTS = new Set([".claude", ".codex"]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;

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
 * Validate one repository-relative path against a recognized monitor-private
 * repository root. The returned slash-separated path is safe for committed
 * normalized evidence; the root and source spelling stay private.
 */
export function repositoryRelativePath(value, repositoryRoot, options = {}) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || CONTROL.test(value)) return null;
  if (typeof repositoryRoot !== "string" || repositoryRoot.length < 1 || repositoryRoot.length > 32_768
    || CONTROL.test(repositoryRoot) || !path.isAbsolute(repositoryRoot)) return null;
  const forbiddenRoots = options?.forbiddenRoots ?? [];
  if (!Array.isArray(forbiddenRoots)) return null;
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)
    || WINDOWS_ABSOLUTE.test(value) || DRIVE_RELATIVE.test(value)) return null;
  const segments = value.replace(/\\/gu, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":")
    || WINDOWS_DEVICE.test(segment) || isWindowsDeviceSegment(segment) || /[. ]$/u.test(segment))) return null;
  if (segments.some((segment) => PRIVATE_ROOTS.has(segment.toLowerCase()))) return null;
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
