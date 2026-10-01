import path from "node:path";
import { readCommitsInWindow } from "./repository-snapshot.mjs";

const MISMATCH_RETRY_MS = 2_500;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

function bindingFor(sessionId, evidence, attribution) {
  const root = attribution?.root;
  const branch = attribution?.recordedBranch;
  const repositoryId = attribution?.repositoryId;
  if (attribution?.state === "single" && typeof root === "string" && root.length > 0 && root.length <= 32_768
    && path.isAbsolute(root) && !/[\u0000-\u001f\u007f]/.test(root) && REPOSITORY_ID.test(repositoryId || "")
    && typeof branch === "string" && branch.length > 0 && branch.length <= 512 && !/[\u0000-\u001f\u007f]/.test(branch)) {
    const normalizedRoot = path.normalize(root);
    return { root: normalizedRoot, repositoryId, branch, fingerprint: attribution.fingerprint || `${normalizedRoot}:${branch}`, exactRoot: true };
  }
  const cwd = evidence?.session?.cwd;
  const recordedBranch = evidence?.session?.recordedGitBranch;
  if (!String(sessionId).startsWith("claude:") || typeof cwd !== "string" || cwd.length === 0 || cwd.length > 32_768
    || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd) || typeof recordedBranch !== "string"
    || recordedBranch.length === 0 || recordedBranch.length > 512 || /[\u0000-\u001f\u007f]/.test(recordedBranch)) return null;
  const normalizedRoot = path.normalize(cwd);
  // A launch directory the shared identity rule proved to be one repository records that
  // repository's ID on the sidecar, so repository-snapshot.mjs serves it for the session.
  const session = evidence.session;
  const provenRepositoryId = session.repositoryAttribution === "single" && REPOSITORY_ID.test(session.repositoryId || "") ? session.repositoryId : null;
  return { root: normalizedRoot, repositoryId: provenRepositoryId, branch: recordedBranch, fingerprint: `claude:${normalizedRoot}:${recordedBranch}`, exactRoot: false };
}

function sameRoot(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.normalize(left); const b = path.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Live repository readiness from the enrichment check state:
 * - `none`: no repository binding to check; a factual empty result (`ready`).
 * - `confirmed`: Git answered for the current binding without a matching
 *   repository (`unavailable`).
 * - `pending`: the current binding has no answer yet, or its check failed
 *   transiently (`loading`, so clients keep their last committed value).
 */
export function liveRepositoryReadiness({ historical = false, available = false, check = "pending" } = {}) {
  if (historical || available || check === "none") return "ready";
  return check === "confirmed" ? "unavailable" : "loading";
}

/** Owns only live, private Git enrichment keyed by normalized session ID. */
export function createSessionRepositoryEnrichment({ gitReader, pullRequestReader, now, cacheMs, providerFolders, unavailableGitState, unavailablePullRequests } = {}) {
  const entries = new Map();
  let onCheck = null;

  async function refresh(entry, input) {
    if (!input.root) return false;
    let repository; let resolvedRoot;
    try {
      const acquired = await gitReader(input.root, { forbiddenRoots: Object.values(providerFolders?.folders || {}).filter(Boolean) });
      const { _repositoryRoot: root = null, ...publicRepository } = acquired;
      if ((!input.exactRoot && (!root || !path.isAbsolute(root))) || (input.exactRoot && !sameRoot(root, input.root))
        || !publicRepository.available || publicRepository.branch !== input.branch) {
        if (entry.generation === input.generation) {
          entry.checked = true;
          // Git answered for the bound root on another branch: the working tree left the
          // session's recorded branch. Any other mismatch stays an unexplained absence.
          const rootMatches = input.exactRoot ? sameRoot(root, input.root) : Boolean(root && path.isAbsolute(root));
          entry.unavailableReason = rootMatches && publicRepository.available ? "branch_changed" : null;
        }
        return false;
      }
      repository = { ...publicRepository, historical: false };
      resolvedRoot = root;
    } catch { return false; }
    let pullRequests;
    try { pullRequests = await pullRequestReader([], { cwd: input.root, branch: repository.branch, historical: false, sessionCreations: input.sessionCreations }); }
    catch { pullRequests = unavailablePullRequests(); }
    const refreshedAt = now();
    let commitsInSession = entry.commitsInSession ?? null; let committedPaths = null; let committedChanges = null; let commitTimes = null;
    if (repository.available && resolvedRoot) {
      const windowRead = await readCommitsInWindow(resolvedRoot, { since: input.startedAt, until: new Date(refreshedAt).toISOString() });
      if (windowRead) { commitsInSession = windowRead.count; committedPaths = windowRead.paths; committedChanges = windowRead.changes; commitTimes = windowRead.times; }
    }
    if (commitsInSession !== null) repository = { ...repository, commitsInSession };
    if (entry.generation !== input.generation) return true;
    entry.value = { repository, pullRequests }; entry.repositoryRoot = resolvedRoot; entry.commitsInSession = commitsInSession;
    entry.refreshedAt = refreshedAt; entry.retryAfter = null; entry.hasValue = true; entry.checked = true; entry.everAvailable = true; entry.unavailableReason = null;
    onCheck?.(entry.sessionId, { repository, pullRequests, commitsInSession, committedPaths, committedChanges, commitTimes, checkedAt: new Date(refreshedAt).toISOString(), repositoryId: input.repositoryId });
    return true;
  }

  function liveEnrichment(sessionId, evidence, attribution = null, schedule) {
    const sessionCreations = [...evidence.pullRequestCreations]; const binding = bindingFor(sessionId, evidence, attribution);
    const fingerprint = JSON.stringify([binding?.fingerprint || null, binding?.branch || null, sessionCreations]);
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = { sessionId, fingerprint, generation: 1, sessionCreations, refreshedAt: null, retryAfter: null, refreshing: false, repositoryRoot: null, commitsInSession: null, hasValue: false, checked: false, everAvailable: false, unavailableReason: null,
        value: { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() } };
      entries.set(sessionId, entry);
    } else if (entry.fingerprint !== fingerprint) {
      entry.fingerprint = fingerprint; entry.generation += 1; entry.sessionCreations = sessionCreations; entry.refreshedAt = null; entry.retryAfter = null;
      entry.refreshing = false; entry.repositoryRoot = null; entry.commitsInSession = null; entry.hasValue = false; entry.checked = false; entry.unavailableReason = null;
      entry.value = { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() };
    }
    // Without a binding there is nothing to check, unless this session was
    // already bound to a repository: an attribution that is briefly unknown
    // stays pending instead of claiming the session has no repository.
    const check = binding ? (entry.checked ? "confirmed" : "pending")
      : entry.everAvailable && attribution?.state !== "multiple" ? "pending" : "none";
    const clock = entry.refreshedAt === null && entry.retryAfter === null ? null : now();
    const expired = (entry.refreshedAt === null || clock - entry.refreshedAt >= cacheMs) && (entry.retryAfter === null || clock >= entry.retryAfter);
    let enqueue = null;
    if (expired && !entry.refreshing) {
      entry.refreshing = true;
      const input = { generation: entry.generation, root: binding?.root || null, exactRoot: Boolean(binding?.exactRoot), repositoryId: binding?.repositoryId || null, branch: binding?.branch || null, sessionCreations: entry.sessionCreations, startedAt: evidence.session.startedAt };
      enqueue = () => {
        try { schedule(() => {
          const work = refresh(entry, input).then((committed) => {
            if (!committed && entry.generation === input.generation) { entry.refreshedAt = now(); entry.retryAfter = entry.refreshedAt + MISMATCH_RETRY_MS; }
          }).catch(() => { if (entry.generation === input.generation && !entry.hasValue) entry.refreshedAt = null; })
            .finally(() => { if (entry.generation === input.generation) entry.refreshing = false; });
          void work.catch(() => {}); return work;
        }); } catch { if (entry.generation === input.generation) entry.refreshing = false; }
      };
    }
    return { value: entry.value, enqueue, check };
  }

  return Object.freeze({
    liveEnrichment(sessionId, evidence, attribution, schedule) {
      return liveEnrichment(sessionId, evidence, attribution, schedule);
    },
    setOnRepositoryCheck(listener) { onCheck = listener; },
    repositoryRootForSession: (sessionId) => entries.get(sessionId)?.repositoryRoot || null,
    /** Why the latest live check found no matching repository: a bounded enum or null. */
    unavailableReasonForSession: (sessionId) => entries.get(sessionId)?.unavailableReason || null,
  });
}
