import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  countCommitsInWindow,
  createRepositorySnapshotRecorder,
  historicalRepositoryFromSnapshot,
  isSafeRecordedRepositoryPath,
  normalizeRepositorySnapshot,
  resolveCheckpointRepository,
  resolveHistoricalRepositoryAndPullRequests,
  snapshotFromLiveCheck,
} from "../monitor/repository-snapshot.mjs";
import { SessionObservationCheckpointStore } from "../monitor/session-observation-checkpoints.mjs";
import { projectSessionDomains } from "../monitor/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../shared/monitor-state.mjs";

function validSnapshot(overrides = {}) {
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
  const commit = (message, iso) => {
    execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", message], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
  };
  commit("before window", "2026-09-01T00:00:00Z");
  commit("inside window one", "2026-09-10T00:00:00Z");
  commit("inside window two", "2026-09-15T00:00:00Z");
  commit("after window", "2026-09-25T00:00:00Z");
  return root;
}

test("countCommitsInWindow counts commits on HEAD within [since, until] using an argument array, and resolves null on failure", async (context) => {
  const root = await commitFixture(context);
  const count = await countCommitsInWindow(root, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" });
  assert.equal(count, 2);
  const none = await countCommitsInWindow(root, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z" });
  assert.equal(none, 0);

  assert.equal(await countCommitsInWindow(path.join(os.tmpdir(), "pomegr-not-a-repo-xyz"), { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" }), null);
  assert.equal(await countCommitsInWindow(root, { since: "not-a-date", until: "2026-09-20T00:00:00.000Z" }), null);
  assert.equal(await countCommitsInWindow(null, { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" }), null);
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
    checkedAt: "2026-09-20T12:00:05.000Z",
  };
  assert.equal(await firstRecorder.record("codex:restart-session", live), true);
  assert.equal(firstRecorder.recorded("codex:restart-session").branch, "feat/restart");

  const secondStore = new SessionObservationCheckpointStore({ directory });
  const secondRecorder = createRepositorySnapshotRecorder({ store: secondStore });
  assert.equal(secondRecorder.recorded("codex:restart-session"), null, "a fresh recorder has not loaded yet");
  await secondRecorder.load();
  const restored = secondRecorder.recorded("codex:restart-session");
  assert.ok(restored);
  assert.equal(restored.branch, "feat/restart");
  assert.equal(restored.commitsInSession, 4);
  assert.deepEqual(restored.pullRequests.items, live.pullRequests.items);
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
});
