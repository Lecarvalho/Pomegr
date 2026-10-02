import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  gitObservedFilesFromSnapshot,
  nextSessionCommits,
  normalizeRepositorySnapshot,
  readCommitsInWindow,
  sessionGitCommandIntervals,
} from "../../../server/repository/repository-snapshot.mjs";
import { legacySnapshot, validSnapshot } from "../../helpers/repository-snapshot-records.mjs";

test("gitObservedFilesFromSnapshot lists a snapshot's session commits as committed files and is null until the commits were read", () => {
  assert.equal(gitObservedFilesFromSnapshot(null), null);
  assert.equal(gitObservedFilesFromSnapshot({ sessionCommitPaths: null, sessionCommitChanges: null, sessionCommitsTruncated: false }), null);
  for (const version of [2, 3, 4, 5]) {
    assert.equal(gitObservedFilesFromSnapshot(normalizeRepositorySnapshot(legacySnapshot(version))), null, `version ${version}: an upgraded record never read this session's commits`);
  }
  assert.equal(gitObservedFilesFromSnapshot({
    dirtyAtFirstCheck: [], becameDirty: ["app/b.ts"], committedInWindow: ["app/a.ts"], committedChanges: ["added"], gitObservedTruncated: false,
  }), null, "the old window-wide lists are never projected");

  const recorded = normalizeRepositorySnapshot(validSnapshot({
    sessionCommitPaths: ["app/a.ts", "app/b.ts", "app/c.ts"], sessionCommitChanges: ["added", "modified", "deleted"],
  }));
  assert.deepEqual(gitObservedFilesFromSnapshot(recorded), {
    files: [
      { path: "app/a.ts", source: "committed", change: "added" },
      { path: "app/b.ts", source: "committed", change: "modified" },
      { path: "app/c.ts", source: "committed", change: "deleted" },
    ],
    truncated: false,
  });

  const withoutKinds = gitObservedFilesFromSnapshot({ sessionCommitPaths: ["app/a.ts", "app/b.ts"], sessionCommitChanges: null, sessionCommitsTruncated: false });
  assert.deepEqual(withoutKinds.files.map((file) => file.change), [null, null], "paths recorded without change kinds project change null");
  assert.deepEqual(
    gitObservedFilesFromSnapshot({ sessionCommitPaths: ["app/a.ts", "app/b.ts"], sessionCommitChanges: ["added"], sessionCommitsTruncated: false }).files.map((file) => file.change),
    [null, null],
    "a misaligned change list is never guessed from",
  );
  assert.deepEqual(
    gitObservedFilesFromSnapshot({ sessionCommitPaths: [], sessionCommitChanges: [], sessionCommitsTruncated: false }),
    { files: [], truncated: false },
    "a measured but empty record is { files: [], truncated: false }, not null",
  );
  assert.equal(gitObservedFilesFromSnapshot({ sessionCommitPaths: [], sessionCommitChanges: [], sessionCommitsTruncated: true }).truncated, true);
  const overCap = gitObservedFilesFromSnapshot({ sessionCommitPaths: Array.from({ length: 201 }, (_, index) => `app/file-${index}.ts`), sessionCommitChanges: null, sessionCommitsTruncated: false });
  assert.equal(overCap.files.length, 200);
  assert.equal(overCap.truncated, true);
});

test("nextSessionCommits is null until a check reads the commits, then holds the sorted paths read with their aligned changes", () => {
  const neverRead = { sessionCommitPaths: null, sessionCommitChanges: null, sessionCommitsTruncated: false };
  assert.deepEqual(nextSessionCommits(null), neverRead);
  assert.deepEqual(nextSessionCommits(null, {}), neverRead);
  assert.deepEqual(nextSessionCommits(null, { paths: null, changes: null }), neverRead, "a check that could not read the commits records nothing");
  assert.deepEqual(nextSessionCommits(null, { paths: "app/a.ts" }), neverRead);

  assert.deepEqual(nextSessionCommits(null, { paths: [], changes: [] }), { sessionCommitPaths: [], sessionCommitChanges: [], sessionCommitsTruncated: false }, "a measured empty read is not never measured");
  assert.deepEqual(
    nextSessionCommits(null, { paths: ["app/b.ts", "app/a.ts"], changes: ["deleted", "added"] }),
    { sessionCommitPaths: ["app/a.ts", "app/b.ts"], sessionCommitChanges: ["added", "deleted"], sessionCommitsTruncated: false },
    "re-aligned after the path list is sorted",
  );
  const unsafe = nextSessionCommits(null, { paths: ["../escape.ts", "app/ok.ts", "C:\\abs.ts"], changes: ["added", "modified", "added"] });
  assert.deepEqual([unsafe.sessionCommitPaths, unsafe.sessionCommitChanges], [["app/ok.ts"], ["modified"]], "an unsafe path is never recorded");
});

test("nextSessionCommits is a sticky union: a later read adds paths, never withdraws one, and its change replaces the recorded one", () => {
  const first = nextSessionCommits(null, { paths: ["app/a.ts", "app/b.ts"], changes: ["added", "deleted"] });

  const added = nextSessionCommits(first, { paths: ["app/c.ts"], changes: ["modified"] });
  assert.deepEqual(added.sessionCommitPaths, ["app/a.ts", "app/b.ts", "app/c.ts"]);
  assert.deepEqual(added.sessionCommitChanges, ["added", "deleted", "modified"], "paths not in this read keep their recorded change");

  assert.deepEqual(nextSessionCommits(first, { paths: [], changes: [] }), first, "a read that finds no commit (an amend, a rebase) never withdraws a recorded path");
  assert.deepEqual(nextSessionCommits(first, { paths: ["app/b.ts"], changes: ["deleted"] }), first, "re-reading a recorded path changes nothing");

  const overridden = nextSessionCommits(first, { paths: ["app/a.ts"], changes: ["modified"] });
  assert.deepEqual(overridden.sessionCommitPaths, ["app/a.ts", "app/b.ts"]);
  assert.deepEqual(overridden.sessionCommitChanges, ["modified", "deleted"], "a path in this read takes this read's change; the other keeps its own");
});

test("nextSessionCommits carries the previous commits forward when a check did not read them, and never guesses a change kind", () => {
  const first = nextSessionCommits(null, { paths: ["app/a.ts", "app/b.ts"], changes: ["added", "deleted"] });
  assert.deepEqual(nextSessionCommits(first, {}), first);
  assert.deepEqual(nextSessionCommits(first, { paths: undefined, changes: undefined }), first);
  assert.deepEqual(nextSessionCommits(first, { paths: null }), first);
  assert.deepEqual(nextSessionCommits({ sessionCommitPaths: null }, {}), { sessionCommitPaths: null, sessionCommitChanges: null, sessionCommitsTruncated: false });

  assert.deepEqual(nextSessionCommits(first, { paths: ["app/a.ts"] }).sessionCommitChanges, ["added", "deleted"], "a re-read path read without kinds keeps its recorded change");
  assert.equal(nextSessionCommits(first, { paths: ["app/z.ts"] }).sessionCommitChanges, null, "a new path read without a kind leaves the list unaligned, so no kind is recorded");
  assert.equal(nextSessionCommits(first, { paths: ["app/z.ts"], changes: ["added", "added"] }).sessionCommitChanges, null, "a change list that does not match the read's paths is ignored");
  assert.equal(nextSessionCommits(null, { paths: ["app/a.ts"] }).sessionCommitChanges, null);
});

test("nextSessionCommits bounds a maxed set of long paths so the record stays under the repository-snapshot byte cap, and the truncation flag stays set", () => {
  const paths = Array.from({ length: 400 }, (_, index) => `app/committed/${"a".repeat(480)}-${index}.ts`);
  const result = nextSessionCommits(null, { paths, changes: paths.map(() => "modified") });
  assert.ok(result.sessionCommitPaths.length < 400, "the character budget truncated the list well under the 400 candidates");
  assert.equal(result.sessionCommitsTruncated, true);
  assert.equal(result.sessionCommitChanges.length, result.sessionCommitPaths.length);

  const snapshot = normalizeRepositorySnapshot(validSnapshot({ ...result }));
  assert.ok(snapshot, "the bounded output is itself a valid record");
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 64 * 1024, "fits the checkpoint store's repository-snapshot byte cap");

  assert.equal(nextSessionCommits(result, { paths: ["app/small.ts"], changes: ["added"] }).sessionCommitsTruncated, true, "once truncated, always flagged");
  assert.equal(nextSessionCommits(result, {}).sessionCommitsTruncated, true);
});

test("sessionGitCommandIntervals keeps only finished git, git_push and pull_request tasks, with the start floored to its second", () => {
  const task = (workKind, startedAt, finishedAt) => ({ id: `${workKind}-${startedAt}`, label: "task", kind: "shell", workKind, status: "completed", startedAt, finishedAt });
  assert.deepEqual(sessionGitCommandIntervals([
    task("git", "2026-09-20T11:00:01.750Z", "2026-09-20T11:00:05.250Z"),
    task("git_push", "2026-09-20T11:10:00.000Z", "2026-09-20T11:10:02.000Z"),
    task("pull_request", "2026-09-20T11:20:00.999Z", "2026-09-20T11:20:03.500Z"),
  ]), [
    [Date.parse("2026-09-20T11:00:01.000Z"), Date.parse("2026-09-20T11:00:05.250Z")],
    [Date.parse("2026-09-20T11:10:00.000Z"), Date.parse("2026-09-20T11:10:02.000Z")],
    [Date.parse("2026-09-20T11:20:00.000Z"), Date.parse("2026-09-20T11:20:03.500Z")],
  ], "[start floored to its second, finish], in epoch milliseconds");

  assert.deepEqual(sessionGitCommandIntervals([
    task("test", "2026-09-20T11:00:00.000Z", "2026-09-20T11:00:05.000Z"),
    task("shell", "2026-09-20T11:00:00.000Z", "2026-09-20T11:00:05.000Z"),
    task("write", "2026-09-20T11:00:00.000Z", "2026-09-20T11:00:05.000Z"),
    task(null, "2026-09-20T11:00:00.000Z", "2026-09-20T11:00:05.000Z"),
    task(undefined, "2026-09-20T11:00:00.000Z", "2026-09-20T11:00:05.000Z"),
  ]), [], "any other work kind may not have created a commit");

  assert.deepEqual(sessionGitCommandIntervals([
    task("git", "2026-09-20T11:00:00.000Z", null),
    { workKind: "git", status: "running", startedAt: "2026-09-20T11:00:00.000Z" },
    task("git", "not a time", "2026-09-20T11:00:05.000Z"),
    task("git", "2026-09-20T11:00:00.000Z", "not a time"),
    task("git", null, "2026-09-20T11:00:05.000Z"),
    task("git", "2026-09-20T11:00:05.000Z", "2026-09-20T11:00:00.000Z"),
    null,
    undefined,
  ]), [], "a running task has no interval yet, and unusable or inverted times are skipped");

  assert.deepEqual(sessionGitCommandIntervals(undefined), []);
  assert.deepEqual(sessionGitCommandIntervals(null), []);
  assert.deepEqual(sessionGitCommandIntervals("git"), []);

  const many = Array.from({ length: 300 }, (_, index) => task("git", new Date(Date.UTC(2026, 8, 20, 0, 0, index)).toISOString(), new Date(Date.UTC(2026, 8, 20, 0, 0, index, 500)).toISOString()));
  const bounded = sessionGitCommandIntervals(many);
  assert.equal(bounded.length, 256, "bounded");
  assert.deepEqual(bounded.at(-1), [Date.UTC(2026, 8, 20, 0, 0, 299), Date.UTC(2026, 8, 20, 0, 0, 299, 500)], "the newest commands are the ones kept");
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

const instant = (iso) => Date.parse(iso);
// A closed command interval [from, to] in epoch milliseconds, as sessionGitCommandIntervals produces.
const interval = (from, to) => [instant(from), instant(to)];

test("readCommitsInWindow reads the commit count and times on HEAD within [since, until], using an argument array, and resolves null on failure", async (context) => {
  const root = await commitFixture(context);
  const window = { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" };
  const result = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-09T00:00:00Z", "2026-09-16T00:00:00Z")] });
  assert.deepEqual(result, { count: 2, paths: ["app/inside-one.ts", "app/inside-two.ts"], changes: ["added", "added"], truncated: false, times: ["2026-09-10T00:00:00.000Z", "2026-09-15T00:00:00.000Z"] });

  const none = await readCommitsInWindow(root, { since: "2026-10-01T00:00:00.000Z", until: "2026-10-02T00:00:00.000Z", commandIntervals: [interval("2026-09-01T00:00:00Z", "2026-10-02T00:00:00Z")] });
  assert.deepEqual(none, { count: 0, paths: [], changes: [], truncated: false, times: [] });

  assert.equal(await readCommitsInWindow(path.join(os.tmpdir(), "pomegr-not-a-repo-xyz"), window), null);
  assert.equal(await readCommitsInWindow(root, { since: "not-a-date", until: "2026-09-20T00:00:00.000Z" }), null);
  assert.equal(await readCommitsInWindow(null, window), null);
});

test("readCommitsInWindow lists paths only for commits made while one of the session's Git commands ran, and still counts every commit in the window", async (context) => {
  const root = await commitFixture(context);
  const window = { since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z" };
  const times = ["2026-09-10T00:00:00.000Z", "2026-09-15T00:00:00.000Z"];
  const unattributed = { count: 2, paths: [], changes: [], truncated: false, times };

  for (const commandIntervals of [undefined, null, [], "not a list"]) {
    assert.deepEqual(await readCommitsInWindow(root, { ...window, commandIntervals }), unattributed, `no usable intervals (${JSON.stringify(commandIntervals)}): counted, no path`);
  }
  assert.deepEqual(
    await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-12T00:00:00Z", "2026-09-13T00:00:00Z")] }),
    unattributed,
    "commits in the window but outside every interval are counted and timed, never listed",
  );
  assert.deepEqual(
    await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-09T23:59:00Z", "2026-09-10T00:01:00Z")] }),
    { count: 2, paths: ["app/inside-one.ts"], changes: ["added"], truncated: false, times },
    "only the commit inside the interval lists its paths",
  );
  assert.deepEqual(
    await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-09T23:59:00Z", "2026-09-10T00:01:00Z"), interval("2026-09-14T23:59:00Z", "2026-09-15T00:01:00Z")] }),
    { count: 2, paths: ["app/inside-one.ts", "app/inside-two.ts"], changes: ["added", "added"], truncated: false, times },
    "several intervals each match their own commits",
  );

  // The interval bounds are inclusive: a zero-length interval at the commit's own second matches.
  const exact = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-15T00:00:00Z", "2026-09-15T00:00:00Z")] });
  assert.deepEqual(exact.paths, ["app/inside-two.ts"]);
  const justBefore = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-14T23:59:57Z", "2026-09-14T23:59:59Z")] });
  assert.deepEqual(justBefore.paths, []);
  const justAfter = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-15T00:00:01Z", "2026-09-15T00:00:03Z")] });
  assert.deepEqual(justAfter.paths, []);

  // An interval cannot widen the window: a commit outside [since, until] is not read at all.
  const outside = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-24T00:00:00Z", "2026-09-26T00:00:00Z")] });
  assert.deepEqual(outside, unattributed);

  // A command's start is floored to its second by sessionGitCommandIntervals, because a committer time
  // has one-second resolution: a commit made in the second the command started still matches.
  const intervals = sessionGitCommandIntervals([
    { id: "commit", workKind: "git", status: "completed", startedAt: "2026-09-10T00:00:00.400Z", finishedAt: "2026-09-10T00:00:02.000Z" },
    { id: "test", workKind: "test", status: "completed", startedAt: "2026-09-14T23:59:00.000Z", finishedAt: "2026-09-15T00:01:00.000Z" },
  ]);
  assert.deepEqual((await readCommitsInWindow(root, { ...window, commandIntervals: intervals })).paths, ["app/inside-one.ts"], "a non-Git task never attributes the commit made during it");
});

test("readCommitsInWindow nets each path's change across the matched commits: added wins over later edits, a final delete wins, and edits of older files are modified", async (context) => {
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

  const window = { since: "2026-09-05T00:00:00.000Z", until: "2026-09-30T00:00:00.000Z" };
  const result = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-05T00:00:00Z", "2026-09-30T00:00:00Z")] });
  assert.equal(result.count, 6);
  assert.deepEqual(result.paths, ["after.txt", "app/inside-one.ts", "app/inside-two.ts", "before.txt"]);
  assert.deepEqual(result.changes, ["added", "added", "deleted", "modified"]);

  // Only the matched commits are netted: the edit alone modified a file this session did not add.
  const edited = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-26T00:00:00Z", "2026-09-26T00:00:00Z")] });
  assert.equal(edited.count, 6, "the unmatched commits still count");
  assert.deepEqual([edited.paths, edited.changes], [["app/inside-one.ts"], ["modified"]]);
  const deleted = await readCommitsInWindow(root, { ...window, commandIntervals: [interval("2026-09-28T00:00:00Z", "2026-09-28T00:00:00Z")] });
  assert.deepEqual([deleted.paths, deleted.changes], [["app/inside-two.ts"], ["deleted"]]);
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
  const result = await readCommitsInWindow(subdirectory, {
    since: "2026-09-05T00:00:00.000Z", until: "2026-09-20T00:00:00.000Z", commandIntervals: [interval("2026-09-05T00:00:00Z", "2026-09-20T00:00:00Z")],
  });
  assert.deepEqual(result.paths, ["app/inside-one.ts", "app/inside-two.ts"], "paths from a subdirectory cwd are still relative to the top level, matching repository.files");
});
