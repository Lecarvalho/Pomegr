import { runExecFile } from "../normalize/exec-file-runner.mjs";
import { normalizedWorkKind, toolWorkKind } from "../normalize/work-kind.mjs";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECORDED_PATH_DRIVE = /^[A-Za-z]:/u;
const FILE_STATUS = /^[ MADRCUT?!]{2}$/u;
// One commit header of `git log --format="%H %cI"`: the hash is only counted, never retained.
const COMMIT_HEADER_LINE = /^[0-9a-f]{40} (\S{1,64})$/iu;
const MAX_FILES = 200;
const MAX_PULL_REQUESTS = 10;
const MAX_COUNT = 100_000;
const SNAPSHOT_VERSION = 6;
export const REPOSITORY_SNAPSHOT_VERSION = SNAPSHOT_VERSION;
export const MAX_SNAPSHOT_CHECK_AFTER_EVIDENCE_MS = 24 * 60 * 60 * 1000;
export const MAX_COMMIT_TIMES = 50;
const MAX_COMMIT_TIME_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WINDOW_TIMEOUT_MS = 3_000;
const WINDOW_MAX_BUFFER = 256 * 1024;
const MAX_GIT_OBSERVED_LIST_CHARS = 6_000;

const SNAPSHOT_KEYS_V1 = new Set([
  "version", "branch", "isMain", "files", "comparison", "comparisonCheckedAt",
  "pullRequests", "commitsInSession", "checkedAt",
]);
const SNAPSHOT_KEYS_V2 = new Set([
  ...SNAPSHOT_KEYS_V1, "dirtyAtFirstCheck", "becameDirty", "committedInWindow", "gitObservedTruncated",
]);
const SNAPSHOT_KEYS_V3 = new Set([...SNAPSHOT_KEYS_V2, "committedChanges"]);
const SNAPSHOT_KEYS_V4 = new Set([...SNAPSHOT_KEYS_V3, "repositoryId"]);
const SNAPSHOT_KEYS_V5 = new Set([...SNAPSHOT_KEYS_V4, "commitTimesInWindow"]);
const SNAPSHOT_KEYS = new Set([
  ...SNAPSHOT_KEYS_V1, "repositoryId", "commitTimesInWindow",
  "sessionCommitPaths", "sessionCommitChanges", "sessionCommitsTruncated",
]);
const GIT_COMMAND_WORK_KINDS = new Set(["git", "git_push", "pull_request"]);
const MAX_GIT_COMMAND_INTERVALS = 256;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const COMMITTED_CHANGES = new Set(["added", "modified", "deleted"]);
const NAME_STATUS_LINE = /^([AMDT])\t(.+)$/u;
const COMPARISON_KEYS = new Set(["branch", "kind", "ahead", "behind", "integrated"]);
const PULL_REQUESTS_KEYS = new Set(["checkedAt", "items"]);
const PULL_REQUEST_ITEM_KEYS = new Set([
  "host", "repository", "number", "title", "url", "state", "draft",
  "headBranch", "baseBranch", "additions", "deletions", "updatedAt", "association",
]);
const PULL_REQUEST_STATES = new Set(["open", "merged", "closed", "unknown"]);
const PULL_REQUEST_ASSOCIATIONS = new Set(["session", "branch"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isBoundedText(value, maxLength, { minLength = 1 } = {}) {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength && !CONTROL.test(value);
}

function isIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isBoundedCount(value, maximum = MAX_COUNT) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

export function isSafeRecordedRepositoryPath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512
    || CONTROL.test(value) || value.includes("\\") || RECORDED_PATH_DRIVE.test(value)) {
    return false;
  }
  const segments = value.split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === ".."
    || [".claude", ".codex"].includes(segment.toLowerCase()));
}

function normalizeSnapshotFile(value) {
  if (!hasExactKeys(value, new Set(["status", "path"]))) return null;
  if (typeof value.status !== "string" || !FILE_STATUS.test(value.status)) return null;
  if (!isSafeRecordedRepositoryPath(value.path)) return null;
  return { status: value.status, path: value.path };
}

function normalizeSnapshotComparison(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, COMPARISON_KEYS)) return undefined;
  if (!isBoundedText(value.branch, 256)) return undefined;
  if (value.kind !== "base" && value.kind !== "upstream") return undefined;
  if (!isBoundedCount(value.ahead) || !isBoundedCount(value.behind)) return undefined;
  if (typeof value.integrated !== "boolean") return undefined;
  return { branch: value.branch, kind: value.kind, ahead: value.ahead, behind: value.behind, integrated: value.integrated };
}

function normalizeSnapshotPullRequestItem(value) {
  if (!hasExactKeys(value, PULL_REQUEST_ITEM_KEYS)) return null;
  if (value.host !== "github") return null;
  if (typeof value.url !== "string" || value.url.length > 400 || CONTROL.test(value.url)
    || !value.url.startsWith("https://github.com/")) return null;
  if (!isBoundedText(value.repository, 200)) return null;
  if (!Number.isSafeInteger(value.number) || value.number <= 0) return null;
  if (typeof value.title !== "string" || value.title.length > 300 || CONTROL.test(value.title)) return null;
  if (!PULL_REQUEST_STATES.has(value.state)) return null;
  if (typeof value.draft !== "boolean") return null;
  if (typeof value.headBranch !== "string" || value.headBranch.length > 256 || CONTROL.test(value.headBranch)) return null;
  if (typeof value.baseBranch !== "string" || value.baseBranch.length > 256 || CONTROL.test(value.baseBranch)) return null;
  if (value.additions !== null && !isBoundedCount(value.additions, Number.MAX_SAFE_INTEGER)) return null;
  if (value.deletions !== null && !isBoundedCount(value.deletions, Number.MAX_SAFE_INTEGER)) return null;
  if (value.updatedAt !== null && !isIsoTimestamp(value.updatedAt)) return null;
  if (!PULL_REQUEST_ASSOCIATIONS.has(value.association)) return null;
  return {
    host: "github", repository: value.repository, number: value.number, title: value.title, url: value.url,
    state: value.state, draft: value.draft, headBranch: value.headBranch, baseBranch: value.baseBranch,
    additions: value.additions, deletions: value.deletions, updatedAt: value.updatedAt, association: value.association,
  };
}

function normalizeSnapshotPullRequests(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, PULL_REQUESTS_KEYS)) return undefined;
  if (!isIsoTimestamp(value.checkedAt)) return undefined;
  if (!Array.isArray(value.items) || value.items.length > MAX_PULL_REQUESTS) return undefined;
  const items = [];
  for (const item of value.items) {
    const normalized = normalizeSnapshotPullRequestItem(item);
    if (!normalized) return undefined;
    items.push(normalized);
  }
  return { checkedAt: value.checkedAt, items };
}

function normalizeGitObservedPathList(value, { nullable }) {
  if (value === null) return nullable ? null : undefined;
  if (!Array.isArray(value) || value.length > MAX_FILES) return undefined;
  const paths = [];
  let chars = 0;
  for (const path of value) {
    if (!isSafeRecordedRepositoryPath(path)) return undefined;
    chars += path.length;
    if (chars > MAX_GIT_OBSERVED_LIST_CHARS) return undefined;
    paths.push(path);
  }
  return paths;
}

function normalizeCommittedChanges(value, paths) {
  if (value === null) return null;
  if (!Array.isArray(paths) || !Array.isArray(value) || value.length !== paths.length) return undefined;
  return value.every((change) => COMMITTED_CHANGES.has(change)) ? [...value] : undefined;
}

function normalizeCommitTimes(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_COMMIT_TIMES) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const time = value[index];
    if (typeof time !== "string" || !CANONICAL_TIME.test(time)) return undefined;
    const parsed = Date.parse(time);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== time) return undefined;
    if (index > 0 && value[index - 1] > time) return undefined;
  }
  return [...value];
}

function normalizeSnapshotCore(value) {
  if (!isBoundedText(value.branch, 256)) return null;
  if (typeof value.isMain !== "boolean") return null;
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) return null;
  const files = [];
  for (const file of value.files) {
    const normalized = normalizeSnapshotFile(file);
    if (!normalized) return null;
    files.push(normalized);
  }
  const comparison = normalizeSnapshotComparison(value.comparison);
  if (comparison === undefined) return null;
  if (value.comparisonCheckedAt !== null && !isIsoTimestamp(value.comparisonCheckedAt)) return null;
  const pullRequests = normalizeSnapshotPullRequests(value.pullRequests);
  if (pullRequests === undefined) return null;
  if (value.commitsInSession !== null && !isBoundedCount(value.commitsInSession)) return null;
  if (!isIsoTimestamp(value.checkedAt)) return null;
  return {
    branch: value.branch,
    isMain: value.isMain,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    comparison: comparison ? Object.freeze(comparison) : null,
    comparisonCheckedAt: value.comparisonCheckedAt,
    pullRequests: pullRequests ? Object.freeze({ ...pullRequests, items: Object.freeze(pullRequests.items.map((item) => Object.freeze(item))) }) : null,
    commitsInSession: value.commitsInSession,
    checkedAt: value.checkedAt,
  };
}

export function normalizeRepositorySnapshot(value) {
  if (!isPlainObject(value)) return null;
  const legacyKeys = value.version === 1 ? SNAPSHOT_KEYS_V1
    : value.version === 2 ? SNAPSHOT_KEYS_V2
      : value.version === 3 ? SNAPSHOT_KEYS_V3
        : value.version === 4 ? SNAPSHOT_KEYS_V4
          : value.version === 5 ? SNAPSHOT_KEYS_V5 : null;
  if (!hasExactKeys(value, legacyKeys || SNAPSHOT_KEYS) || (!legacyKeys && value.version !== SNAPSHOT_VERSION)) return null;
  const core = normalizeSnapshotCore(value);
  if (!core) return null;
  if (legacyKeys && value.version >= 2) {
    if (normalizeGitObservedPathList(value.dirtyAtFirstCheck, { nullable: true }) === undefined) return null;
    if (normalizeGitObservedPathList(value.becameDirty, { nullable: false }) === undefined) return null;
    const committedInWindow = normalizeGitObservedPathList(value.committedInWindow, { nullable: true });
    if (committedInWindow === undefined) return null;
    if (value.version >= 3 && normalizeCommittedChanges(value.committedChanges, committedInWindow) === undefined) return null;
    if (typeof value.gitObservedTruncated !== "boolean") return null;
  }
  const repositoryId = legacyKeys && value.version < 4 ? null : value.repositoryId;
  if (repositoryId !== null && (typeof repositoryId !== "string" || !REPOSITORY_ID.test(repositoryId))) return null;
  const commitTimesInWindow = legacyKeys && value.version < 5 ? null : normalizeCommitTimes(value.commitTimesInWindow);
  if (commitTimesInWindow === undefined) return null;
  const sessionCommitPaths = legacyKeys ? null : normalizeGitObservedPathList(value.sessionCommitPaths, { nullable: true });
  if (sessionCommitPaths === undefined) return null;
  const sessionCommitChanges = legacyKeys ? null : normalizeCommittedChanges(value.sessionCommitChanges, sessionCommitPaths);
  if (sessionCommitChanges === undefined) return null;
  if (!legacyKeys && typeof value.sessionCommitsTruncated !== "boolean") return null;
  return Object.freeze({
    version: SNAPSHOT_VERSION,
    ...core,
    repositoryId,
    commitTimesInWindow: commitTimesInWindow === null ? null : Object.freeze(commitTimesInWindow),
    sessionCommitPaths: sessionCommitPaths === null ? null : Object.freeze(sessionCommitPaths),
    sessionCommitChanges: sessionCommitChanges === null ? null : Object.freeze(sessionCommitChanges),
    sessionCommitsTruncated: legacyKeys ? false : value.sessionCommitsTruncated,
  });
}

function commitTimeCounts(times) {
  const counts = new Map();
  for (const time of Array.isArray(times) ? times : []) {
    const parsed = typeof time === "string" ? Date.parse(time) : Number.NaN;
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_COMMIT_TIME_MS) counts.set(parsed, (counts.get(parsed) || 0) + 1);
  }
  return counts;
}

export function nextCommitTimes(previousTimes, readTimes) {
  if (!Array.isArray(readTimes)) return Array.isArray(previousTimes) ? previousTimes : null;
  const counts = commitTimeCounts(previousTimes);
  for (const [time, count] of commitTimeCounts(readTimes)) counts.set(time, Math.max(counts.get(time) || 0, count));
  const merged = [];
  for (const time of [...counts.keys()].sort((left, right) => left - right)) {
    for (let index = 0; index < counts.get(time); index += 1) merged.push(new Date(time).toISOString());
  }
  return merged.slice(-MAX_COMMIT_TIMES);
}

function truncatePathList(paths) {
  const sorted = [...new Set(paths)].sort();
  const kept = [];
  let chars = 0;
  for (const path of sorted) {
    if (kept.length >= MAX_FILES || chars + path.length > MAX_GIT_OBSERVED_LIST_CHARS) {
      return { list: kept, truncated: true };
    }
    kept.push(path);
    chars += path.length;
  }
  return { list: kept, truncated: false };
}

export function nextSessionCommits(previous, { paths, changes } = {}) {
  const priorPaths = Array.isArray(previous?.sessionCommitPaths) ? previous.sessionCommitPaths : null;
  const priorChanges = priorPaths && Array.isArray(previous.sessionCommitChanges)
    && previous.sessionCommitChanges.length === priorPaths.length ? previous.sessionCommitChanges : null;
  const priorTruncated = Boolean(previous?.sessionCommitsTruncated);
  if (!Array.isArray(paths)) return { sessionCommitPaths: priorPaths, sessionCommitChanges: priorChanges, sessionCommitsTruncated: priorTruncated };
  const changeByPath = new Map((priorPaths || []).map((path, index) => [path, priorChanges ? priorChanges[index] : null]));
  const readChanges = Array.isArray(changes) && changes.length === paths.length ? changes : null;
  paths.forEach((path, index) => {
    if (isSafeRecordedRepositoryPath(path)) changeByPath.set(path, readChanges ? readChanges[index] : changeByPath.get(path) ?? null);
  });
  const kept = truncatePathList([...changeByPath.keys()]);
  const aligned = kept.list.map((path) => changeByPath.get(path));
  return {
    sessionCommitPaths: kept.list,
    sessionCommitChanges: aligned.every((change) => COMMITTED_CHANGES.has(change)) ? aligned : null,
    sessionCommitsTruncated: priorTruncated || kept.truncated,
  };
}

export function gitObservedFilesFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.sessionCommitPaths)) return null;
  const paths = snapshot.sessionCommitPaths;
  const changes = Array.isArray(snapshot.sessionCommitChanges) && snapshot.sessionCommitChanges.length === paths.length ? snapshot.sessionCommitChanges : null;
  return {
    files: paths.slice(0, MAX_FILES).map((path, index) => ({ path, source: "committed", change: changes ? changes[index] : null })),
    truncated: Boolean(snapshot.sessionCommitsTruncated) || paths.length > MAX_FILES,
  };
}

function gitCommandInterval(startedAt, finishedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) return null;
  return [Math.floor(startedAt / 1_000) * 1_000, finishedAt];
}

/** The session's finished Git commands from normalized provider evidence, oldest to newest. */
export function sessionGitCommandIntervals(evidence) {
  const intervals = [];
  // Every agent's commands count: a subagent's commit is the session's.
  for (const agent of Array.isArray(evidence?.agents) ? evidence.agents : []) {
    for (const task of Array.isArray(agent?.executionTasks) ? agent.executionTasks : []) {
      if (!GIT_COMMAND_WORK_KINDS.has(task?.workKind)) continue;
      const startedAt = typeof task.startedAt === "string" ? Date.parse(task.startedAt) : Number.NaN;
      const finishedAt = typeof task.finishedAt === "string" ? Date.parse(task.finishedAt) : Number.NaN;
      const interval = gitCommandInterval(startedAt, finishedAt);
      if (interval) intervals.push(interval);
    }
  }
  // An agent keeps only its newest execution tasks; the longer tool-call feed still holds the earlier Git commands.
  for (const call of Array.isArray(evidence?.toolCalls) ? evidence.toolCalls : []) {
    if (!call || call.status === "running" || !Number.isSafeInteger(call.durationMs) || call.durationMs < 0) continue;
    if (!GIT_COMMAND_WORK_KINDS.has(normalizedWorkKind(call.workKind, toolWorkKind(call.tool, { detail: call.detail })))) continue;
    const startedAt = typeof call.timestamp === "string" ? Date.parse(call.timestamp) : Number.NaN;
    const interval = gitCommandInterval(startedAt, startedAt + call.durationMs);
    if (interval) intervals.push(interval);
  }
  // The same command can appear as a task and as a tool call: overlapping intervals merge.
  intervals.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push(interval);
  }
  return merged.slice(-MAX_GIT_COMMAND_INTERVALS);
}

export function snapshotFromLiveCheck({ repository, pullRequests, commitsInSession, sessionCommitPaths, sessionCommitChanges, commitTimes, checkedAt, repositoryId = null, previous = null, adoptsUnboundSidecar = false } = {}) {
  if (!repository || repository.available !== true || repository.historical !== false) return null;
  // A new bound identity begins a new repository timeline.
  const prior = previous?.repositoryId === repositoryId || adoptsUnboundSidecar && previous?.repositoryId === null ? previous : null;
  const files = (Array.isArray(repository.files) ? repository.files : [])
    .slice(0, MAX_FILES)
    .map((file) => (typeof file?.status === "string" && FILE_STATUS.test(file.status) && isSafeRecordedRepositoryPath(file?.path)
      ? { status: file.status, path: file.path }
      : null))
    .filter(Boolean);
  const takeComparison = repository.remote?.status === "ready";
  const comparison = takeComparison ? (repository.comparison ?? null) : (prior?.comparison ?? null);
  const comparisonCheckedAt = takeComparison ? (repository.remote?.checkedAt ?? null) : (prior?.comparisonCheckedAt ?? null);
  const takePullRequests = pullRequests?.status === "ready";
  const nextPullRequests = takePullRequests
    ? { checkedAt: pullRequests.checkedAt || checkedAt, items: Array.isArray(pullRequests.items) ? pullRequests.items : [] }
    : (prior?.pullRequests ?? null);
  const nextCommitsInSession = Number.isSafeInteger(commitsInSession) ? commitsInSession : (prior?.commitsInSession ?? null);
  return normalizeRepositorySnapshot({
    version: SNAPSHOT_VERSION,
    branch: repository.branch,
    isMain: Boolean(repository.isMain),
    files,
    comparison,
    comparisonCheckedAt,
    pullRequests: nextPullRequests,
    commitsInSession: nextCommitsInSession,
    checkedAt,
    repositoryId,
    commitTimesInWindow: nextCommitTimes(prior?.commitTimesInWindow, commitTimes),
    ...nextSessionCommits(prior, { paths: sessionCommitPaths, changes: sessionCommitChanges }),
  });
}

export function withLegacyRepositoryAttribution(evidence, legacyAttribution) {
  const session = evidence?.session;
  if (legacyAttribution !== "launch" || !session || typeof session !== "object"
    || session.repositoryAttribution !== undefined) return evidence;
  return { ...evidence, session: { ...session, repositoryAttribution: "launch" } };
}

function checkedWithinEvidenceBound(evidence, snapshot) {
  if (evidence?.historical === false) return true;
  const checkedAt = Date.parse(snapshot.checkedAt);
  const evidenceAt = Date.parse(evidence?.session?.updatedAt);
  return Number.isFinite(checkedAt) && Number.isFinite(evidenceAt)
    && checkedAt - evidenceAt <= MAX_SNAPSHOT_CHECK_AFTER_EVIDENCE_MS;
}

export function sessionRepositorySnapshot(evidence, snapshot, { adoptsUnboundSidecar = false } = {}) {
  if (!snapshot || !checkedWithinEvidenceBound(evidence, snapshot)) return null;
  if (evidence?.session?.repositoryAttribution === "launch") return snapshot;
  const repositoryId = evidence?.session?.repositoryId;
  if (evidence?.session?.repositoryAttribution !== "single" || !REPOSITORY_ID.test(repositoryId || "")) return null;
  return snapshot.repositoryId === repositoryId || adoptsUnboundSidecar && snapshot.repositoryId === null ? snapshot : null;
}

const UNAVAILABLE_PULL_REQUESTS = Object.freeze({ status: "unavailable", checkedAt: null, items: Object.freeze([]) });

export function historicalRepositoryFromSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    repository: {
      available: true,
      branch: snapshot.branch,
      files: snapshot.files,
      historical: true,
      isMain: snapshot.isMain,
      comparison: snapshot.comparison,
      commits: [],
      remote: snapshot.comparison
        ? { status: "ready", checkedAt: snapshot.comparisonCheckedAt }
        : { status: "unavailable", checkedAt: null },
      recordedAt: snapshot.checkedAt,
      commitsInSession: snapshot.commitsInSession,
    },
    pullRequests: snapshot.pullRequests
      ? { status: "ready", checkedAt: snapshot.pullRequests.checkedAt, items: snapshot.pullRequests.items }
      : UNAVAILABLE_PULL_REQUESTS,
  };
}

function sessionRecordedBranch(evidence) {
  const attribution = evidence.session.repositoryAttribution;
  return attribution === "launch" || attribution === "single" && REPOSITORY_ID.test(evidence.session.repositoryId || "")
    ? evidence.session.recordedGitBranch : "";
}

export function resolveCheckpointRepository({ historical, evidence, snapshot, adoptsUnboundSidecar = false, recordedGitState, unavailableGitState, unavailablePullRequests }) {
  if (!historical) return { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() };
  return historicalRepositoryFromSnapshot(sessionRepositorySnapshot(evidence, snapshot, { adoptsUnboundSidecar }))
    || { repository: recordedGitState(sessionRecordedBranch(evidence)), pullRequests: unavailablePullRequests() };
}

export async function resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot, adoptsUnboundSidecar = false, recordedGitState, pullRequestReader, unavailablePullRequests }) {
  const matchedSnapshot = sessionRepositorySnapshot(evidence, snapshot, { adoptsUnboundSidecar });
  if (matchedSnapshot) return historicalRepositoryFromSnapshot(matchedSnapshot);
  const repository = recordedGitState(sessionRecordedBranch(evidence));
  return { repository, pullRequests: unavailablePullRequests() };
}

function netCommittedChange(statusesNewestFirst) {
  if (statusesNewestFirst[0] === "D") return "deleted";
  return statusesNewestFirst.includes("A") ? "added" : "modified";
}

export function readCommitsInWindow(repositoryRoot, { since, until, commandIntervals } = {}) {
  return new Promise((resolve) => {
    if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0
      || !isIsoTimestamp(since) || !isIsoTimestamp(until)) {
      resolve(null);
      return;
    }
    const intervals = Array.isArray(commandIntervals) ? commandIntervals : [];
    try {
      runExecFile("git", [
        "-c", "core.quotepath=false",
        "-C", repositoryRoot,
        "log", "--format=%H %cI", "--name-status", "--no-renames", `--since=${since}`, `--until=${until}`, "HEAD",
      ], {
        encoding: "utf8",
        timeout: WINDOW_TIMEOUT_MS,
        maxBuffer: WINDOW_MAX_BUFFER,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) { resolve(null); return; }
        let count = 0;
        let ownCommit = false;
        const commitTimes = [];
        const statusesByPath = new Map();
        for (const line of String(stdout).split(/\r?\n/u)) {
          if (!line) continue;
          const header = COMMIT_HEADER_LINE.exec(line);
          if (header) {
            count += 1;
            const committedAt = Date.parse(header[1]);
            if (Number.isFinite(committedAt) && committedAt >= 0 && committedAt <= MAX_COMMIT_TIME_MS) commitTimes.push(committedAt);
            ownCommit = intervals.some(([from, to]) => committedAt >= from && committedAt <= to);
            continue;
          }
          const match = ownCommit ? NAME_STATUS_LINE.exec(line) : null;
          if (!match || !isSafeRecordedRepositoryPath(match[2])) continue;
          const statuses = statusesByPath.get(match[2]) || [];
          statuses.push(match[1]);
          statusesByPath.set(match[2], statuses);
        }
        if (!isBoundedCount(count, MAX_COUNT)) { resolve(null); return; }
        const bounded = truncatePathList([...statusesByPath.keys()]);
        resolve({
          count,
          paths: bounded.list,
          changes: bounded.list.map((path) => netCommittedChange(statusesByPath.get(path))),
          truncated: bounded.truncated,
          // Committer times only, oldest to newest, newest MAX_COMMIT_TIMES; `count` stays complete.
          times: commitTimes.sort((left, right) => left - right).slice(-MAX_COMMIT_TIMES).map((time) => new Date(time).toISOString()),
        });
      });
    } catch {
      resolve(null);
    }
  });
}

function parseQualifiedSessionId(value) {
  if (typeof value !== "string") return null;
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return null;
  const providerId = value.slice(0, separator);
  const localSessionId = value.slice(separator + 1);
  if (providerId.length < 1 || providerId.length > 64 || localSessionId.length < 1 || localSessionId.length > 512) return null;
  return { providerId, localSessionId };
}

const DEFAULT_RECORDER_MAX_ENTRIES = 512;

export function createRepositorySnapshotRecorder({ store, now = () => Date.now(), maxEntries, adoptsUnboundSidecar = () => false } = {}) {
  if (!store || typeof store.writeRepositorySnapshot !== "function" || typeof store.loadRepositorySnapshots !== "function") {
    throw new TypeError("Repository snapshot recorder requires a checkpoint store");
  }
  const bound = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : DEFAULT_RECORDER_MAX_ENTRIES;
  const entries = new Map();
  const pending = new Map();
  const reading = new Map();

  function retain(qualifiedId, snapshot) {
    entries.delete(qualifiedId);
    entries.set(qualifiedId, { snapshot, lastUsedAt: now() });
    while (entries.size > bound) entries.delete(entries.keys().next().value);
  }

  async function load() {
    let records;
    try {
      records = await store.loadRepositorySnapshots({ withCheckpoint: true });
    } catch {
      return;
    }
    for (const record of records || []) {
      if (!record || typeof record.providerId !== "string" || typeof record.localSessionId !== "string" || !record.snapshot) continue;
      retain(`${record.providerId}:${record.localSessionId}`, record.snapshot);
    }
  }

  /** Make one session's sidecar available to `recorded`, reading its file only when this recorder holds no answer for it yet. */
  function ensure(qualifiedId) {
    const held = entries.get(qualifiedId);
    if (held) return Promise.resolve(Boolean(held.snapshot));
    const parsed = parseQualifiedSessionId(qualifiedId);
    if (!parsed || typeof store.loadRepositorySnapshot !== "function") return Promise.resolve(false);
    const inFlight = reading.get(qualifiedId);
    if (inFlight) return inFlight;
    const read = Promise.resolve()
      .then(() => store.loadRepositorySnapshot(parsed.providerId, parsed.localSessionId))
      .catch(() => null)
      .then((snapshot) => {
        if (!entries.has(qualifiedId)) retain(qualifiedId, snapshot || null);
        return Boolean(entries.get(qualifiedId)?.snapshot);
      })
      .finally(() => { if (reading.get(qualifiedId) === read) reading.delete(qualifiedId); });
    reading.set(qualifiedId, read);
    return read;
  }

  function record(qualifiedId, live) {
    const parsed = parseQualifiedSessionId(qualifiedId);
    if (!parsed) return Promise.resolve(false);
    const chain = (pending.get(qualifiedId) || Promise.resolve())
      .catch(() => {})
      // Derive only after the prior write for this session settles.
      .then(async () => {
        // A sidecar this recorder has not read yet is still the session's baseline.
        await ensure(qualifiedId);
        const previous = entries.get(qualifiedId)?.snapshot || null;
        let next = null;
        try {
          next = snapshotFromLiveCheck({
            repository: live?.repository,
            pullRequests: live?.pullRequests,
            commitsInSession: live?.commitsInSession,
            sessionCommitPaths: live?.sessionCommitPaths,
            sessionCommitChanges: live?.sessionCommitChanges,
            commitTimes: live?.commitTimes,
            checkedAt: live?.checkedAt,
            repositoryId: live?.repositoryId,
            previous,
            adoptsUnboundSidecar: adoptsUnboundSidecar(parsed.providerId) === true,
          });
        } catch {
          next = null;
        }
        if (!next || (previous && JSON.stringify(previous) === JSON.stringify(next))) return false;
        await store.writeRepositorySnapshot(parsed.providerId, parsed.localSessionId, next);
        retain(qualifiedId, next);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        if (pending.get(qualifiedId) === chain) pending.delete(qualifiedId);
      });
    pending.set(qualifiedId, chain);
    return chain;
  }

  function recorded(qualifiedId) {
    if (typeof qualifiedId !== "string") return null;
    const entry = entries.get(qualifiedId);
    if (!entry) return null;
    entries.delete(qualifiedId);
    entry.lastUsedAt = now();
    entries.set(qualifiedId, entry);
    return entry.snapshot;
  }

  function has(qualifiedId) {
    return entries.has(qualifiedId);
  }

  return Object.freeze({ load, ensure, record, recorded, has });
}
