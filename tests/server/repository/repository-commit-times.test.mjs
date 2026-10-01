import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createRepositorySnapshotRecorder,
  gitObservedFilesFromSnapshot,
  historicalRepositoryFromSnapshot,
  MAX_COMMIT_TIMES,
  nextCommitTimes,
  normalizeRepositorySnapshot,
  readCommitsInWindow,
  snapshotFromLiveCheck,
} from "../../../server/repository/repository-snapshot.mjs";
import { createSessionRepositoryEnrichment } from "../../../server/repository/session-repository-enrichment.mjs";
import { repositorySnapshotFilename, SessionObservationCheckpointStore } from "../../../server/sessions/checkpoints/session-observation-checkpoints.mjs";

function validSnapshot(overrides = {}) {
  return {
    version: 5, branch: "feat/example", isMain: false, files: [{ status: " M", path: "app/file.ts" }],
    comparison: { branch: "origin/main", kind: "base", ahead: 2, behind: 0, integrated: false }, comparisonCheckedAt: "2026-09-20T12:00:00.000Z",
    pullRequests: { checkedAt: "2026-09-20T12:00:00.000Z", items: [] }, commitsInSession: 3, checkedAt: "2026-09-20T12:00:05.000Z",
    dirtyAtFirstCheck: ["app/file.ts"], becameDirty: [], committedInWindow: null, committedChanges: null, gitObservedTruncated: false,
    repositoryId: null, commitTimesInWindow: null,
    ...overrides,
  };
}
// The version-4 shape (predates commitTimesInWindow): what every sidecar on disk holds before upgrade.
function validSnapshotV4(overrides = {}) {
  return without(validSnapshot({ version: 4, ...overrides }), "commitTimesInWindow");
}
function without(value, ...keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
const time = (minute, second = 0) => new Date(Date.UTC(2026, 8, 20, 11, minute, second)).toISOString();
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Pomegr Test", GIT_AUTHOR_EMAIL: "pomegr@example.test", GIT_COMMITTER_NAME: "Pomegr Test", GIT_COMMITTER_EMAIL: "pomegr@example.test" };

async function temporaryDirectory(context, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

test("a version-4 sidecar written before commit times stays valid and loads with the list never measured", () => {
  const v4 = validSnapshotV4({ repositoryId: "repo-0123456789abcdef01234567", committedInWindow: ["app/a.ts"], committedChanges: ["added"], commitsInSession: 7 });
  assert.equal(Object.hasOwn(v4, "commitTimesInWindow"), false);
  const upgraded = normalizeRepositorySnapshot(v4);
  assert.ok(upgraded, "recorded repository history is never discarded on upgrade");
  assert.equal(upgraded.version, 5);
  assert.equal(upgraded.commitTimesInWindow, null, "absent, not an empty measured list");
  // Everything the version-4 record held is preserved exactly.
  assert.deepEqual(without(upgraded, "version", "commitTimesInWindow"), without(v4, "version"));
  // The served historical values are unchanged by the upgrade.
  assert.equal(historicalRepositoryFromSnapshot(upgraded).repository.commitsInSession, 7);
  assert.deepEqual(gitObservedFilesFromSnapshot(upgraded).files, [{ path: "app/a.ts", source: "committed", change: "added" }]);
  // A version-5-only key under version 4, or a version-5 record without it, is rejected whole.
  assert.equal(normalizeRepositorySnapshot({ ...v4, commitTimesInWindow: [] }), null);
  assert.equal(normalizeRepositorySnapshot({ ...v4, version: 5 }), null);
});

test("normalizeRepositorySnapshot validates commitTimesInWindow as a whole: bounded, canonical, ordered, times only", () => {
  const full = Array.from({ length: MAX_COMMIT_TIMES }, (_, index) => time(0, index));
  assert.equal(MAX_COMMIT_TIMES, 50);
  assert.deepEqual(normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: full })).commitTimesInWindow, full);
  assert.deepEqual(normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: [] })).commitTimesInWindow, []);
  assert.deepEqual(normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: [time(1), time(1)] })).commitTimesInWindow, [time(1), time(1)], "two commits in one second");
  assert.throws(() => { normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: [time(1)] })).commitTimesInWindow.push(time(2)); });
  for (const [label, invalid] of [
    ["over the bound", [...full, time(5)]],
    ["newest first", [time(2), time(1)]],
    ["a non-canonical spelling", ["2026-09-20T11:00:00Z"]],
    ["an offset spelling", ["2026-09-20T13:00:00.000+02:00"]],
    ["an impossible date", ["2026-13-40T11:00:00.000Z"]],
    ["a commit hash", ["0123456789abcdef0123456789abcdef01234567"]],
    ["an object carrying a subject", [{ committedAt: time(1), subject: "x" }]],
    ["a number", [1_790_000_000_000]],
    ["not a list", time(1)],
    ["undefined", undefined],
  ]) {
    assert.equal(normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: invalid })), null, label);
  }
});

test("nextCommitTimes is sticky, keeps the newest 50, and carries the list forward when the window was not read", () => {
  assert.equal(nextCommitTimes(null, undefined), null, "never measured");
  assert.equal(nextCommitTimes(null, null), null);
  assert.deepEqual(nextCommitTimes(null, []), [], "a measured empty window");
  assert.deepEqual(nextCommitTimes(null, [time(3), time(1)]), [time(1), time(3)], "oldest to newest");
  const previous = [time(1), time(3)];
  assert.equal(nextCommitTimes(previous, undefined), previous, "a check that did not read the window keeps the list");
  assert.deepEqual(nextCommitTimes(previous, []), previous, "a later read without the commits never withdraws them");
  assert.deepEqual(nextCommitTimes(previous, [time(3), time(5)]), [time(1), time(3), time(5)]);
  assert.deepEqual(nextCommitTimes([time(2)], [time(2), time(2)]), [time(2), time(2)], "commits sharing a second count as the fullest read showed");
  assert.deepEqual(nextCommitTimes([time(2), time(2)], [time(2)]), [time(2), time(2)]);
  assert.deepEqual(nextCommitTimes(["2026-09-20T13:01:00+02:00"], ["not a time", 5, null]), [time(1)], "canonical output, unusable values skipped");
  const many = Array.from({ length: 70 }, (_, index) => time(index % 60, Math.floor(index / 60))).sort();
  const bounded = nextCommitTimes(many.slice(0, 40), many.slice(30));
  assert.deepEqual(bounded, many.slice(-MAX_COMMIT_TIMES), "the newest 50 are kept; older times age out");
  assert.ok(normalizeRepositorySnapshot(validSnapshot({ commitTimesInWindow: bounded })));
});

test("snapshotFromLiveCheck records the read commit times and starts over only with a new repository identity", () => {
  const live = (overrides) => snapshotFromLiveCheck({
    repository: { available: true, branch: "feat/example", historical: false, isMain: false, files: [], comparison: null, remote: { status: "unavailable", checkedAt: null } },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] }, commitsInSession: 1, checkedAt: "2026-09-20T12:00:05.000Z", ...overrides,
  });
  assert.equal(live({}).commitTimesInWindow, null, "a check that did not read the window records no commit times");
  const first = live({ commitTimes: [time(1)], repositoryId: "repo-0123456789abcdef01234567" });
  assert.deepEqual(first.commitTimesInWindow, [time(1)]);
  assert.deepEqual(live({ commitTimes: [time(4)], repositoryId: "repo-0123456789abcdef01234567", previous: first }).commitTimesInWindow, [time(1), time(4)]);
  assert.deepEqual(live({ commitTimes: [time(4)], repositoryId: "repo-fedcba9876543210fedcba98", previous: first }).commitTimesInWindow, [time(4)],
    "another repository never inherits the previous timeline");
  // An older record without the list is a valid baseline for the first recorded times.
  const legacy = normalizeRepositorySnapshot(validSnapshotV4({ dirtyAtFirstCheck: ["kept.txt"] }));
  const upgraded = live({ commitTimes: [time(2)], previous: legacy });
  assert.deepEqual(upgraded.commitTimesInWindow, [time(2)]);
  assert.deepEqual(upgraded.dirtyAtFirstCheck, ["kept.txt"]);
});

async function commitRepository(context, count) {
  const root = await temporaryDirectory(context, "pomegr-commit-times-");
  execFileSync("git", ["-C", root, "init", "--initial-branch=main", "--quiet"], { stdio: ["ignore", "pipe", "pipe"], env: GIT_ENV });
  const iso = (index) => new Date(Date.UTC(2026, 8, 10, 0, index)).toISOString();
  for (let index = 0; index < count; index += 1) {
    execFileSync("git", ["-C", root, "commit", "--allow-empty", "--quiet", "-m", `SENTINEL_COMMIT_SUBJECT ${index}`], {
      stdio: ["ignore", "pipe", "pipe"], env: { ...GIT_ENV, GIT_AUTHOR_DATE: iso(index), GIT_COMMITTER_DATE: iso(index) },
    });
  }
  return { root, iso };
}

test("readCommitsInWindow keeps the newest 50 committer times, times only, while the count stays complete", async (context) => {
  const { root, iso } = await commitRepository(context, 53);
  const result = await readCommitsInWindow(root, { since: "2026-09-09T00:00:00.000Z", until: "2026-09-11T00:00:00.000Z" });
  assert.equal(result.count, 53);
  assert.deepEqual(result.times, Array.from({ length: MAX_COMMIT_TIMES }, (_, index) => iso(index + 3)), "oldest to newest, the three oldest aged out");
  assert.doesNotMatch(JSON.stringify(result), /[0-9a-f]{40}|SENTINEL_COMMIT_SUBJECT|Pomegr Test|example\.test/iu, "no hash, subject, or author leaves the reader");
});

test("the live enrichment hands the window's commit times to the recorder, not onto the public repository value", async (context) => {
  const { root, iso } = await commitRepository(context, 2);
  const checks = [];
  const enrichment = createSessionRepositoryEnrichment({
    gitReader: async () => ({ available: true, branch: "main", files: [], isMain: true, comparison: null, commits: [], remote: { status: "unavailable", checkedAt: null }, _repositoryRoot: root }),
    pullRequestReader: async () => ({ status: "unavailable", checkedAt: null, items: [] }),
    now: () => Date.UTC(2026, 8, 11), cacheMs: 60_000, providerFolders: { folders: {} },
    unavailableGitState: () => ({ available: false, branch: "Not a Git repository", files: [], commits: [] }),
    unavailablePullRequests: () => ({ status: "unavailable", checkedAt: null, items: [] }),
  });
  enrichment.setOnRepositoryCheck((sessionId, live) => checks.push(live));
  const evidence = { session: { cwd: root, recordedGitBranch: "main", startedAt: "2026-09-09T00:00:00.000Z" }, pullRequestCreations: [] };
  let work;
  const first = enrichment.liveEnrichment("claude:times", evidence, null, (task) => { work = task(); });
  first.enqueue();
  await work;
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].commitTimes, [iso(0), iso(1)]);
  assert.equal(checks[0].commitsInSession, 2);
  const served = enrichment.liveEnrichment("claude:times", evidence, null, () => {}).value.repository;
  assert.equal(served.commitsInSession, 2);
  assert.doesNotMatch(JSON.stringify(served), /commitTimes/u, "the public repository value carries only the count");
});

test("the sidecar persists only commit times, keeps them across a restart, and upgrades a version-4 file on the next live check", async (context) => {
  const directory = await temporaryDirectory(context, "pomegr-commit-times-sidecar-");
  const recorder = createRepositorySnapshotRecorder({ store: new SessionObservationCheckpointStore({ directory }) });
  const live = (commitTimes, checkedAt, branch = "feat/times") => ({
    repository: {
      available: true, branch, historical: false, isMain: false, files: [], comparison: null, remote: { status: "unavailable", checkedAt: null },
      // The live value's own commit list (hash and subject) is never recorded.
      commits: [{ hash: "0123456789abcdef0123456789abcdef01234567", subject: "SENTINEL_COMMIT_SUBJECT", committedAt: time(30) }],
    },
    pullRequests: { status: "unavailable", checkedAt: null, items: [] },
    commitsInSession: commitTimes.length, committedPaths: [], committedChanges: [], commitTimes, checkedAt,
  });
  assert.equal(await recorder.record("claude:times", live([time(30)], "2026-09-20T12:00:00.000Z")), true);
  const [filename] = (await readdir(directory)).filter((name) => name.startsWith("repository-"));
  const onDisk = await readFile(path.join(directory, filename), "utf8");
  assert.deepEqual(JSON.parse(onDisk).snapshot.commitTimesInWindow, [time(30)]);
  assert.equal(JSON.parse(onDisk).snapshot.version, 5);
  assert.doesNotMatch(onDisk, /SENTINEL_COMMIT_SUBJECT|0123456789abcdef0123456789abcdef01234567|"hash"|"subject"|"author"/u);

  // After a restart, a historical session serves exactly the recorded list.
  const restarted = createRepositorySnapshotRecorder({ store: new SessionObservationCheckpointStore({ directory }) });
  await restarted.ensure("claude:times");
  assert.deepEqual(restarted.recorded("claude:times").commitTimesInWindow, [time(30)]);
  assert.equal(Object.hasOwn(historicalRepositoryFromSnapshot(restarted.recorded("claude:times")).repository, "commitTimesInWindow"), false);

  // A version-4 file already on disk still loads, survives pruning, and the next live check extends it.
  const legacyStore = new SessionObservationCheckpointStore({ directory });
  await legacyStore.writeRepositorySnapshot("claude", "legacy", validSnapshot());
  const legacyFile = (await readdir(directory)).find((name) => name.startsWith("repository-") && name !== filename);
  await writeFile(path.join(directory, legacyFile), JSON.stringify({ version: 1, providerId: "claude", localSessionId: "legacy", snapshot: validSnapshotV4({ commitsInSession: 4, dirtyAtFirstCheck: ["kept.txt"] }) }));
  await new SessionObservationCheckpointStore({ directory }).prune();
  assert.ok((await readdir(directory)).includes(legacyFile), "pruning never removes a valid version-4 sidecar");
  const legacyRecorder = createRepositorySnapshotRecorder({ store: new SessionObservationCheckpointStore({ directory }) });
  await legacyRecorder.ensure("claude:legacy");
  assert.equal(legacyRecorder.recorded("claude:legacy").commitsInSession, 4);
  assert.equal(legacyRecorder.recorded("claude:legacy").commitTimesInWindow, null);
  assert.equal(await legacyRecorder.record("claude:legacy", live([time(45)], "2026-09-20T12:10:00.000Z", "feat/example")), true);
  assert.deepEqual(legacyRecorder.recorded("claude:legacy").commitTimesInWindow, [time(45)]);
  assert.deepEqual(legacyRecorder.recorded("claude:legacy").dirtyAtFirstCheck, ["kept.txt"], "the recorded baseline survives the upgrade");
});

test("pruning keeps, and never loads, a sidecar written by a newer build", async (context) => {
  const directory = await temporaryDirectory(context, "pomegr-newer-sidecar-");
  const store = new SessionObservationCheckpointStore({ directory });
  await store.writeRepositorySnapshot("claude", "current", validSnapshot({ commitTimesInWindow: [time(1)] }));
  const file = (localSessionId) => path.join(directory, repositorySnapshotFilename("claude", localSessionId));
  const sidecar = (localSessionId, snapshot) => JSON.stringify({ version: 1, providerId: "claude", localSessionId, snapshot });
  const newer = sidecar("newer", { ...validSnapshot(), version: 6, futureField: ["unknown to this build"] });
  await writeFile(file("newer"), newer);
  await writeFile(file("broken"), sidecar("broken", { ...validSnapshot(), branch: 7 }));

  assert.equal(await store.loadRepositorySnapshot("claude", "newer"), null, "an unknown version is never loaded");
  assert.deepEqual((await store.loadRepositorySnapshots()).map((record) => record.localSessionId), ["current"]);
  await store.prune();
  assert.equal(await readFile(file("newer"), "utf8"), newer, "kept byte for byte for the newer build");
  assert.ok((await readdir(directory)).includes(path.basename(file("current"))));
  assert.ok(!(await readdir(directory)).includes(path.basename(file("broken"))), "a record invalid at a known version is still removed");
  // Not a way to keep garbage: only an integer version above this build's counts as newer.
  for (const version of [5.5, "6", null, -1, Number.MAX_VALUE]) {
    await writeFile(file("broken"), sidecar("broken", { ...validSnapshot(), version, extra: 1 }));
    await store.prune();
    assert.ok(!(await readdir(directory)).includes(path.basename(file("broken"))), `version ${version}`);
  }
});
