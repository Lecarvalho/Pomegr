import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRepositorySnapshotRecorder,
  gitObservedFilesFromSnapshot,
  historicalRepositoryFromSnapshot,
  isSafeRecordedRepositoryPath,
  nextGitObserved,
  normalizeRepositorySnapshot,
  readCommitsInWindow,
  resolveCheckpointRepository,
  resolveHistoricalRepositoryAndPullRequests,
  snapshotFromLiveCheck,
} from "../monitor/repository-snapshot.mjs";
import { SessionObservationCheckpointStore } from "../monitor/session-observation-checkpoints.mjs";
import { projectSessionDomains } from "../monitor/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

function validSnapshot(overrides = {}) {
  return {
    version: 3,
    branch: "feat/example",
    isMain: false,
    files: [{ status: " M", path: "app/file.ts" }],
    comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 0, integrated: false },
    comparisonCheckedAt: "2026-09-20T12:00:00.000Z",
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 3,
    checkedAt: "2026-09-20T12:00:05.000Z",
    dirtyAtFirstCheck: ["app/file.ts"],
    becameDirty: [],
    committedInWindow: null,
    committedChanges: null,
    gitObservedTruncated: false,
    ...overrides,
  };
}

// The version-1 shape (predates the Git-observed-files fields), used only to exercise the
// upgrade path in normalizeRepositorySnapshot.
function validSnapshotV1(overrides = {}) {
  return {
    version: 1,
    branch: "feat/example",
    isMain: false,
    files: [{ status: " M", path: "app/file.ts" }],
    comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 0, integrated: false },
    comparisonCheckedAt: "2026-09-20T12:00:00.000Z",
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 3,
    checkedAt: "2026-09-20T12:00:05.000Z",
    ...overrides,
  };
}

function pullRequestItem(overrides = {}) {
  return {
    host: "github",
    repository: "Lecarvalho/pomegr",
    number: 24,
    title: "Draft PR",
    url: "https://github.com/Lecarvalho/pomegr/pull/24",
    state: "open",
    draft: true,
    headBranch: "feat/example",
    baseBranch: "main",
    additions: 842,
    deletions: 1117,
    updatedAt: "2026-09-20T11:00:00.000Z",
    association: "session",
    ...overrides,
  };
}

test("isSafeRecordedRepositoryPath accepts nested paths and rejects every unsafe spelling", () => {
  assert.equal(isSafeRecordedRepositoryPath("app/components/File.tsx"), true);
  assert.equal(isSafeRecordedRepositoryPath("a/b/c"), true);
  for (const unsafe of [
    "/etc/passwd",
    "C:/workspace/file.ts",
    "C:\\workspace\\file.ts",
    "\\\\server\\share\\file.ts",
    "../escape.ts",
    "app/../escape.ts",
    "app/./file.ts",
    "app//file.ts",
    "app/file.ts\u0000",
    ".claude/settings.json",
    "app/.codex/policy.json",
    "",
    "x".repeat(513),
  ]) {
    assert.equal(isSafeRecordedRepositoryPath(unsafe), false, `expected rejection for ${JSON.stringify(unsafe)}`);
  }
});

test("normalizeRepositorySnapshot accepts a fully valid record and freezes it", () => {
  const normalized = normalizeRepositorySnapshot(validSnapshot());
  assert.ok(normalized);
  assert.equal(normalized.branch, "feat/example");
  assert.equal(normalized.files.length, 1);
  assert.equal(normalized.pullRequests.items[0].url, "https://github.com/Lecarvalho/pomegr/pull/24");
  assert.throws(() => { normalized.branch = "mutated"; });
  assert.throws(() => { normalized.files.push({}); });
});

test("normalizeRepositorySnapshot rejects unsafe file paths, over-bound lists, foreign PR URLs and extra fields", () => {
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ files: [{ status: " M", path: "../escape.ts" }] })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ files: [{ status: " M", path: "C:\\absolute\\path.ts" }] })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({
    files: Array.from({ length: 201 }, (_, index) => ({ status: " M", path: `app/file-${index}.ts` })),
  })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: Array.from({ length: 11 }, (_, index) => pullRequestItem({ number: index + 1, url: `https://github.com/a/b/pull/${index + 1}` })) },
  })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem({ url: "https://gitlab.com/a/b/pull/24", host: "github" })] },
  })), null);
  assert.equal(normalizeRepositorySnapshot({ ...validSnapshot(), extraField: "unexpected" }), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ comparison: { ...validSnapshot().comparison, extra: 1 } })), null);
  assert.equal(normalizeRepositorySnapshot(null), null);
  assert.equal(normalizeRepositorySnapshot("not-an-object"), null);
});

test("normalizeRepositorySnapshot accepts a version-1 record and upgrades it to version 3 with a never-measured Git-observed baseline", () => {
  const upgraded = normalizeRepositorySnapshot(validSnapshotV1());
  assert.ok(upgraded);
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.branch, "feat/example");
  assert.equal(upgraded.dirtyAtFirstCheck, null, "never measured");
  assert.deepEqual(upgraded.becameDirty, []);
  assert.equal(upgraded.committedInWindow, null);
  assert.equal(upgraded.committedChanges, null);
  assert.equal(upgraded.gitObservedTruncated, false);
  assert.equal(gitObservedFilesFromSnapshot(upgraded), null, "gitObservedFilesFromSnapshot is null for a v1-upgraded record");

  // A record already carrying a v2-only key under version 1, or an unexpected extra key, is
  // rejected rather than silently accepted through either shape's key set.
  assert.equal(normalizeRepositorySnapshot({ ...validSnapshotV1(), dirtyAtFirstCheck: [] }), null);
  assert.equal(normalizeRepositorySnapshot({ ...validSnapshotV1(), extraField: 1 }), null);
});

test("normalizeRepositorySnapshot upgrades a version-2 record with committedChanges null, and validates version-3 committedChanges against committedInWindow", () => {
  const { committedChanges: _omitted, ...v2Shape } = validSnapshot({ committedInWindow: ["app/a.ts"] });
  const upgraded = normalizeRepositorySnapshot({ ...v2Shape, version: 2 });
  assert.ok(upgraded);
  assert.equal(upgraded.version, 3);
  assert.deepEqual(upgraded.committedInWindow, ["app/a.ts"]);
  assert.equal(upgraded.committedChanges, null, "a v2 record never recorded change kinds");
  assert.equal(normalizeRepositorySnapshot({ ...v2Shape, version: 2, committedChanges: ["added"] }), null, "a v3-only key under version 2 is rejected");

  const aligned = normalizeRepositorySnapshot(validSnapshot({ committedInWindow: ["app/a.ts", "app/b.ts"], committedChanges: ["added", "deleted"] }));
  assert.deepEqual(aligned.committedChanges, ["added", "deleted"]);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ committedInWindow: ["app/a.ts"], committedChanges: ["added", "modified"] })), null, "length mismatch");
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ committedInWindow: ["app/a.ts"], committedChanges: ["renamed"] })), null, "unknown change");
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ committedInWindow: null, committedChanges: [] })), null, "changes without measured paths");
});

test("normalizeRepositorySnapshot enforces the Git-observed field bounds: nullable dirtyAtFirstCheck/committedInWindow, always-array becameDirty, path/count/character caps", () => {
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ dirtyAtFirstCheck: null })).dirtyAtFirstCheck, null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ committedInWindow: null })).committedInWindow, null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ becameDirty: null })), null, "becameDirty is never nullable");
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ dirtyAtFirstCheck: ["../escape.ts"] })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({
    dirtyAtFirstCheck: Array.from({ length: 201 }, (_, index) => `app/file-${index}.ts`),
  })), null, "over the 200-entry cap");
  assert.equal(normalizeRepositorySnapshot(validSnapshot({
    becameDirty: Array.from({ length: 15 }, (_, index) => `app/${"x".repeat(495)}-${index}.ts`),
  })), null, "over the combined character budget even though each path and the count are individually in bounds");
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ gitObservedTruncated: "yes" })), null);
});

test("gitObservedFilesFromSnapshot merges committed and uncommitted paths, committed winning on overlap, sorted, and is null only for a never-measured record", () => {
  assert.equal(gitObservedFilesFromSnapshot(null), null);
  assert.equal(gitObservedFilesFromSnapshot({ dirtyAtFirstCheck: null, becameDirty: [], committedInWindow: null, gitObservedTruncated: false }), null);

  const measured = gitObservedFilesFromSnapshot({
    dirtyAtFirstCheck: [], becameDirty: ["app/b.ts", "app/shared.ts"], committedInWindow: ["app/a.ts", "app/shared.ts"], committedChanges: ["added", "modified"], gitObservedTruncated: false,
  });
  assert.deepEqual(measured, {
    files: [
      { path: "app/a.ts", source: "committed", change: "added" },
      { path: "app/b.ts", source: "uncommitted", change: null },
      { path: "app/shared.ts", source: "committed", change: "modified" },
    ],
    truncated: false,
  });
  assert.equal(gitObservedFilesFromSnapshot({
    dirtyAtFirstCheck: [], becameDirty: [], committedInWindow: ["app/a.ts"], committedChanges: null, gitObservedTruncated: false,
  }).files[0].change, null, "a record without change kinds (upgraded v2) projects change null");

  assert.deepEqual(
    gitObservedFilesFromSnapshot({ dirtyAtFirstCheck: [], becameDirty: [], committedInWindow: [], gitObservedTruncated: false }),
    { files: [], truncated: false },
    "a measured but empty record is { files: [], truncated: false }, not null",
  );
  assert.equal(
    gitObservedFilesFromSnapshot({ dirtyAtFirstCheck: [], becameDirty: [], committedInWindow: [], gitObservedTruncated: true }).truncated,
    true,
  );
});

test("nextGitObserved captures the dirty-at-first-check baseline once and never replaces it", () => {
  const first = nextGitObserved(null, { files: [{ status: " M", path: "app/a.ts" }, { status: "??", path: "app/b.ts" }] });
  assert.deepEqual(first.dirtyAtFirstCheck, ["app/a.ts", "app/b.ts"]);
  assert.deepEqual(first.becameDirty, [], "the baseline itself is not reported as newly dirty");
  assert.equal(first.committedInWindow, null, "not measured this check");
  assert.equal(first.gitObservedTruncated, false);

  const second = nextGitObserved(first, { files: [{ status: " M", path: "app/a.ts" }, { status: "??", path: "app/c.ts" }] });
  assert.deepEqual(second.dirtyAtFirstCheck, ["app/a.ts", "app/b.ts"], "baseline never replaced, even though app/b.ts is no longer dirty");
  assert.deepEqual(second.becameDirty, ["app/c.ts"]);
});

test("nextGitObserved's becameDirty is a sticky union: once a newly dirty path is seen it is never dropped, even after it goes clean again", () => {
  const first = nextGitObserved(null, { files: [] });
  assert.deepEqual(first.dirtyAtFirstCheck, []);
  const dirty = nextGitObserved(first, { files: [{ status: "??", path: "app/new.ts" }] });
  assert.deepEqual(dirty.becameDirty, ["app/new.ts"]);
  const cleanAgain = nextGitObserved(dirty, { files: [] });
  assert.deepEqual(cleanAgain.becameDirty, ["app/new.ts"], "still reported after the file goes clean again");
});

test("nextGitObserved carries committedInWindow forward on an unmeasured check and only replaces it when the window was actually read", () => {
  const first = nextGitObserved(null, { files: [], committedPaths: ["app/a.ts", "app/b.ts"] });
  assert.deepEqual(first.committedInWindow, ["app/a.ts", "app/b.ts"]);
  const unmeasured = nextGitObserved(first, { files: [], committedPaths: undefined });
  assert.deepEqual(unmeasured.committedInWindow, first.committedInWindow, "carried forward when this check could not read the window");
  const measuredEmpty = nextGitObserved(first, { files: [], committedPaths: [] });
  assert.deepEqual(measuredEmpty.committedInWindow, [], "an actual empty read replaces the previous value rather than carrying it forward");
});

test("nextGitObserved aligns committedChanges with the kept paths, carries them forward unmeasured, and drops them when a read has none", () => {
  const first = nextGitObserved(null, { files: [], committedPaths: ["app/b.ts", "app/a.ts"], committedChanges: ["deleted", "added"] });
  assert.deepEqual(first.committedInWindow, ["app/a.ts", "app/b.ts"]);
  assert.deepEqual(first.committedChanges, ["added", "deleted"], "re-aligned after the path list is sorted");
  const unmeasured = nextGitObserved(first, { files: [] });
  assert.deepEqual(unmeasured.committedChanges, ["added", "deleted"]);
  const withoutKinds = nextGitObserved(first, { files: [], committedPaths: ["app/a.ts"] });
  assert.equal(withoutKinds.committedChanges, null, "paths read without change kinds never guess one");
  const mismatched = nextGitObserved(first, { files: [], committedPaths: ["app/a.ts"], committedChanges: ["added", "modified"] });
  assert.equal(mismatched.committedChanges, null);
});

test("nextGitObserved bounds a maxed set of long paths so the resulting record stays under the repository-snapshot byte cap", () => {
  const longPaths = (prefix, count) => Array.from({ length: count }, (_, index) => `app/${prefix}/${"a".repeat(480)}-${index}.ts`);
  const files = longPaths("dirty", 400).map((filePath) => ({ status: " M", path: filePath }));
  const committedPaths = longPaths("committed", 400);
  const result = nextGitObserved(null, { files, committedPaths, committedChanges: committedPaths.map(() => "modified") });
  assert.ok(result.dirtyAtFirstCheck.length < 400, "the character budget truncated the baseline well under the 400 candidates");
  assert.ok(result.committedInWindow.length < 400, "the character budget truncated the committed list well under the 400 candidates");
  assert.equal(result.gitObservedTruncated, true);
  assert.equal(result.committedChanges.length, result.committedInWindow.length);

  const snapshot = normalizeRepositorySnapshot(validSnapshot({ ...result }));
  assert.ok(snapshot, "the bounded output is itself a valid record");
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024, "fits the checkpoint store's repository-snapshot byte cap");
});

test("snapshotFromLiveCheck builds a snapshot only for an available, non-historical live check", () => {
  const built = snapshotFromLiveCheck({
    repository: {
      available: true, branch: "main", historical: false, isMain: true,
      files: [{ status: " M", path: "app/file.ts" }],
      comparison: { branch: "origin/main", kind: "upstream", ahead: 0, behind: 0, integrated: false },
      remote: { status: "ready", checkedAt: "2026-09-20T12:00:00.000Z" },
    },
    pullRequests: { status: "ready", checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 2,
    checkedAt: "2026-09-20T12:00:05.000Z",
  });
  assert.ok(built);
  assert.equal(built.commitsInSession, 2);
  assert.equal(built.comparison.kind, "upstream");

  assert.equal(snapshotFromLiveCheck({ repository: { available: true, historical: true }, checkedAt: "2026-09-20T12:00:05.000Z" }), null);
  assert.equal(snapshotFromLiveCheck({ repository: { available: false, historical: false }, checkedAt: "2026-09-20T12:00:05.000Z" }), null);
  assert.equal(snapshotFromLiveCheck({}), null);
});

test("snapshotFromLiveCheck threads committedPaths into committedInWindow, and only newly dirty files appear as uncommitted", () => {
  const liveCheck = (files, previous) => snapshotFromLiveCheck({
    repository: {
      available: true, branch: "main", historical: false, isMain: true, files,
      comparison: null, remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 1,
    committedPaths: ["app/committed.ts"],
    committedChanges: ["added"],
    checkedAt: previous ? "2026-09-20T12:10:00.000Z" : "2026-09-20T12:00:05.000Z",
    previous,
  });

  const firstCheck = liveCheck([{ status: " M", path: "app/dirty.ts" }]);
  assert.ok(firstCheck);
  assert.deepEqual(firstCheck.dirtyAtFirstCheck, ["app/dirty.ts"]);
  assert.deepEqual(gitObservedFilesFromSnapshot(firstCheck), {
    files: [{ path: "app/committed.ts", source: "committed", change: "added" }],
    truncated: false,
  }, "the baseline-dirty file is not itself reported as uncommitted");

  const secondCheck = liveCheck([{ status: " M", path: "app/dirty.ts" }, { status: "??", path: "app/new.ts" }], firstCheck);
  assert.ok(secondCheck);
  assert.deepEqual(secondCheck.dirtyAtFirstCheck, ["app/dirty.ts"], "baseline unchanged");
  assert.deepEqual(secondCheck.becameDirty, ["app/new.ts"]);
  assert.deepEqual(gitObservedFilesFromSnapshot(secondCheck), {
    files: [
      { path: "app/committed.ts", source: "committed", change: "added" },
      { path: "app/new.ts", source: "uncommitted", change: null },
    ],
    truncated: false,
  });
});

test("snapshotFromLiveCheck carries the previous comparison, pull requests and commitsInSession forward on an unready check, never erasing", () => {
  const previous = normalizeRepositorySnapshot(validSnapshot());
  const built = snapshotFromLiveCheck({
    repository: {
      available: true, branch: "feat/example", historical: false, isMain: false,
      files: [{ status: "??", path: "app/new-file.ts" }],
      comparison: null,
      remote: { status: "checking", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: null,
    checkedAt: "2026-09-20T12:05:00.000Z",
    previous,
  });
  assert.ok(built, "a valid live check still produces a snapshot even when comparison/PR/commits are unready");
  assert.deepEqual(built.comparison, previous.comparison);
  assert.equal(built.comparisonCheckedAt, previous.comparisonCheckedAt);
  assert.deepEqual(built.pullRequests, previous.pullRequests);
  assert.equal(built.commitsInSession, previous.commitsInSession);
  assert.equal(built.files[0].path, "app/new-file.ts", "files always reflect the current live check");

  // A failing/historical check normalizes to null; the caller must keep the previous snapshot itself.
  assert.equal(snapshotFromLiveCheck({ repository: { available: false }, checkedAt: "2026-09-20T12:06:00.000Z", previous }), null);
});

test("historicalRepositoryFromSnapshot projects the recorded snapshot into the public repository/pullRequests shapes", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  assert.deepEqual(repository, {
    available: true,
    branch: "feat/example",
    files: snapshot.files,
    historical: true,
    isMain: false,
    comparison: snapshot.comparison,
    commits: [],
    remote: { status: "ready", checkedAt: snapshot.comparisonCheckedAt },
    recordedAt: snapshot.checkedAt,
    commitsInSession: 3,
  });
  assert.deepEqual(pullRequests, { status: "ready", checkedAt: snapshot.pullRequests.checkedAt, items: snapshot.pullRequests.items });
  assert.equal(historicalRepositoryFromSnapshot(null), null);
  // gitObserved must never sit on this object: it is what session.repository becomes verbatim,
  // and session.repository is what /api/state serializes verbatim (see session-domain-store.mjs's
  // separate options.gitObserved channel, matching options.fileHistory).
  assert.equal(Object.hasOwn(repository, "gitObserved"), false);

  const withoutComparisonOrPrs = normalizeRepositorySnapshot(validSnapshot({ comparison: null, comparisonCheckedAt: null, pullRequests: null, commitsInSession: null }));
  const noComparison = historicalRepositoryFromSnapshot(withoutComparisonOrPrs);
  assert.deepEqual(noComparison.repository.remote, { status: "unavailable", checkedAt: null });
  assert.deepEqual(noComparison.pullRequests, { status: "unavailable", checkedAt: null, items: [] });
  assert.equal(noComparison.repository.commitsInSession, null);
});

test("resolveCheckpointRepository and resolveHistoricalRepositoryAndPullRequests never call Git or GitHub when a snapshot exists", async () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const deps = {
    recordedGitState: () => assert.fail("must not call recordedGitState when a snapshot exists"),
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
    pullRequestReader: async () => assert.fail("must not call the pull-request reader when a snapshot exists"),
  };
  const evidence = { session: { cwd: "C:\\synthetic", recordedGitBranch: "feat/example" }, pullRequestCreations: [] };

  const fromCheckpoint = resolveCheckpointRepository({ historical: true, evidence, snapshot, ...deps });
  assert.equal(fromCheckpoint.repository.branch, "feat/example");
  assert.equal(fromCheckpoint.repository.historical, true);

  const fromSelection = await resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot, ...deps });
  assert.equal(fromSelection.repository.branch, "feat/example");

  const live = resolveCheckpointRepository({ historical: false, evidence, snapshot: null, ...deps });
  assert.equal(live.repository.historical, false);
  assert.equal(live.repository.available, false);
});

test("resolveCheckpointRepository and resolveHistoricalRepositoryAndPullRequests fall back to recordedGitState without a snapshot", async () => {
  let recordedGitStateCalls = 0;
  let pullRequestReaderCalls = 0;
  const deps = {
    recordedGitState: (branch) => { recordedGitStateCalls += 1; return { available: Boolean(branch), branch, files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }; },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
    pullRequestReader: async () => { pullRequestReaderCalls += 1; return { status: "ready", checkedAt: null, items: [] }; },
  };
  const evidence = { session: { cwd: "C:\\synthetic", recordedGitBranch: "recorded-branch" }, pullRequestCreations: [] };

  const fromCheckpoint = resolveCheckpointRepository({ historical: true, evidence, snapshot: null, ...deps });
  assert.equal(fromCheckpoint.repository.branch, "recorded-branch");
  assert.equal(recordedGitStateCalls, 1);
  assert.deepEqual(fromCheckpoint.pullRequests, { status: "unavailable", checkedAt: null, items: [] });

  const fromSelection = await resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot: null, ...deps });
  assert.equal(fromSelection.repository.branch, "recorded-branch");
  assert.equal(recordedGitStateCalls, 2);
  assert.equal(pullRequestReaderCalls, 1, "only projectSelection's fallback asks the pull-request reader");
  assert.equal(fromSelection.pullRequests.status, "ready");
});

async function commitFixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr count-commits & -"));
  context.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, GIT_AUTHOR_NAME: "Pomegr Test", GIT_AUTHOR_EMAIL: "pomegr@example.test", GIT_COMMITTER_NAME: "Pomegr Test", GIT_COMMITTER_EMAIL: "pomegr@example.test" };
  const run = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  run("init", "--initial-branch=main", "--quiet");
  const commit = async (relativePath, contents, message, iso) => {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    run("add", relativePath);
    execFileSync("git", ["-C", root, "commit", "-m", message], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
  };
  await commit("before.txt", "before", "before window", "2026-09-01T00:00:00Z");
  await commit("app/inside-one.ts", "one", "inside window one", "2026-09-10T00:00:00Z");
  await commit("app/inside-two.ts", "two", "inside window two", "2026-09-15T00:00:00Z");
  await commit("after.txt", "after", "after window", "2026-09-25T00:00:00Z");
  return root;
}

test("readCommitsInWindow reads the commit count and distinct changed paths on HEAD within [since, until], sorted, using an argument array, and resolves null on failure", async (context) => {
  const root = await commitFixture(context);
  const result = await readCommitsInWindow(root, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(result, { count: 2, paths: ["app/inside-one.ts", "app/inside-two.ts"], changes: ["added", "added"], truncated: false });

  const none = await readCommitsInWindow(root, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" });
  assert.deepEqual(none, { count: 0, paths: [], changes: [], truncated: false });

  assert.equal(await readCommitsInWindow(path.join(os.tmpdir(), "pomegr-not-a-repo-xyz"), { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" }), null);
  assert.equal(await readCommitsInWindow(root, { since: "not-a-date", until: "2026-09-20T00:00:00.000Z" }), null);
  assert.equal(await readCommitsInWindow(null, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" }), null);
});

test("readCommitsInWindow nets each path's change across the window: added wins over later edits, a final delete wins, and edits of older files are modified", async (context) => {
  const root = await commitFixture(context);
  const env = { ...process.env, GIT_AUTHOR_NAME: "Pomegr Test", GIT_AUTHOR_EMAIL: "pomegr@example.test", GIT_COMMITTER_NAME: "Pomegr Test", GIT_COMMITTER_EMAIL: "pomegr@example.test" };
  const commitAll = async (message, iso, change) => {
    await change();
    execFileSync("git", ["-C", root, "add", "-A"], { stdio: ["ignore", "pipe", "pipe"], env });
    execFileSync("git", ["-C", root, "commit", "-m", message], { stdio: ["ignore", "pipe", "pipe"], env: { ...env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso } });
  };
  await commitAll("edit added file", "2026-09-26T00:00:00Z", () => writeFile(path.join(root, "app/inside-one.ts"), "one edited"));
  await commitAll("edit older file", "2026-09-27T00:00:00Z", () => writeFile(path.join(root, "before.txt"), "before edited"));
  await commitAll("delete file", "2026-09-28T00:00:00Z", () => rm(path.join(root, "app/inside-two.ts")));

  const result = await readCommitsInWindow(root, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z" });
  assert.deepEqual(result.paths, ["after.txt", "app/inside-one.ts", "app/inside-two.ts", "before.txt"]);
  assert.deepEqual(result.changes, ["added", "added", "deleted", "modified"]);
});

test("readCommitsInWindow and git status report paths relative to the same repository root (the top level), from a subdirectory cwd", async (context) => {
  const root = await commitFixture(context);
  // Confirms the path-root finding: git status --porcelain (repository.files) and git log
  // --name-status (readCommitsInWindow) both report paths relative to the repository's top level
  // even when invoked from a nested subdirectory, so a live check's repositoryRoot needs no
  // remapping between the two.
  const subdirectory = path.join(root, "app");
  const status = execFileSync("git", ["-C", subdirectory, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8" });
  assert.equal(status.trim(), "", "the fixture leaves a clean working tree");
  const result = await readCommitsInWindow(subdirectory, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(result.paths, ["app/inside-one.ts", "app/inside-two.ts"], "paths from a subdirectory cwd are still relative to the top level, matching repository.files");
});

async function temporaryCheckpointDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-repository-snapshot-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the recorder never erases a snapshot on a failed live check and skips an unchanged record", async (context) => {
  const store = new SessionObservationCheckpointStore({ directory: await temporaryCheckpointDirectory(context) });
  const recorder = createRepositorySnapshotRecorder({ store });
  const live = {
    repository: {
      available: true, branch: "main", historical: false, isMain: true, files: [],
      comparison: null, remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 1,
    checkedAt: "2026-09-20T12:00:00.000Z",
  };
  assert.equal(await recorder.record("claude:session-one", live), true);
  const first = recorder.recorded("claude:session-one");
  assert.ok(first);
  assert.equal(first.commitsInSession, 1);

  assert.equal(await recorder.record("claude:session-one", live), false, "an unchanged candidate is a no-op");
  assert.equal(await recorder.record("claude:session-one", { repository: { available: false, historical: false }, checkedAt: "2026-09-20T12:01:00.000Z" }), false);
  assert.deepEqual(recorder.recorded("claude:session-one"), first, "a failed check never erases the last recorded snapshot");
  assert.equal(await recorder.record("not-a-qualified-id", live), false);
  assert.equal(recorder.recorded(42), null);
});

test("the recorder derives an overlapping check after the prior session write settles", async () => {
  let releaseFirstWrite;
  const firstWriteHeld = new Promise((resolve) => { releaseFirstWrite = resolve; });
  let firstWriteStarted;
  const firstWriteStartedPromise = new Promise((resolve) => { firstWriteStarted = resolve; });
  const writes = [];
  const store = {
    loadRepositorySnapshots: async () => [],
    writeRepositorySnapshot: async (_providerId, _localSessionId, candidate) => {
      writes.push(candidate);
      if (writes.length === 1) {
        firstWriteStarted();
        await firstWriteHeld;
      }
    },
  };
  const recorder = createRepositorySnapshotRecorder({ store });
  const live = (files, checkedAt) => ({
    repository: {
      available: true, branch: "main", historical: false, isMain: true, files,
      comparison: null, remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 1,
    checkedAt,
  });

  const first = recorder.record("claude:overlap", live([{ status: " M", path: "app/baseline.ts" }], "2026-09-20T12:00:00.000Z"));
  await firstWriteStartedPromise;
  const second = recorder.record("claude:overlap", live([
    { status: " M", path: "app/baseline.ts" },
    { status: "??", path: "app/newly-dirty.ts" },
  ], "2026-09-20T12:01:00.000Z"));
  releaseFirstWrite();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  const recorded = recorder.recorded("claude:overlap");
  assert.deepEqual(writes[0].dirtyAtFirstCheck, ["app/baseline.ts"]);
  assert.deepEqual(recorded.dirtyAtFirstCheck, ["app/baseline.ts"], "the first persisted check remains the dirty baseline");
  assert.deepEqual(recorded.becameDirty, ["app/newly-dirty.ts"], "the overlapping second check is compared with that baseline");
});

test("the recorder restores its snapshots after a restart via the same checkpoint directory", async (context) => {
  const directory = await temporaryCheckpointDirectory(context);
  const firstStore = new SessionObservationCheckpointStore({ directory });
  const firstRecorder = createRepositorySnapshotRecorder({ store: firstStore });
  const live = {
    repository: {
      available: true, branch: "feat/restart", historical: false, isMain: false,
      files: [{ status: " M", path: "app/file.ts" }],
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false },
      remote: { status: "ready", checkedAt: "2026-09-20T12:00:00.000Z" },
    },
    pullRequests: { status: "ready", checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 4,
    committedPaths: ["app/committed.ts"],
    checkedAt: "2026-09-20T12:00:05.000Z",
  };
  assert.equal(await firstRecorder.record("codex:restart-session", live), true);
  const beforeRestart = firstRecorder.recorded("codex:restart-session");
  assert.equal(beforeRestart.branch, "feat/restart");
  assert.deepEqual(beforeRestart.dirtyAtFirstCheck, ["app/file.ts"], "the baseline is captured on the very first check");

  const secondStore = new SessionObservationCheckpointStore({ directory });
  const secondRecorder = createRepositorySnapshotRecorder({ store: secondStore });
  assert.equal(secondRecorder.recorded("codex:restart-session"), null, "a fresh recorder has not loaded yet");
  await secondRecorder.load();
  const restored = secondRecorder.recorded("codex:restart-session");
  assert.ok(restored);
  assert.equal(restored.branch, "feat/restart");
  assert.equal(restored.commitsInSession, 4);
  assert.deepEqual(restored.pullRequests.items, live.pullRequests.items);
  // The baseline and committed-window lists persist across a monitor restart (a fresh recorder,
  // loaded from the same checkpoint directory, sees exactly what the first recorder had written).
  assert.deepEqual(restored.dirtyAtFirstCheck, ["app/file.ts"]);
  assert.deepEqual(restored.committedInWindow, ["app/committed.ts"]);

  // A live check after restart, with no in-memory carry-forward, still keeps the restored
  // baseline and correctly resumes committedInWindow tracking from the restored snapshot.
  const afterRestartCheck = {
    repository: {
      available: true, branch: "feat/restart", historical: false, isMain: false,
      files: [{ status: " M", path: "app/file.ts" }, { status: "??", path: "app/post-restart.ts" }],
      comparison: { branch: "origin/main", kind: "base", ahead: 1, behind: 0, integrated: false },
      remote: { status: "ready", checkedAt: "2026-09-20T13:00:00.000Z" },
    },
    pullRequests: { status: "ready", checkedAt: "2026-09-20T12:00:00.000Z", items: [pullRequestItem()] },
    commitsInSession: 4,
    checkedAt: "2026-09-20T13:00:05.000Z",
  };
  assert.equal(await secondRecorder.record("codex:restart-session", afterRestartCheck), true);
  const afterRestart = secondRecorder.recorded("codex:restart-session");
  assert.deepEqual(afterRestart.dirtyAtFirstCheck, ["app/file.ts"], "baseline survives the restart and is still never replaced");
  assert.deepEqual(afterRestart.becameDirty, ["app/post-restart.ts"]);
  assert.deepEqual(afterRestart.committedInWindow, ["app/committed.ts"], "carried forward from the restored snapshot since this check did not measure the window");
});

function stateWithRepository(repository, executionTasks = []) {
  const base = createEmptyMonitorState({ connected: true, source: "Claude Code", view: "history" });
  return {
    ...base,
    executionTasks,
    session: {
      id: "claude:historical-session",
      title: "Historical session",
      project: "pomegr",
      cwd: null,
      startedAt: "2026-09-20T11:00:00.000Z",
      updatedAt: "2026-09-20T12:00:05.000Z",
      durationMs: 3_600_000,
      cost: null,
      summary: null,
      progress: null,
      pomegrPlugin: null,
      signal: null,
      repositoryId: "repo-1",
      contextInventoryRef: null,
      repository,
      pullRequests: null,
    },
    readiness: { core: "ready", agentEvidence: "ready", contextEvidence: "ready", activityEvidence: "ready", repository: "ready", resources: "unavailable", usageLimits: "unavailable" },
  };
}

test("the repository domain serves recorded historical files and never the current working tree", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot({
    files: [
      { status: " M", path: "app/components/Nested/File.tsx" },
      { status: "??", path: "app/new.ts" },
    ],
  }));
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  const state = stateWithRepository(repository, [
    { id: "task-1", label: "git status", kind: "shell", workKind: "git", status: "completed", background: false, backgroundId: null, startedAt: "2026-09-20T11:00:00.000Z", finishedAt: "2026-09-20T11:00:01.000Z", exitCode: 0, failureCause: null },
    { id: "task-2", label: "git push", kind: "shell", workKind: "git_push", status: "failed", background: false, backgroundId: null, startedAt: "2026-09-20T11:05:00.000Z", finishedAt: "2026-09-20T11:05:01.000Z", exitCode: 1, failureCause: "process_error" },
    { id: "task-3", label: "npm test", kind: "shell", workKind: "test", status: "completed", background: false, backgroundId: null, startedAt: "2026-09-20T11:06:00.000Z", finishedAt: "2026-09-20T11:06:01.000Z", exitCode: 0, failureCause: null },
  ]);
  state.session.pullRequests = pullRequests;

  const { domains } = projectSessionDomains("claude:historical-session", { publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }, {
    // A historical session has no live root; passing one anyway must never leak current-tree data.
    repositoryRoot: "C:\\Workspace\\repos\\Pomegr",
    forbiddenRoots: [],
  });
  const repositoryDomain = domains.get("repository");
  assert.deepEqual(repositoryDomain.repository.files, [
    { status: " M", path: "app/components/Nested/File.tsx" },
    { status: "??", path: "app/new.ts" },
  ]);
  assert.equal(repositoryDomain.repository.commits.length, 0);
  assert.equal(repositoryDomain.recordedAt, snapshot.checkedAt);
  assert.equal(repositoryDomain.commitsInSession, 3);
  assert.deepEqual(repositoryDomain.gitTasks, { total: 2, failed: 1 });

  const serialized = JSON.stringify(repositoryDomain);
  assert.doesNotMatch(serialized, /C:\\Workspace|C:\/Workspace|"cwd"/i, "no absolute path leaks into the serialized domain");
  assert.doesNotMatch(serialized, /origin\/main.*fetch|remote\.pomegr|git rev-list|git log/i, "no raw Git command output leaks");
  const urls = [...serialized.matchAll(/https?:\/\/\S+?"/g)].map((match) => match[0]);
  assert.ok(urls.every((url) => url.startsWith('"https://github.com/'.slice(1)) || url.startsWith("https://github.com/")), `unexpected remote URL beyond a pull-request URL: ${urls}`);
});

test("the repository domain has no recorded snapshot for a historical session without one, and omits gitTasks until activity evidence is ready", () => {
  const state = stateWithRepository({
    available: Boolean("recorded-branch"), branch: "recorded-branch", files: [], historical: true,
    isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null },
  });
  state.readiness = { ...state.readiness, activityEvidence: "loading" };
  const { domains } = projectSessionDomains("claude:historical-session", { publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }, {});
  const repositoryDomain = domains.get("repository");
  assert.equal(repositoryDomain.recordedAt, null);
  assert.equal(repositoryDomain.commitsInSession, null);
  assert.equal(repositoryDomain.gitTasks, null);
  assert.deepEqual(repositoryDomain.repository.files, []);
  assert.equal(repositoryDomain.gitObservedFiles, null);
});

test("the repository domain's gitObservedFiles comes only from options.gitObserved, re-validated, and never appears on session.repository (which /api/state serializes verbatim)", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  const state = stateWithRepository(repository);
  state.session.pullRequests = pullRequests;
  const baseArgs = [{ publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }];

  const gitObserved = { files: [{ path: "app/new.ts", source: "committed", change: "added" }, { path: "app/dirty.ts", source: "uncommitted", change: null }], truncated: false };
  const withGitObserved = projectSessionDomains("claude:historical-session", ...baseArgs, { gitObserved });
  assert.deepEqual(withGitObserved.domains.get("repository").gitObservedFiles, gitObserved);

  // An unknown change, or a change on an uncommitted path, degrades to null rather than leaking.
  const oddChanges = projectSessionDomains("claude:historical-session", ...baseArgs, {
    gitObserved: { files: [{ path: "app/new.ts", source: "committed", change: "renamed" }, { path: "app/dirty.ts", source: "uncommitted", change: "added" }], truncated: false },
  });
  assert.deepEqual(oddChanges.domains.get("repository").gitObservedFiles.files.map((file) => file.change), [null, null]);
  assert.equal(Object.hasOwn(state.session.repository, "gitObserved"), false, "never attached to the raw session.repository object");
  assert.doesNotMatch(JSON.stringify(state.session), /gitObserved/, "gitObserved never enters the object /api/state would serialize verbatim");

  // Malformed input (an unsafe path) degrades to null rather than leaking a partially-valid shape.
  const malformed = projectSessionDomains("claude:historical-session", ...baseArgs, {
    gitObserved: { files: [{ path: "../escape.ts", source: "committed" }], truncated: false },
  });
  assert.equal(malformed.domains.get("repository").gitObservedFiles, null);

  // No options.gitObserved at all (e.g. a session with no recorded Git-observed snapshot yet).
  const missing = projectSessionDomains("claude:historical-session", ...baseArgs, {});
  assert.equal(missing.domains.get("repository").gitObservedFiles, null);
});

test("the session summary counts the Touched here files (recorded plus Git-observed, deduplicated) only once file history is ready", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  const state = stateWithRepository(repository);
  state.session.pullRequests = pullRequests;
  const baseArgs = [{ publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }];
  const recorded = (path, fileId) => ({ fileId, path, kind: "edited", changeCount: 1, lastObservedAt: "2026-09-14T12:00:00.000Z" });
  const fileHistory = { readiness: "ready", files: [recorded("app/a.ts", "f1"), recorded("app/b.ts", "f2")], truncated: false };
  const gitObserved = { files: [{ path: "app/b.ts", source: "committed" }, { path: "app/c.ts", source: "uncommitted" }], truncated: false };

  const ready = projectSessionDomains("claude:historical-session", ...baseArgs, { fileHistory, gitObserved });
  assert.equal(ready.domains.get("session-summary").repository.touchedFiles, 3);
  assert.doesNotMatch(JSON.stringify(ready.domains.get("session-summary")), /app\/[abc]\.ts/, "only the count reaches the summary");

  const loading = projectSessionDomains("claude:historical-session", ...baseArgs, { fileHistory: { ...fileHistory, readiness: "loading" }, gitObserved });
  assert.equal(loading.domains.get("session-summary").repository.touchedFiles, null);
});
