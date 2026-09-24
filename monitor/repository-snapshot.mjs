import { execFile } from "node:child_process";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECORDED_PATH_DRIVE = /^[A-Za-z]:/u;
const FILE_STATUS = /^[ MADRCUT?!]{2}$/u;
const COMMIT_HASH_LINE = /^[0-9a-f]{40}$/iu;
const MAX_FILES = 200;
const MAX_PULL_REQUESTS = 10;
const MAX_COUNT = 100_000;
const SNAPSHOT_VERSION = 3;
const WINDOW_TIMEOUT_MS = 3_000;
const WINDOW_MAX_BUFFER = 256 * 1024;
// Combined character budget for one git-observed path list (dirtyAtFirstCheck,
// becameDirty or committedInWindow). Bounds the worst case of several 200-entry,
// long-path lists in one record so a valid snapshot always fits the checkpoint
// store's serialized-record byte cap alongside files/comparison/pullRequests.
const MAX_GIT_OBSERVED_LIST_CHARS = 6_000;

// The version-1 shape, kept exact so an on-disk v1 record still validates and
// can be transparently upgraded (see normalizeRepositorySnapshot).
const SNAPSHOT_KEYS_V1 = new Set([
  "version", "branch", "isMain", "files", "comparison", "comparisonCheckedAt",
  "pullRequests", "commitsInSession", "checkedAt",
]);
const SNAPSHOT_KEYS_V2 = new Set([
  ...SNAPSHOT_KEYS_V1, "dirtyAtFirstCheck", "becameDirty", "committedInWindow", "gitObservedTruncated",
]);
const SNAPSHOT_KEYS = new Set([...SNAPSHOT_KEYS_V2, "committedChanges"]);
// Net Git change per window-committed path, aligned index-for-index with committedInWindow.
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

/**
 * Shape-only repository-relative path check: it never resolves against a real
 * filesystem root, so it rejects every forbidden spelling (absolute, drive,
 * UNC/device, traversal, backslashes, control characters, private-root
 * segments) independent of any actual session cwd. Shared by the checkpoint
 * module's file-change validation and this module's recorded repository files.
 */
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

/**
 * Validate one git-observed path list: null when nullable (never measured),
 * else an array of at most MAX_FILES safe paths whose combined character
 * length stays within MAX_GIT_OBSERVED_LIST_CHARS. Returns undefined for any
 * shape violation so the caller can reject the whole record.
 */
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

/**
 * Validate the committed-change list: null (never measured, or a record from before version 3)
 * or exactly one fixed change per committedInWindow path. Undefined on any violation.
 */
function normalizeCommittedChanges(value, committedInWindow) {
  if (value === null) return null;
  if (!Array.isArray(committedInWindow) || !Array.isArray(value) || value.length !== committedInWindow.length) return undefined;
  return value.every((change) => COMMITTED_CHANGES.has(change)) ? [...value] : undefined;
}

/** Fields shared by every snapshot version; returns null on any violation. */
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

/**
 * Validate a candidate bounded historical repository snapshot. Every field is
 * checked against its documented bound; any violation, at any nesting level,
 * rejects the whole record rather than dropping the offending piece. Callers
 * that want lenient per-file/per-comparison fallback (the live-check path)
 * build their own candidate first and only call this as the final gate.
 *
 * A version-1 record (predating the Git-observed-files fields) is accepted
 * and transparently upgraded with empty/never-measured Git-observed fields,
 * and a version-2 record (predating committedChanges) is upgraded with
 * committedChanges null, so existing on-disk snapshots survive the upgrade.
 */
export function normalizeRepositorySnapshot(value) {
  if (!isPlainObject(value)) return null;
  if (value.version === 1) {
    if (!hasExactKeys(value, SNAPSHOT_KEYS_V1)) return null;
    const core = normalizeSnapshotCore(value);
    if (!core) return null;
    return Object.freeze({
      version: SNAPSHOT_VERSION,
      ...core,
      dirtyAtFirstCheck: null,
      becameDirty: Object.freeze([]),
      committedInWindow: null,
      committedChanges: null,
      gitObservedTruncated: false,
    });
  }
  const upgradingV2 = value.version === 2;
  if (upgradingV2 ? !hasExactKeys(value, SNAPSHOT_KEYS_V2) : (value.version !== SNAPSHOT_VERSION || !hasExactKeys(value, SNAPSHOT_KEYS))) return null;
  const core = normalizeSnapshotCore(value);
  if (!core) return null;
  const dirtyAtFirstCheck = normalizeGitObservedPathList(value.dirtyAtFirstCheck, { nullable: true });
  if (dirtyAtFirstCheck === undefined) return null;
  const becameDirty = normalizeGitObservedPathList(value.becameDirty, { nullable: false });
  if (becameDirty === undefined) return null;
  const committedInWindow = normalizeGitObservedPathList(value.committedInWindow, { nullable: true });
  if (committedInWindow === undefined) return null;
  const committedChanges = upgradingV2 ? null : normalizeCommittedChanges(value.committedChanges, committedInWindow);
  if (committedChanges === undefined) return null;
  if (typeof value.gitObservedTruncated !== "boolean") return null;
  return Object.freeze({
    version: SNAPSHOT_VERSION,
    ...core,
    dirtyAtFirstCheck: dirtyAtFirstCheck === null ? null : Object.freeze(dirtyAtFirstCheck),
    becameDirty: Object.freeze(becameDirty),
    committedInWindow: committedInWindow === null ? null : Object.freeze(committedInWindow),
    committedChanges: committedChanges === null ? null : Object.freeze(committedChanges),
    gitObservedTruncated: value.gitObservedTruncated,
  });
}

/**
 * Truncate a candidate path list to the shared bounds (at most MAX_FILES
 * entries, combined length at most MAX_GIT_OBSERVED_LIST_CHARS), sorted and
 * de-duplicated. Pure and total: never throws, always returns a list.
 */
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

/**
 * Pure derivation of the next Git-observed tracking fields from the previous
 * recorded snapshot (or null) and one live check's current working-tree files
 * plus this check's window-committed paths (undefined/null when this check
 * did not measure the window). `dirtyAtFirstCheck` is captured once, from the
 * very first call with no prior baseline, and never replaced afterward.
 * `becameDirty` is a sticky union of every current-status path seen since
 * that baseline that was not already part of it. `committedInWindow` carries
 * the previous value forward whenever this particular check could not read
 * the window; `committedChanges` travels with it, aligned to the kept paths
 * (null when this check read paths without change kinds). `gitObservedTruncated`
 * is sticky once any list is truncated.
 */
export function nextGitObserved(previous, { files, committedPaths, committedChanges } = {}) {
  const currentPaths = (Array.isArray(files) ? files : [])
    .map((file) => file?.path)
    .filter((path) => isSafeRecordedRepositoryPath(path));
  const hasBaseline = Array.isArray(previous?.dirtyAtFirstCheck);
  const baseline = hasBaseline ? { list: previous.dirtyAtFirstCheck, truncated: false } : truncatePathList(currentPaths);
  const baselineLookup = new Set(baseline.list);
  const priorBecameDirty = Array.isArray(previous?.becameDirty) ? previous.becameDirty : [];
  const newlyDirty = currentPaths.filter((path) => !baselineLookup.has(path));
  const becameDirty = truncatePathList([...priorBecameDirty, ...newlyDirty]);
  const measuredThisCheck = Array.isArray(committedPaths);
  const committed = measuredThisCheck
    ? truncatePathList(committedPaths)
    : { list: Array.isArray(previous?.committedInWindow) ? previous.committedInWindow : null, truncated: false };
  let changes = null;
  if (measuredThisCheck) {
    const changeByPath = new Map(Array.isArray(committedChanges) && committedChanges.length === committedPaths.length
      ? committedPaths.map((path, index) => [path, committedChanges[index]]) : []);
    const aligned = committed.list.map((path) => changeByPath.get(path));
    changes = aligned.every((change) => COMMITTED_CHANGES.has(change)) ? aligned : null;
  } else if (Array.isArray(previous?.committedChanges)) {
    changes = previous.committedChanges;
  }
  return {
    dirtyAtFirstCheck: baseline.list,
    becameDirty: becameDirty.list,
    committedInWindow: committed.list,
    committedChanges: changes,
    gitObservedTruncated: Boolean(previous?.gitObservedTruncated) || baseline.truncated || becameDirty.truncated || committed.truncated,
  };
}

/**
 * Project a recorded snapshot's Git-observed tracking into the public
 * committed/uncommitted file list ("committed" wins when a path is both). A
 * committed path carries its net Git change when recorded; otherwise null.
 * Returns null only for a record that has never had a live check populate
 * its baseline (a version-1-upgraded record, or one with no live check yet).
 */
export function gitObservedFilesFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.dirtyAtFirstCheck)) return null;
  const committed = Array.isArray(snapshot.committedInWindow) ? snapshot.committedInWindow : [];
  const becameDirty = Array.isArray(snapshot.becameDirty) ? snapshot.becameDirty : [];
  const changes = Array.isArray(snapshot.committedChanges) && snapshot.committedChanges.length === committed.length ? snapshot.committedChanges : null;
  const committedSet = new Set(committed);
  const merged = [
    ...committed.map((path, index) => ({ path, source: "committed", change: changes ? changes[index] : null })),
    ...becameDirty.filter((path) => !committedSet.has(path)).map((path) => ({ path, source: "uncommitted", change: null })),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    files: merged.slice(0, MAX_FILES),
    truncated: Boolean(snapshot.gitObservedTruncated) || merged.length > MAX_FILES,
  };
}

/**
 * Build a candidate snapshot from one live Git/pull-request check. Only the
 * repository's own files are re-validated (they were already validated
 * against the live root by git-state); comparison, pull requests, and
 * commitsInSession each independently carry the previous recorded value
 * forward when this particular check could not observe them. Returns null
 * (never a partial record) when the candidate fails final normalization; the
 * caller must keep whatever snapshot it already had.
 */
export function snapshotFromLiveCheck({ repository, pullRequests, commitsInSession, committedPaths, committedChanges, checkedAt, previous = null } = {}) {
  if (!repository || repository.available !== true || repository.historical !== false) return null;
  const files = (Array.isArray(repository.files) ? repository.files : [])
    .slice(0, MAX_FILES)
    .map((file) => (typeof file?.status === "string" && FILE_STATUS.test(file.status) && isSafeRecordedRepositoryPath(file?.path)
      ? { status: file.status, path: file.path }
      : null))
    .filter(Boolean);
  const takeComparison = repository.remote?.status === "ready";
  const comparison = takeComparison ? (repository.comparison ?? null) : (previous?.comparison ?? null);
  const comparisonCheckedAt = takeComparison ? (repository.remote?.checkedAt ?? null) : (previous?.comparisonCheckedAt ?? null);
  const takePullRequests = pullRequests?.status === "ready";
  const nextPullRequests = takePullRequests
    ? { checkedAt: pullRequests.checkedAt || checkedAt, items: Array.isArray(pullRequests.items) ? pullRequests.items : [] }
    : (previous?.pullRequests ?? null);
  const nextCommitsInSession = Number.isSafeInteger(commitsInSession) ? commitsInSession : (previous?.commitsInSession ?? null);
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
    ...nextGitObserved(previous, { files, committedPaths, committedChanges }),
  });
}

const UNAVAILABLE_PULL_REQUESTS = Object.freeze({ status: "unavailable", checkedAt: null, items: Object.freeze([]) });

/** Project a recorded, bounded snapshot into the public repository/pullRequests shapes. */
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

/** checkpointPublicState's historical repository resolution: recorded snapshot, else recordedGitState fallback. */
export function resolveCheckpointRepository({ historical, evidence, snapshot, recordedGitState, unavailableGitState, unavailablePullRequests }) {
  if (!historical) return { repository: { ...unavailableGitState(), historical: false }, pullRequests: unavailablePullRequests() };
  return historicalRepositoryFromSnapshot(snapshot)
    || { repository: recordedGitState(evidence.session.recordedGitBranch), pullRequests: unavailablePullRequests() };
}

/**
 * projectSelection's historical repository resolution: a recorded snapshot never
 * calls Git or GitHub; only the no-snapshot fallback reads recorded state and
 * (as today) asks the pull-request reader for historical association evidence.
 */
export async function resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot, recordedGitState, pullRequestReader, unavailablePullRequests }) {
  if (snapshot) return historicalRepositoryFromSnapshot(snapshot);
  const repository = recordedGitState(evidence.session.recordedGitBranch);
  let pullRequests;
  try {
    pullRequests = await pullRequestReader([], {
      cwd: evidence.session.cwd, branch: repository.branch, historical: true,
      sessionCreations: evidence.pullRequestCreations,
    });
  } catch {
    pullRequests = unavailablePullRequests();
  }
  return { repository, pullRequests };
}

/**
 * Net change for one path from its window statuses, newest first: deleted when the newest
 * change deleted it, added when any commit in the window added it, otherwise modified.
 */
function netCommittedChange(statusesNewestFirst) {
  if (statusesNewestFirst[0] === "D") return "deleted";
  return statusesNewestFirst.includes("A") ? "added" : "modified";
}

/**
 * Read commits on the current HEAD whose committer time falls inside
 * [since, until], with the distinct file paths they touched and each path's
 * net change (added/modified/deleted; a type change counts as modified). Only meaningful
 * when called on the live HEAD branch; a caller that knows the session's
 * recorded branch differs from HEAD should not call this at all. `git log
 * --name-status` reports paths relative to the repository's top level, the
 * same root `git status --porcelain` (and therefore repository.files) uses,
 * so no root remapping is needed between this reader's paths and the
 * session's other recorded repository paths. Every failure (missing root,
 * bad window, Git error, timeout, oversized output) resolves to null rather
 * than throwing.
 */
export function readCommitsInWindow(repositoryRoot, { since, until } = {}) {
  return new Promise((resolve) => {
    if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0
      || !isIsoTimestamp(since) || !isIsoTimestamp(until)) {
      resolve(null);
      return;
    }
    try {
      execFile("git", [
        "-c", "core.quotepath=false",
        "-C", repositoryRoot,
        "log", "--format=%H", "--name-status", "--no-renames", `--since=${since}`, `--until=${until}`, "HEAD",
      ], {
        encoding: "utf8",
        timeout: WINDOW_TIMEOUT_MS,
        maxBuffer: WINDOW_MAX_BUFFER,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) { resolve(null); return; }
        let count = 0;
        // git log lists commits newest first, so each path's statuses arrive newest first.
        const statusesByPath = new Map();
        for (const line of String(stdout).split(/\r?\n/u)) {
          if (!line) continue;
          if (COMMIT_HASH_LINE.test(line)) { count += 1; continue; }
          const match = NAME_STATUS_LINE.exec(line);
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

const DEFAULT_RECORDER_MAX_ENTRIES = 100;

/**
 * Bounded in-memory recorder for the sidecar repository snapshots persisted
 * next to session observation checkpoints. `record` is fire-and-forget from
 * the caller's perspective (it never throws and its returned promise never
 * rejects); `recorded` is a synchronous lookup so historical serving never
 * waits on, or triggers, disk or Git activity.
 */
export function createRepositorySnapshotRecorder({ store, now = () => Date.now(), maxEntries } = {}) {
  if (!store || typeof store.writeRepositorySnapshot !== "function" || typeof store.loadRepositorySnapshots !== "function") {
    throw new TypeError("Repository snapshot recorder requires a checkpoint store");
  }
  const bound = Number.isSafeInteger(maxEntries) && maxEntries > 0
    ? maxEntries
    : Number.isSafeInteger(store.maxEntries) && store.maxEntries > 0 ? store.maxEntries : DEFAULT_RECORDER_MAX_ENTRIES;
  // qualifiedId -> { snapshot, lastUsedAt }. Recency covers both writes and
  // reads, so an actively viewed historical session outlives an idle one.
  const entries = new Map();
  const pending = new Map();

  function retain(qualifiedId, snapshot) {
    entries.delete(qualifiedId);
    entries.set(qualifiedId, { snapshot, lastUsedAt: now() });
    while (entries.size > bound) entries.delete(entries.keys().next().value);
  }

  async function load() {
    let records;
    try {
      records = await store.loadRepositorySnapshots();
    } catch {
      return;
    }
    for (const record of records || []) {
      if (!record || typeof record.providerId !== "string" || typeof record.localSessionId !== "string" || !record.snapshot) continue;
      retain(`${record.providerId}:${record.localSessionId}`, record.snapshot);
    }
  }

  function record(qualifiedId, live) {
    const parsed = parseQualifiedSessionId(qualifiedId);
    if (!parsed) return Promise.resolve(false);
    const chain = (pending.get(qualifiedId) || Promise.resolve())
      .catch(() => {})
      // Derive only after the prior write for this session settles. A concurrent
      // second check must see the first check's retained dirty baseline rather
      // than independently treating its own working tree as the first check.
      .then(async () => {
        const previous = entries.get(qualifiedId)?.snapshot || null;
        let next = null;
        try {
          next = snapshotFromLiveCheck({
            repository: live?.repository,
            pullRequests: live?.pullRequests,
            commitsInSession: live?.commitsInSession,
            committedPaths: live?.committedPaths,
            committedChanges: live?.committedChanges,
            checkedAt: live?.checkedAt,
            previous,
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
    // Move to the most-recently-used end so a live-viewed historical session
    // outlives an idle one when the bound forces an eviction.
    entries.delete(qualifiedId);
    entry.lastUsedAt = now();
    entries.set(qualifiedId, entry);
    return entry.snapshot;
  }

  return Object.freeze({ load, record, recorded });
}
