import { execFile } from "node:child_process";

const CONTROL = /[\u0000-\u001f\u007f]/u;
const RECORDED_PATH_DRIVE = /^[A-Za-z]:/u;
const FILE_STATUS = /^[ MADRCUT?!]{2}$/u;
const MAX_FILES = 200;
const MAX_PULL_REQUESTS = 10;
const MAX_COUNT = 100_000;
const SNAPSHOT_VERSION = 1;
const COUNT_TIMEOUT_MS = 3_000;
const COUNT_MAX_BUFFER = 64 * 1024;

const SNAPSHOT_KEYS = new Set([
  "version", "branch", "isMain", "files", "comparison", "comparisonCheckedAt",
  "pullRequests", "commitsInSession", "checkedAt",
]);
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
 * Validate a candidate bounded historical repository snapshot. Every field is
 * checked against its documented bound; any violation, at any nesting level,
 * rejects the whole record rather than dropping the offending piece. Callers
 * that want lenient per-file/per-comparison fallback (the live-check path)
 * build their own candidate first and only call this as the final gate.
 */
export function normalizeRepositorySnapshot(value) {
  if (!hasExactKeys(value, SNAPSHOT_KEYS) || value.version !== SNAPSHOT_VERSION) return null;
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
  return Object.freeze({
    version: SNAPSHOT_VERSION,
    branch: value.branch,
    isMain: value.isMain,
    files: Object.freeze(files.map((file) => Object.freeze(file))),
    comparison: comparison ? Object.freeze(comparison) : null,
    comparisonCheckedAt: value.comparisonCheckedAt,
    pullRequests: pullRequests ? Object.freeze({ ...pullRequests, items: Object.freeze(pullRequests.items.map((item) => Object.freeze(item))) }) : null,
    commitsInSession: value.commitsInSession,
    checkedAt: value.checkedAt,
  });
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
export function snapshotFromLiveCheck({ repository, pullRequests, commitsInSession, checkedAt, previous = null } = {}) {
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
 * Count commits on the current HEAD whose committer time falls inside
 * [since, until]. Only meaningful when called on the live HEAD branch; a
 * caller that knows the session's recorded branch differs from HEAD should
 * not call this at all. Every failure (missing root, bad window, Git error,
 * timeout) resolves to null rather than throwing.
 */
export function countCommitsInWindow(repositoryRoot, { since, until } = {}) {
  return new Promise((resolve) => {
    if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0
      || !isIsoTimestamp(since) || !isIsoTimestamp(until)) {
      resolve(null);
      return;
    }
    try {
      execFile("git", [
        "-C", repositoryRoot,
        "rev-list", "--count", `--since=${since}`, `--until=${until}`, "HEAD",
      ], {
        encoding: "utf8",
        timeout: COUNT_TIMEOUT_MS,
        maxBuffer: COUNT_MAX_BUFFER,
        windowsHide: true,
      }, (error, stdout) => {
        if (error) { resolve(null); return; }
        const count = Number.parseInt(String(stdout).trim(), 10);
        resolve(isBoundedCount(count) ? count : null);
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
    const previous = entries.get(qualifiedId)?.snapshot || null;
    let next = null;
    try {
      next = snapshotFromLiveCheck({
        repository: live?.repository,
        pullRequests: live?.pullRequests,
        commitsInSession: live?.commitsInSession,
        checkedAt: live?.checkedAt,
        previous,
      });
    } catch {
      next = null;
    }
    if (!next || (previous && JSON.stringify(previous) === JSON.stringify(next))) return Promise.resolve(false);
    const chain = (pending.get(qualifiedId) || Promise.resolve())
      .catch(() => {})
      .then(() => store.writeRepositorySnapshot(parsed.providerId, parsed.localSessionId, next))
      .then(() => { retain(qualifiedId, next); return true; })
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
