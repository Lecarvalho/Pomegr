import fs from "node:fs";
import path from "node:path";
import { repositoryRelativePath } from "../../normalize/repository-path.mjs";

function absoluteMutationTarget(target, cwd) {
  if (typeof target !== "string" || !target || /[\u0000-\u001f\u007f]/u.test(target)
    || typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  // `path.resolve` deliberately permits a tool cwd to point into a sibling
  // checkout. The binding below proves the resulting target has its own Git root.
  if (/^[A-Za-z]:(?![\\/])/u.test(target) || /^[\\/]{2}/u.test(target)) return null;
  if (target.replace(/\\/gu, "/").split("/").includes("..")) return null;
  return path.resolve(path.isAbsolute(target) ? target : path.resolve(cwd, target));
}

function nearestExistingDirectory(target) {
  let candidate = target;
  try { if (!fs.statSync(candidate).isDirectory()) candidate = path.dirname(candidate); } catch { candidate = path.dirname(candidate); }
  while (path.dirname(candidate) !== candidate) {
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* climb */ }
    candidate = path.dirname(candidate);
  }
  return null;
}

async function bindMutationTarget(target, cwd, resolver, forbiddenRoots) {
  const absolute = absoluteMutationTarget(target, cwd);
  const directory = absolute && nearestExistingDirectory(absolute);
  if (!absolute || !directory) return null;
  // Git can return a long root while the tool target uses an 8.3 alias.
  // Resolve the existing parent and retain the uncreated target suffix.
  let canonicalDirectory;
  try { canonicalDirectory = fs.realpathSync.native(directory); } catch { return null; }
  const canonicalTarget = path.resolve(canonicalDirectory, path.relative(directory, absolute));
  let resolved;
  try { resolved = await resolver(canonicalDirectory, { requireGit: true }); } catch { return null; }
  if (!resolved || typeof resolved.repositoryId !== "string" || !/^repo-[a-f0-9]{24}$/u.test(resolved.repositoryId)
    || typeof resolved.root !== "string" || !path.isAbsolute(resolved.root)
    || (resolved.recognized !== true && resolved.isGit !== true)) return null;
  const relative = path.relative(resolved.root, canonicalTarget);
  const safePath = repositoryRelativePath(relative, resolved.root, { forbiddenRoots });
  // `root` is the checkout the target is in (a linked worktree's own top level); `mainRoot` only names the repository.
  const mainRoot = typeof resolved.mainRoot === "string" && path.isAbsolute(resolved.mainRoot) ? resolved.mainRoot : resolved.root;
  return safePath ? { repositoryId: resolved.repositoryId, path: safePath, root: resolved.root, mainRoot } : null;
}

async function mapBounded(items, maximum, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, maximum), items.length) }, worker));
  return results;
}

/**
 * Resolve successful structured mutation candidates before provider evidence is
 * committed. The resolver is monitor-private and returns the inventory's HMAC
 * repository ID plus its real root; roots and source targets are discarded here.
 */
/** @param {{ resolveRepository?: (directory: string, options?: { requireGit?: boolean }) => Promise<any> | any, forbiddenRoots?: string[], onRepositoryBinding?: (binding: any) => void }} [options] */
export async function bindCodexFileChanges(calls, options = {}) {
  const { resolveRepository, forbiddenRoots = [], onRepositoryBinding } = options;
  const input = Array.isArray(calls) ? calls : [];
  const directoryResolutions = new Map();
  const resolveDirectory = (directory, resolverOptions) => {
    if (!directoryResolutions.has(directory)) {
      directoryResolutions.set(directory, Promise.resolve().then(() => resolveRepository(directory, resolverOptions)));
    }
    return directoryResolutions.get(directory);
  };
  return mapBounded(input, 4, async (call) => {
    const { fileChangeCandidates, fileChangeCwd, ...sealed } = call || {};
    if (!fileChangeCandidates?.length || typeof resolveRepository !== "function" || call?.status !== "completed") {
      return { ...sealed, fileChanges: call?.fileChanges || null };
    }
    const changes = [];
    const seen = new Set();
    for (const candidate of fileChangeCandidates.slice(0, 64)) {
      if (!candidate || !["created", "edited", "deleted", "moved"].includes(candidate.kind)) continue;
      const target = await bindMutationTarget(candidate.target, fileChangeCwd, resolveDirectory, forbiddenRoots);
      if (!target) continue;
      let previousPath = null;
      if (candidate.kind === "moved") {
        const previous = await bindMutationTarget(candidate.previousTarget, fileChangeCwd, resolveDirectory, forbiddenRoots);
        if (!previous || previous.repositoryId !== target.repositoryId) continue;
        previousPath = previous.path;
      }
      const key = `${target.repositoryId}\u0000${target.path}\u0000${candidate.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (typeof onRepositoryBinding === "function") {
        try { onRepositoryBinding({ repositoryId: target.repositoryId, root: target.root, mainRoot: target.mainRoot, recognized: true }); } catch { /* isolated private consumer */ }
      }
      changes.push({ repositoryId: target.repositoryId, path: target.path, kind: candidate.kind, previousPath });
    }
    return { ...sealed, fileChanges: changes.length ? changes : null };
  });
}
