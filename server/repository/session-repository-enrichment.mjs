import path from "node:path";
import { readCommitsInWindow, sessionGitCommandIntervals } from "./repository-snapshot.mjs";

const MISMATCH_RETRY_MS = 2_500;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

function bindingFor(sessionId, evidence, attribution) {
  const root = attribution?.root;
  const branch = attribution?.recordedBranch;
  const repositoryId = attribution?.repositoryId;
  const validBranch = typeof branch === "string" && branch.length > 0 && branch.length <= 512 && !/[\u0000-\u001f\u007f]/.test(branch);
  // A checkout the session reached with no recorded branch is read on the branch it has.
  const anyBranch = !validBranch && attribution?.anyBranch === true;
  if (attribution?.state === "single" && typeof root === "string" && root.length > 0 && root.length <= 32_768
    && path.isAbsolute(root) && !/[\u0000-\u001f\u007f]/.test(root) && REPOSITORY_ID.test(repositoryId || "")
    && (validBranch || anyBranch)) {
    const normalizedRoot = path.normalize(root);
    return { root: normalizedRoot, repositoryId, branch: validBranch ? branch : null, anyBranch, fingerprint: attribution.fingerprint || `${normalizedRoot}:${branch}`, exactRoot: true };
  }
  const cwd = evidence?.session?.cwd;
  const recordedBranch = evidence?.session?.recordedGitBranch;
  if (!String(sessionId).startsWith("claude:") || typeof cwd !== "string" || cwd.length === 0 || cwd.length > 32_768
    || !path.isAbsolute(cwd) || /[\u0000-\u001f\u007f]/.test(cwd) || typeof recordedBranch !== "string"
    || recordedBranch.length === 0 || recordedBranch.length > 512 || /[\u0000-\u001f\u007f]/.test(recordedBranch)) return null;
  const normalizedRoot = path.normalize(cwd);
  const session = evidence.session;
  const provenRepositoryId = session.repositoryAttribution === "single" && REPOSITORY_ID.test(session.repositoryId || "") ? session.repositoryId : null;
  return { root: normalizedRoot, repositoryId: provenRepositoryId, branch: recordedBranch, fingerprint: `claude:${normalizedRoot}:${recordedBranch}`, exactRoot: false };
}

function sameRoot(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = path.normalize(left); const b = path.normalize(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The fixed reasons a bound session's live Git read found no repository to show.
const GIT_READ_FAILURES = new Set(["not_repository", "timeout", "git_missing", "refused", "failed"]);

// Monitor-private read times and revision-bound CI evidence.
const PRIVATE_KEYS = ["readAt", "headOid", "checkReads"];

function carriesReadStamp(block) {
  return block !== null && typeof block === "object" && PRIVATE_KEYS.some((key) => Object.hasOwn(block, key));
}

function withoutReadStamp(block) {
  const served = { ...block };
  for (const key of PRIVATE_KEYS) delete served[key];
  return served;
}

/** The session state as served, without monitor-private repository and check evidence. */
export function servedSessionState(state) {
  const session = state?.session;
  if (!session || typeof session !== "object" || (!carriesReadStamp(session.repository) && !carriesReadStamp(session.pullRequests))) return state;
  return {
    ...state,
    session: {
      ...session,
      ...(carriesReadStamp(session.repository) ? { repository: withoutReadStamp(session.repository) } : {}),
      ...(carriesReadStamp(session.pullRequests) ? { pullRequests: withoutReadStamp(session.pullRequests) } : {}),
    },
  };
}

export function serializeServedSessionState(state) {
  return JSON.stringify(servedSessionState(state));
}

export function liveRepositoryReadiness({ historical = false, available = false, check = "pending" } = {}) {
  if (historical || available || check === "none") return "ready";
  return check === "confirmed" ? "unavailable" : "loading";
}

/** Owns only live, private Git enrichment keyed by normalized session ID. */
export function createSessionRepositoryEnrichment({ gitReader, pullRequestReader, now, cacheMs, providerFolders, unavailableGitState, unavailablePullRequests } = {}) {
  const entries = new Map();
  let onCheck = null;

  async function refresh(entry, input, { fresh = false } = {}) {
    if (!input.root) return false;
    let repository; let resolvedRoot; let reportOnly = false;
    const readStartedAt = now();
    try {
      const forbiddenRoots = Object.values(providerFolders?.folders || {}).filter(Boolean);
      let acquired = await gitReader(input.root, { forbiddenRoots });
      if (fresh && Number.isFinite(acquired?._readStartedAt) && acquired._readStartedAt < readStartedAt) acquired = await gitReader(input.root, { forbiddenRoots });
      const { _repositoryRoot: root = null, _headOid: headOid, _readStartedAt: inspectionStartedAt, _statusUnknown: statusUnknown = false, _unavailable: readFailure = null, ...publicRepository } = acquired;
      const rootMatches = input.exactRoot ? sameRoot(root, input.root) : Boolean(root && path.isAbsolute(root));
      const onBranch = input.anyBranch ? Boolean(publicRepository.branch) : publicRepository.branch === input.branch;
      // Git answered for the bound root on another branch: the working tree left the session's recorded branch.
      const branchChanged = rootMatches && Boolean(publicRepository.available) && !onBranch;
      // A report is judged on the branch the bound root has when it arrives; that read is the report's alone.
      reportOnly = fresh && branchChanged && typeof publicRepository.branch === "string" && publicRepository.branch !== "";
      if (!reportOnly && (!rootMatches || !publicRepository.available || !onBranch)) {
        if (entry.generation === input.generation) {
          entry.checked = true;
          entry.unavailableReason = branchChanged ? "branch_changed"
            : !publicRepository.available && GIT_READ_FAILURES.has(readFailure) ? readFailure : null;
        }
        return false;
      }
      const readAt = statusUnknown === true ? null : Number.isFinite(inspectionStartedAt) ? Math.min(readStartedAt, inspectionStartedAt) : readStartedAt;
      repository = { ...publicRepository, historical: false, ...(/^[a-f0-9]{40}$/iu.test(headOid || "") ? { headOid } : {}),
        ...(Number.isFinite(readAt) && readAt !== null ? { readAt: new Date(readAt).toISOString() } : {}) };
      resolvedRoot = root;
    } catch { return false; }
    let pullRequests;
    try { pullRequests = await pullRequestReader([], { cwd: input.root, branch: repository.branch, historical: false, sessionCreations: input.sessionCreations, ...(fresh ? { fresh: true } : {}) }); }
    catch { pullRequests = unavailablePullRequests(); }
    // It replaces nothing the session shows: the Repository tab keeps saying that the branch changed.
    if (reportOnly) return entry.generation === input.generation ? { repository, pullRequests } : true;
    const refreshedAt = now();
    let commitsInSession = entry.commitsInSession ?? null; let sessionCommitPaths = null; let sessionCommitChanges = null; let commitTimes = null;
    if (repository.available && resolvedRoot) {
      const windowRead = await readCommitsInWindow(resolvedRoot, { since: input.startedAt, until: new Date(refreshedAt).toISOString(), commandIntervals: input.gitCommandIntervals });
      if (windowRead) { commitsInSession = windowRead.count; sessionCommitPaths = windowRead.paths; sessionCommitChanges = windowRead.changes; commitTimes = windowRead.times; }
    }
    if (commitsInSession !== null) repository = { ...repository, commitsInSession };
    if (entry.generation !== input.generation) return true;
    const value = { repository, pullRequests };
    // A read that began before the one already held does not replace it.
    if (entry.hasValue && entry.readStartedAt > readStartedAt) return value;
    entry.value = { repository, pullRequests: pullRequests?.status !== "ready" && entry.hasValue ? entry.value.pullRequests : pullRequests };
    entry.readStartedAt = readStartedAt; entry.repositoryRoot = resolvedRoot; entry.commitsInSession = commitsInSession;
    entry.refreshedAt = refreshedAt; entry.retryAfter = null; entry.hasValue = true; entry.checked = true; entry.everAvailable = true; entry.unavailableReason = null;
    onCheck?.(entry.sessionId, { repository, pullRequests, commitsInSession, sessionCommitPaths, sessionCommitChanges, commitTimes, checkedAt: new Date(refreshedAt).toISOString(), repositoryId: input.repositoryId });
    return value;
  }

  function liveEnrichment(sessionId, evidence, attribution = null, schedule) {
    const sessionCreations = [...evidence.pullRequestCreations]; const binding = bindingFor(sessionId, evidence, attribution);
    const fingerprint = JSON.stringify([binding?.fingerprint || null, binding?.branch || null, sessionCreations]);
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = { sessionId, fingerprint, generation: 1, sessionCreations, refreshedAt: null, retryAfter: null, refreshing: false, repositoryRoot: null, commitsInSession: null, hasValue: false, readStartedAt: 0, readInput: null, checked: false, everAvailable: false, unavailableReason: null,
        value: { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() } };
      entries.set(sessionId, entry);
    } else if (entry.fingerprint !== fingerprint) {
      entry.fingerprint = fingerprint; entry.generation += 1; entry.sessionCreations = sessionCreations; entry.refreshedAt = null; entry.retryAfter = null;
      entry.refreshing = false; entry.repositoryRoot = null; entry.commitsInSession = null; entry.hasValue = false; entry.readStartedAt = 0; entry.checked = false; entry.unavailableReason = null;
      entry.value = { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() };
    }
    const check = binding ? (entry.checked ? "confirmed" : "pending")
      : entry.everAvailable && attribution?.state !== "multiple" ? "pending" : "none";
    const clock = entry.refreshedAt === null && entry.retryAfter === null ? null : now();
    const expired = (entry.refreshedAt === null || clock - entry.refreshedAt >= cacheMs) && (entry.retryAfter === null || clock >= entry.retryAfter);
    let enqueue = null;
    const readInput = () => ({ generation: entry.generation, root: binding?.root || null, exactRoot: Boolean(binding?.exactRoot), repositoryId: binding?.repositoryId || null, branch: binding?.branch || null, anyBranch: binding?.anyBranch === true, sessionCreations: entry.sessionCreations, startedAt: evidence.session.startedAt,
      // Only commits made while one of this session's own Git commands ran list their paths.
      gitCommandIntervals: sessionGitCommandIntervals(evidence) });
    entry.readInput = readInput;
    if (expired && !entry.refreshing) {
      entry.refreshing = true;
      const input = readInput();
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

  async function readNow(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || typeof entry.readInput !== "function") return null;
    try {
      const value = await refresh(entry, entry.readInput(), { fresh: true });
      return value && value !== true ? value : null;
    } catch { return null; }
  }

  return Object.freeze({
    liveEnrichment(sessionId, evidence, attribution, schedule) {
      return liveEnrichment(sessionId, evidence, attribution, schedule);
    },
    readNow,
    setOnRepositoryCheck(listener) { onCheck = listener; },
    repositoryRootForSession: (sessionId) => entries.get(sessionId)?.repositoryRoot || null,
    unavailableReasonForSession: (sessionId) => entries.get(sessionId)?.unavailableReason || null,
  });
}
