import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRepositorySnapshotRecorder,
  gitObservedFilesFromSnapshot,
  historicalRepositoryFromSnapshot,
  isSafeRecordedRepositoryPath,
  normalizeRepositorySnapshot,
  resolveCheckpointRepository,
  resolveHistoricalRepositoryAndPullRequests,
  snapshotFromLiveCheck,
  sessionRepositorySnapshot,
} from "../../../server/repository/repository-snapshot.mjs";
import { SessionObservationCheckpointStore } from "../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";
import { projectSessionDomains } from "../../../server/sessions/domain/session-domain-projection.mjs";
import { createEmptyMonitorState } from "../../../shared/monitor-state.mjs";
import { LEGACY_VALUES, REPOSITORY_ID, legacySnapshot, pullRequestItem, validSnapshot } from "../../helpers/repository-snapshot-records.mjs";

test("isSafeRecordedRepositoryPath accepts nested paths and rejects every unsafe spelling", () => {
  assert.equal(isSafeRecordedRepositoryPath("app/components/File.tsx"), true);
  assert.equal(isSafeRecordedRepositoryPath("a/b/c"), true);
  for (const unsafe of [
    "/etc/passwd",
    "C:/workspace/file.ts",
    "C:\\workspace\\file.ts",
    "\\\\server\\share\\file.ts",
    "../../../escape.ts",
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
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ files: [{ status: " M", path: "../../../escape.ts" }] })), null);
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

test("normalizeRepositorySnapshot loads a version 1 to 5 record as version 6 with never-measured session commits, dropping the old window-wide lists", () => {
  for (const version of [1, 2, 3, 4, 5]) {
    const record = legacySnapshot(version);
    const upgraded = normalizeRepositorySnapshot(record);
    assert.ok(upgraded, `version ${version} loads`);
    assert.equal(upgraded.version, 6);
    assert.equal(upgraded.branch, "feat/example");
    assert.equal(upgraded.commitsInSession, 3);
    assert.equal(upgraded.sessionCommitPaths, null, `version ${version}: never measured, not converted from committedInWindow`);
    assert.equal(upgraded.sessionCommitChanges, null);
    assert.equal(upgraded.sessionCommitsTruncated, false);
    assert.equal(upgraded.repositoryId, version >= 4 ? REPOSITORY_ID : null, "a version that predates the identity loads it as null");
    assert.deepEqual(upgraded.commitTimesInWindow, version >= 5 ? LEGACY_VALUES.commitTimesInWindow : null, "a version that predates commit times loads them as null");
    for (const dropped of ["dirtyAtFirstCheck", "becameDirty", "committedInWindow", "committedChanges", "gitObservedTruncated"]) {
      assert.equal(Object.hasOwn(upgraded, dropped), false, `version ${version}: ${dropped} is dropped`);
    }
    assert.equal(gitObservedFilesFromSnapshot(upgraded), null, `version ${version}: an upgraded record serves no Git-observed files`);

    // Each version keeps its own exact key set.
    assert.equal(normalizeRepositorySnapshot({ ...record, extraField: 1 }), null, `version ${version}: unexpected key`);
    assert.equal(normalizeRepositorySnapshot({ ...record, sessionCommitPaths: ["app/a.ts"] }), null, `version ${version}: a version-6 key under an older version`);
    assert.equal(normalizeRepositorySnapshot({ ...record, version: 6 }), null, `version ${version}: an older shape under version 6`);
  }
  assert.equal(normalizeRepositorySnapshot({ ...legacySnapshot(1), dirtyAtFirstCheck: [] }), null, "a version-2 key under version 1");
  assert.equal(normalizeRepositorySnapshot({ ...legacySnapshot(2), committedChanges: ["added"] }), null, "a version-3 key under version 2");
  assert.equal(normalizeRepositorySnapshot({ ...legacySnapshot(3), repositoryId: null }), null, "a version-4 key under version 3");
  assert.equal(normalizeRepositorySnapshot({ ...legacySnapshot(4), commitTimesInWindow: [] }), null, "a version-5 key under version 4");
  assert.equal(normalizeRepositorySnapshot({ ...validSnapshot(), version: 5 }), null, "a version-6 shape under version 5");
  assert.equal(normalizeRepositorySnapshot({ ...validSnapshot(), version: 7 }), null, "a newer version is never read");
});

test("normalizeRepositorySnapshot still validates the old window-wide lists of a version 2 to 5 record and rejects the whole record on a bad one", () => {
  for (const version of [2, 3, 4, 5]) {
    for (const [label, overrides] of [
      ["an unsafe dirtyAtFirstCheck path", { dirtyAtFirstCheck: ["../../../escape.ts"] }],
      ["an unsafe committedInWindow path", { committedInWindow: ["C:\\absolute\\path.ts"] }],
      ["a null becameDirty", { becameDirty: null }],
      ["a dirtyAtFirstCheck over the 200-entry cap", { dirtyAtFirstCheck: Array.from({ length: 201 }, (_, index) => `app/file-${index}.ts`) }],
      ["a becameDirty over the character budget although each path and the count are in bounds", { becameDirty: Array.from({ length: 15 }, (_, index) => `app/${"x".repeat(495)}-${index}.ts`) }],
      ["a non-boolean gitObservedTruncated", { gitObservedTruncated: "yes" }],
    ]) {
      assert.equal(normalizeRepositorySnapshot(legacySnapshot(version, overrides)), null, `version ${version}: ${label}`);
    }
    const neverMeasured = normalizeRepositorySnapshot(legacySnapshot(version, { dirtyAtFirstCheck: null, committedInWindow: null, committedChanges: null }));
    assert.ok(neverMeasured, `version ${version}: a never-measured baseline and window are valid`);
    assert.equal(neverMeasured.sessionCommitPaths, null);
  }
  for (const version of [3, 4, 5]) {
    for (const [label, overrides] of [
      ["fewer paths than committedChanges", { committedInWindow: ["app/a.ts"], committedChanges: ["added", "modified"] }],
      ["an unknown committedChanges entry", { committedInWindow: ["app/a.ts"], committedChanges: ["renamed"] }],
      ["committedChanges without measured paths", { committedInWindow: null, committedChanges: [] }],
    ]) {
      assert.equal(normalizeRepositorySnapshot(legacySnapshot(version, overrides)), null, `version ${version}: ${label}`);
    }
  }
});

test("normalizeRepositorySnapshot validates the repository identity", () => {
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ repositoryId: REPOSITORY_ID })).repositoryId, REPOSITORY_ID);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ repositoryId: "repo-not-an-id" })), null);
  assert.equal(normalizeRepositorySnapshot(validSnapshot({ repositoryId: 7 })), null);
});

test("normalizeRepositorySnapshot validates the session-commit fields as a whole: nullable paths, aligned changes, path/count/character caps, boolean truncation", () => {
  const neverRead = normalizeRepositorySnapshot(validSnapshot());
  assert.equal(neverRead.sessionCommitPaths, null);
  assert.equal(neverRead.sessionCommitChanges, null);
  assert.equal(neverRead.sessionCommitsTruncated, false);

  const aligned = normalizeRepositorySnapshot(validSnapshot({
    sessionCommitPaths: ["app/a.ts", "app/b.ts"], sessionCommitChanges: ["added", "deleted"], sessionCommitsTruncated: true,
  }));
  assert.deepEqual(aligned.sessionCommitPaths, ["app/a.ts", "app/b.ts"]);
  assert.deepEqual(aligned.sessionCommitChanges, ["added", "deleted"]);
  assert.equal(aligned.sessionCommitsTruncated, true);
  assert.throws(() => { aligned.sessionCommitPaths.push("app/c.ts"); }, "the recorded path list is frozen");
  assert.throws(() => { aligned.sessionCommitChanges.push("added"); }, "the recorded change list is frozen");

  assert.deepEqual(normalizeRepositorySnapshot(validSnapshot({ sessionCommitPaths: ["app/a.ts"], sessionCommitChanges: null })).sessionCommitChanges, null, "paths without recorded change kinds are valid");
  assert.deepEqual(normalizeRepositorySnapshot(validSnapshot({ sessionCommitPaths: [], sessionCommitChanges: [] })).sessionCommitPaths, [], "a measured empty read is not never measured");

  for (const [label, overrides] of [
    ["a path traversal", { sessionCommitPaths: ["../../../escape.ts"] }],
    ["an absolute drive path", { sessionCommitPaths: ["C:\\absolute\\path.ts"] }],
    ["a provider configuration path", { sessionCommitPaths: [".claude/settings.json"] }],
    ["a path list that is not a list", { sessionCommitPaths: "app/a.ts" }],
    ["a path list over the 200-entry cap", { sessionCommitPaths: Array.from({ length: 201 }, (_, index) => `app/file-${index}.ts`) }],
    ["a path list over the character budget even though each path and the count are in bounds", { sessionCommitPaths: Array.from({ length: 15 }, (_, index) => `app/${"x".repeat(495)}-${index}.ts`) }],
    ["fewer changes than paths", { sessionCommitPaths: ["app/a.ts", "app/b.ts"], sessionCommitChanges: ["added"] }],
    ["more changes than paths", { sessionCommitPaths: ["app/a.ts"], sessionCommitChanges: ["added", "modified"] }],
    ["an unknown change", { sessionCommitPaths: ["app/a.ts"], sessionCommitChanges: ["renamed"] }],
    ["changes without measured paths", { sessionCommitPaths: null, sessionCommitChanges: [] }],
    ["a non-boolean truncation flag", { sessionCommitsTruncated: "yes" }],
    ["a missing truncation flag", { sessionCommitsTruncated: undefined }],
  ]) {
    assert.equal(normalizeRepositorySnapshot(validSnapshot(overrides)), null, label);
  }
  for (const oldKey of ["dirtyAtFirstCheck", "becameDirty", "committedInWindow", "committedChanges", "gitObservedTruncated"]) {
    assert.equal(normalizeRepositorySnapshot({ ...validSnapshot(), [oldKey]: null }), null, `a version-6 record never carries ${oldKey}`);
  }
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

test("snapshotFromLiveCheck records the session's commit paths, keeps them across checks, and derives no Git-observed file from the working tree", () => {
  const liveCheck = (files, extra, previous) => snapshotFromLiveCheck({
    repository: {
      available: true, branch: "main", historical: false, isMain: true, files,
      comparison: null, remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 1,
    ...extra,
    checkedAt: previous ? "2026-09-20T12:10:00.000Z" : "2026-09-20T12:00:05.000Z",
    previous,
  });

  const unread = liveCheck([{ status: " M", path: "app/dirty.ts" }], {});
  assert.equal(unread.version, 6);
  assert.equal(unread.sessionCommitPaths, null, "a check that never read the commits records none");
  assert.equal(gitObservedFilesFromSnapshot(unread), null);

  const firstCheck = liveCheck([{ status: " M", path: "app/dirty.ts" }], { sessionCommitPaths: ["app/committed.ts"], sessionCommitChanges: ["added"] });
  assert.ok(firstCheck);
  assert.deepEqual(gitObservedFilesFromSnapshot(firstCheck), {
    files: [{ path: "app/committed.ts", source: "committed", change: "added" }],
    truncated: false,
  }, "a dirty working-tree file is not a Git-observed file");

  // A later check that read no commits keeps what was recorded, whatever the working tree now holds.
  const secondCheck = liveCheck([{ status: " M", path: "app/dirty.ts" }, { status: "??", path: "app/new.ts" }], {}, firstCheck);
  assert.ok(secondCheck);
  assert.deepEqual(secondCheck.sessionCommitPaths, ["app/committed.ts"]);
  assert.deepEqual(secondCheck.files.map((file) => file.path), ["app/dirty.ts", "app/new.ts"], "files always reflect the current live check");
  assert.deepEqual(gitObservedFilesFromSnapshot(secondCheck), gitObservedFilesFromSnapshot(firstCheck));

  // A later read adds the commits it found and never withdraws a recorded path.
  const thirdCheck = liveCheck([], { sessionCommitPaths: ["app/later.ts"], sessionCommitChanges: ["modified"] }, secondCheck);
  assert.deepEqual(gitObservedFilesFromSnapshot(thirdCheck), {
    files: [
      { path: "app/committed.ts", source: "committed", change: "added" },
      { path: "app/later.ts", source: "committed", change: "modified" },
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

test("snapshotFromLiveCheck starts a fresh timeline when a newly bound repository replaces an old sidecar, and continues one only for the same identity or an adopted unbound sidecar", () => {
  const live = (previous, overrides = {}) => snapshotFromLiveCheck({
    repositoryId: REPOSITORY_ID,
    previous,
    repository: { available: true, historical: false, branch: "feat/pomegr", isMain: false, files: [], comparison: null, remote: { status: "unavailable", checkedAt: null } },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: null,
    sessionCommitPaths: null,
    sessionCommitChanges: null,
    checkedAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  });

  // An old unbound (version 3) sidecar never donates its fields to a newly bound repository.
  const old = normalizeRepositorySnapshot(legacySnapshot(3, { commitsInSession: 9 }));
  const next = live(old);
  assert.equal(next.repositoryId, REPOSITORY_ID);
  assert.equal(next.comparison, null);
  assert.equal(next.pullRequests, null);
  assert.equal(next.commitsInSession, null);
  assert.equal(next.sessionCommitPaths, null, "the old window-wide committedInWindow is never converted");

  const recorded = normalizeRepositorySnapshot(validSnapshot({
    repositoryId: REPOSITORY_ID, commitsInSession: 2, sessionCommitPaths: ["app/a.ts"], sessionCommitChanges: ["added"], sessionCommitsTruncated: true,
  }));
  const same = live(recorded);
  assert.deepEqual(same.sessionCommitPaths, ["app/a.ts"], "the same repository identity continues its timeline");
  assert.equal(same.sessionCommitsTruncated, true);
  assert.equal(same.commitsInSession, 2);

  const other = live(recorded, { repositoryId: "repo-fedcba9876543210fedcba98", sessionCommitPaths: [], sessionCommitChanges: [] });
  assert.deepEqual(other.sessionCommitPaths, [], "another repository never inherits the previous commits");
  assert.equal(other.sessionCommitsTruncated, false);
  assert.equal(other.commitsInSession, null);

  const unbound = normalizeRepositorySnapshot(validSnapshot({ repositoryId: null, sessionCommitPaths: ["app/a.ts"], sessionCommitChanges: ["added"] }));
  assert.equal(live(unbound).sessionCommitPaths, null, "an unbound sidecar is not adopted by default");
  assert.deepEqual(live(unbound, { adoptsUnboundSidecar: true }).sessionCommitPaths, ["app/a.ts"], "unless the provider declares its unbound sidecars launch-bound");
});

test("sessionRepositorySnapshot resolves through the recorded single-repository identity (provider-neutral: no providerId argument), rejecting unbound, ambiguous, and mismatched sidecars", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot({ repositoryId: "repo-0123456789abcdef01234567" }));
  assert.equal(sessionRepositorySnapshot({ session: { repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567", updatedAt: "2026-09-20T12:00:00.000Z" } }, snapshot), snapshot);
  assert.equal(sessionRepositorySnapshot({ session: { repositoryAttribution: "single", repositoryId: "repo-fedcba9876543210fedcba98" } }, snapshot), null);
  assert.equal(sessionRepositorySnapshot({ session: { repositoryAttribution: "multiple", repositoryId: "repo-0123456789abcdef01234567" } }, snapshot), null);
  assert.equal(sessionRepositorySnapshot({ session: {} }, snapshot), null);
  // An evidence shape with no recorded identity (a legacy checkpoint, or a session whose
  // identity is not yet proven single) never trusts a sidecar unconditionally, for either provider.
  assert.equal(sessionRepositorySnapshot({ session: {} }, normalizeRepositorySnapshot(validSnapshot())), null);
});

test("legacy checkpoint branch fallback requires a proven single-repository identity (provider-neutral: resolveCheckpointRepository no longer takes a providerId)", () => {
  const evidence = { session: { project: "Clapline", recordedGitBranch: "feat/clapline" } };
  const options = { historical: true, evidence, snapshot: null,
    recordedGitState: (branch) => ({ available: Boolean(branch), branch }), unavailablePullRequests: () => ({ items: [] }) };
  assert.equal(resolveCheckpointRepository(options).repository.available, false);
  evidence.session.repositoryAttribution = "single";
  evidence.session.repositoryId = "repo-0123456789abcdef01234567";
  assert.equal(resolveCheckpointRepository(options).repository.branch, "feat/clapline");
});

test("resolveCheckpointRepository and resolveHistoricalRepositoryAndPullRequests never call Git or GitHub when a snapshot exists", async () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot({ repositoryId: "repo-0123456789abcdef01234567" }));
  const deps = {
    recordedGitState: () => assert.fail("must not call recordedGitState when a snapshot exists"),
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
    pullRequestReader: async () => assert.fail("must not call the pull-request reader when a snapshot exists"),
  };
  const evidence = { session: {
    cwd: "C:\\synthetic", recordedGitBranch: "feat/example", updatedAt: "2026-09-20T12:00:00.000Z",
    repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567",
  }, pullRequestCreations: [] };

  const fromCheckpoint = resolveCheckpointRepository({ historical: true, evidence, snapshot, ...deps });
  assert.equal(fromCheckpoint.repository.branch, "feat/example");
  assert.equal(fromCheckpoint.repository.historical, true);

  const fromSelection = await resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot, ...deps });
  assert.equal(fromSelection.repository.branch, "feat/example");

  const live = resolveCheckpointRepository({ historical: false, evidence, snapshot: null, ...deps });
  assert.equal(live.repository.historical, false);
  assert.equal(live.repository.available, false);
});

test("resolveCheckpointRepository and resolveHistoricalRepositoryAndPullRequests fall back to recorded Git only without a snapshot", async () => {
  let recordedGitStateCalls = 0;
  let pullRequestReaderCalls = 0;
  const deps = {
    recordedGitState: (branch) => { recordedGitStateCalls += 1; return { available: Boolean(branch), branch, files: [], historical: true, isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }; },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], isMain: false, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null } }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
    pullRequestReader: async () => { pullRequestReaderCalls += 1; return { status: "ready", checkedAt: null, items: [] }; },
  };
  const evidence = { session: {
    cwd: "C:\\synthetic", recordedGitBranch: "recorded-branch",
    repositoryAttribution: "single", repositoryId: "repo-0123456789abcdef01234567",
  }, pullRequestCreations: [] };

  const fromCheckpoint = resolveCheckpointRepository({ historical: true, evidence, snapshot: null, ...deps });
  assert.equal(fromCheckpoint.repository.branch, "recorded-branch");
  assert.equal(recordedGitStateCalls, 1);
  assert.deepEqual(fromCheckpoint.pullRequests, { status: "unavailable", checkedAt: null, items: [] });

  const fromSelection = await resolveHistoricalRepositoryAndPullRequests({ evidence, snapshot: null, ...deps });
  assert.equal(fromSelection.repository.branch, "recorded-branch");
  assert.equal(recordedGitStateCalls, 2);
  assert.equal(pullRequestReaderCalls, 0, "a historical no-snapshot selection never queries the current checkout");
  assert.equal(fromSelection.pullRequests.status, "unavailable");
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
  const live = (sessionCommitPaths, sessionCommitChanges, checkedAt) => ({
    repository: {
      available: true, branch: "main", historical: false, isMain: true, files: [],
      comparison: null, remote: { status: "unavailable", checkedAt: null },
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: 1,
    sessionCommitPaths,
    sessionCommitChanges,
    checkedAt,
  });

  const first = recorder.record("claude:overlap", live(["app/first.ts"], ["added"], "2026-09-20T12:00:00.000Z"));
  await firstWriteStartedPromise;
  const second = recorder.record("claude:overlap", live(["app/second.ts"], ["modified"], "2026-09-20T12:01:00.000Z"));
  releaseFirstWrite();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);

  const recorded = recorder.recorded("claude:overlap");
  assert.deepEqual(writes[0].sessionCommitPaths, ["app/first.ts"]);
  assert.deepEqual(recorded.sessionCommitPaths, ["app/first.ts", "app/second.ts"], "the overlapping second check is derived from the first persisted check");
  assert.deepEqual(recorded.sessionCommitChanges, ["added", "modified"]);
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
    sessionCommitPaths: ["app/committed.ts"],
    sessionCommitChanges: ["added"],
    checkedAt: "2026-09-20T12:00:05.000Z",
  };
  assert.equal(await firstRecorder.record("codex:restart-session", live), true);
  const beforeRestart = firstRecorder.recorded("codex:restart-session");
  assert.equal(beforeRestart.branch, "feat/restart");
  assert.equal(beforeRestart.version, 6);
  assert.deepEqual(beforeRestart.sessionCommitPaths, ["app/committed.ts"]);

  const secondStore = new SessionObservationCheckpointStore({ directory });
  const secondRecorder = createRepositorySnapshotRecorder({ store: secondStore });
  assert.equal(secondRecorder.recorded("codex:restart-session"), null, "a fresh recorder has not loaded yet");
  await secondRecorder.ensure("codex:restart-session"); // no checkpoint on disk, so read on demand
  const restored = secondRecorder.recorded("codex:restart-session");
  assert.ok(restored);
  assert.equal(restored.branch, "feat/restart");
  assert.equal(restored.commitsInSession, 4);
  assert.deepEqual(restored.pullRequests.items, live.pullRequests.items);
  // The session-commit lists persist across a monitor restart (a fresh recorder, loaded from the
  // same checkpoint directory, sees exactly what the first recorder had written).
  assert.deepEqual(restored.sessionCommitPaths, ["app/committed.ts"]);
  assert.deepEqual(restored.sessionCommitChanges, ["added"]);
  assert.equal(restored.sessionCommitsTruncated, false);
  assert.deepEqual(gitObservedFilesFromSnapshot(restored), { files: [{ path: "app/committed.ts", source: "committed", change: "added" }], truncated: false });

  // A live check after restart, with no in-memory carry-forward, resumes from the restored snapshot:
  // a check that read no commits keeps them, and a later read adds its own.
  const thirdRecorder = createRepositorySnapshotRecorder({ store: new SessionObservationCheckpointStore({ directory }) }); // never read the sidecar
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
  assert.equal(await thirdRecorder.record("codex:restart-session", afterRestartCheck), true);
  const afterRestart = thirdRecorder.recorded("codex:restart-session");
  assert.deepEqual(afterRestart.sessionCommitPaths, ["app/committed.ts"], "carried forward from the restored snapshot since this check did not read the commits");
  assert.deepEqual(afterRestart.sessionCommitChanges, ["added"]);

  assert.equal(await thirdRecorder.record("codex:restart-session", { ...afterRestartCheck, sessionCommitPaths: ["app/post-restart.ts"], sessionCommitChanges: ["modified"], checkedAt: "2026-09-20T14:00:05.000Z" }), true);
  assert.deepEqual(thirdRecorder.recorded("codex:restart-session").sessionCommitPaths, ["app/committed.ts", "app/post-restart.ts"]);
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
  assert.deepEqual(repositoryDomain.touchedFiles, { readiness: "unavailable", files: [], truncated: false });
});

test("the repository domain's touchedFiles comes only from options.fileHistory and options.gitObserved, re-validated, and never appears on session.repository (which /api/state serializes verbatim)", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  const state = stateWithRepository(repository);
  state.session.pullRequests = pullRequests;
  const baseArgs = [{ publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }];
  const touched = (options) => projectSessionDomains("claude:historical-session", ...baseArgs, options).domains.get("repository").touchedFiles;

  const gitObserved = { files: [{ path: "app/new.ts", source: "committed", change: "added" }, { path: "app/old.ts", source: "committed", change: "deleted" }, { path: "app/kept.ts", source: "committed", change: null }], truncated: false };
  assert.deepEqual(touched({ gitObserved }), {
    readiness: "unavailable",
    files: [{ path: "app/kept.ts", source: "committed", change: null }, { path: "app/new.ts", source: "committed", change: "added" }, { path: "app/old.ts", source: "committed", change: "deleted" }],
    truncated: false,
  }, "committed entries are listed even while no recorded history is available");

  const recorded = { fileId: "f1", path: "app/new.ts", kind: "edited", changeCount: 2, lastObservedAt: "2026-09-14T12:00:00.000Z", agents: [] };
  const merged = touched({ fileHistory: { readiness: "ready", files: [recorded], truncated: false }, gitObserved });
  assert.equal(merged.readiness, "ready");
  assert.deepEqual(merged.files.map((file) => [file.path, file.source]), [["app/kept.ts", "committed"], ["app/new.ts", "recorded"], ["app/old.ts", "committed"]]);
  assert.deepEqual(touched({ fileHistory: { readiness: "ready", files: [{ ...recorded, path: "../escape.ts" }], truncated: false } }).files, [], "an unsafe recorded path never reaches the block");

  // An unknown change degrades to null rather than leaking.
  assert.deepEqual(touched({
    gitObserved: { files: [{ path: "app/new.ts", source: "committed", change: "renamed" }, { path: "app/other.ts", source: "committed", change: "added" }], truncated: false },
  }).files.map((file) => file.change), [null, "added"]);

  // Never attached to the raw session.repository object, nor to anything /api/state would serialize verbatim.
  for (const key of ["gitObserved", "touchedFiles", "fileHistory", "gitObservedFiles"]) {
    assert.equal(Object.hasOwn(state.session.repository, key), false, `${key} is never attached to the raw session.repository object`);
  }
  assert.doesNotMatch(JSON.stringify(state.session), /gitObserved|touchedFiles|fileHistory/, "no touched-files block enters the object /api/state would serialize verbatim");
  const { domains } = projectSessionDomains("claude:historical-session", ...baseArgs, { gitObserved });
  assert.equal(Object.hasOwn(domains.get("repository"), "fileHistory"), false, "the old fileHistory block is gone");
  assert.equal(Object.hasOwn(domains.get("repository"), "gitObservedFiles"), false, "the old gitObservedFiles block is gone");
  assert.equal(Object.hasOwn(domains.get("session-summary").repository, "touchedFiles"), true);
  assert.equal(domains.get("session-summary").repository.touchedFiles, null, "the summary carries a count, never the list");

  // The retired uncommitted source is not a public value: the whole block degrades rather than leaking it.
  assert.deepEqual(touched({
    gitObserved: { files: [{ path: "app/new.ts", source: "committed", change: "added" }, { path: "app/dirty.ts", source: "uncommitted", change: null }], truncated: false },
  }).files, []);

  // Malformed input (an unsafe path) degrades to no committed entries rather than leaking a partially-valid shape.
  assert.deepEqual(touched({
    gitObserved: { files: [{ path: "../../../escape.ts", source: "committed" }], truncated: false },
  }).files, []);

  // No options.gitObserved at all (e.g. a session with no recorded Git-observed snapshot yet).
  assert.deepEqual(touched({}), { readiness: "unavailable", files: [], truncated: false });
});

test("the session summary counts the Touched here files (recorded plus session-committed, deduplicated) only once file history is ready", () => {
  const snapshot = normalizeRepositorySnapshot(validSnapshot());
  const { repository, pullRequests } = historicalRepositoryFromSnapshot(snapshot);
  const state = stateWithRepository(repository);
  state.session.pullRequests = pullRequests;
  const baseArgs = [{ publicState: state, readiness: state.readiness, observedAt: state.session.updatedAt }];
  const recorded = (path, fileId) => ({ fileId, path, kind: "edited", changeCount: 1, lastObservedAt: "2026-09-14T12:00:00.000Z" });
  const fileHistory = { readiness: "ready", files: [recorded("app/a.ts", "f1"), recorded("app/b.ts", "f2")], truncated: false };
  const gitObserved = { files: [{ path: "app/b.ts", source: "committed" }, { path: "app/c.ts", source: "committed" }], truncated: false };

  const ready = projectSessionDomains("claude:historical-session", ...baseArgs, { fileHistory, gitObserved });
  assert.equal(ready.domains.get("session-summary").repository.touchedFiles, 3);
  assert.doesNotMatch(JSON.stringify(ready.domains.get("session-summary")), /app\/[abc]\.ts/, "only the count reaches the summary");

  const loading = projectSessionDomains("claude:historical-session", ...baseArgs, { fileHistory: { ...fileHistory, readiness: "loading" }, gitObserved });
  assert.equal(loading.domains.get("session-summary").repository.touchedFiles, null);
});
