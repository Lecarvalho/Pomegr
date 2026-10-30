import assert from "node:assert/strict";
import test from "node:test";

import { createRepositoryGithub } from "../desktop/runtime/repository-github.mjs";

const repoA = "repo-0123456789abcdef01234567";
const repoB = "repo-fedcba987654321001234567";
const FIELDS = "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed,deleteBranchOnMerge,defaultBranchRef";
const repoJson = (over = {}) => JSON.stringify({
  squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false,
  defaultBranchRef: { name: "main", target: { oid: "private" } }, ...over,
});
const FACTS = { squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false, defaultBranch: "main" };

function harness(answers) {
  const calls = [];
  const clock = { now: 1_000_000 };
  const queue = [...answers];
  const github = createRepositoryGithub({
    now: () => clock.now, timeoutMs: 4000,
    execFile: (executable, args, options, callback) => {
      calls.push({ executable, args, options });
      const answer = queue.shift() ?? { error: new Error("none left") };
      callback(answer.error ?? null, answer.stdout ?? "");
    },
  });
  return { github, calls, clock };
}

test("reads exactly the merge settings and the default branch name with the user's gh environment", async () => {
  const saved = process.env.POMEGR_MONITOR_TOKEN;
  process.env.POMEGR_MONITOR_TOKEN = "synthetic-token";
  try {
    const h = harness([{ stdout: repoJson() }]);
    assert.deepEqual(await h.github.read(repoA, "C:\\repo"), FACTS);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].executable, "gh");
    assert.deepEqual(h.calls[0].args, ["repo", "view", "--json", FIELDS]);
    assert.equal(h.calls[0].options.cwd, "C:\\repo");
    assert.equal(h.calls[0].options.shell, false);
    assert.equal(h.calls[0].options.timeout, 4000);
    assert.equal(h.calls[0].options.env.GH_PROMPT_DISABLED, "1");
    assert.equal(Object.hasOwn(h.calls[0].options.env, "POMEGR_MONITOR_TOKEN"), false);
  } finally {
    if (saved === undefined) delete process.env.POMEGR_MONITOR_TOKEN; else process.env.POMEGR_MONITOR_TOKEN = saved;
  }
});

test("a read is kept in memory for 30 minutes for each repository", async () => {
  const h = harness([{ stdout: repoJson() }, { stdout: repoJson({ autoMergeAllowed: false }) }, { stdout: repoJson({ deleteBranchOnMerge: true }) }]);
  assert.equal((await h.github.read(repoA, "C:\\a")).autoMergeAllowed, true);
  h.clock.now += 30 * 60_000 - 1;
  assert.equal((await h.github.read(repoA, "C:\\a")).autoMergeAllowed, true);
  assert.equal(h.calls.length, 1);
  assert.equal((await h.github.read(repoB, "C:\\b")).autoMergeAllowed, false, "another repository has its own read");
  assert.equal(h.calls.length, 2);
  h.clock.now += 1;
  assert.equal((await h.github.read(repoA, "C:\\a")).deleteBranchOnMerge, true);
  assert.equal(h.calls.length, 3);
});

test("a failed read is kept as unknown for 5 minutes, then asked again", async () => {
  const h = harness([{ error: Object.assign(new Error("offline"), { code: 1 }), stdout: "private output" }, { stdout: repoJson() }]);
  assert.equal(await h.github.read(repoA, "C:\\a"), null);
  h.clock.now += 5 * 60_000 - 1;
  assert.equal(await h.github.read(repoA, "C:\\a"), null);
  assert.equal(h.calls.length, 1);
  h.clock.now += 1;
  assert.deepEqual(await h.github.read(repoA, "C:\\a"), FACTS);
  assert.equal(h.calls.length, 2);
});

test("an answer without all five booleans is unknown, and a bad default branch is only unknown itself", async () => {
  for (const stdout of ["", "not json", "[]", "null", repoJson({ squashMergeAllowed: "true" }), repoJson({ autoMergeAllowed: undefined }), repoJson({ deleteBranchOnMerge: 0 })]) {
    const h = harness([{ stdout }]);
    assert.equal(await h.github.read(repoA, "C:\\a"), null, stdout);
  }
  for (const defaultBranchRef of [null, {}, { name: "bad..name" }, { name: "x y" }, { name: 7 }, "main"]) {
    const h = harness([{ stdout: repoJson({ defaultBranchRef }) }]);
    assert.deepEqual(await h.github.read(repoA, "C:\\a"), { ...FACTS, defaultBranch: null }, JSON.stringify(defaultBranchRef));
  }
});

test("a refresh stores a new read for 30 minutes, and a refresh that fails or is unreadable leaves what is held untouched", async () => {
  const h = harness([{ stdout: repoJson() }, { error: Object.assign(new Error("offline"), { code: 1 }) }, { stdout: "not json" }, { stdout: repoJson({ autoMergeAllowed: false }) }]);
  assert.equal(h.github.age(repoA), null, "nothing is held before a read");
  assert.equal((await h.github.read(repoA, "C:\\a")).autoMergeAllowed, true);
  h.clock.now += 25 * 60_000;
  assert.equal(h.github.age(repoA), 25 * 60_000);

  assert.equal(await h.github.refresh(repoA, "C:\\a"), false, "an offline gh stores nothing");
  assert.equal(await h.github.refresh(repoA, "C:\\a"), false, "an answer without the five booleans stores nothing");
  assert.equal(h.github.age(repoA), 25 * 60_000, "and the age is still the age of the first read");
  h.clock.now += 4 * 60_000;
  assert.equal((await h.github.read(repoA, "C:\\a")).autoMergeAllowed, true, "the last facts serve until their 30 minutes end");
  assert.equal(h.calls.length, 3);

  assert.equal(await h.github.refresh(repoA, "C:\\a"), true);
  assert.equal(h.github.age(repoA), 0);
  h.clock.now += 29 * 60_000;
  assert.equal((await h.github.read(repoA, "C:\\a")).autoMergeAllowed, false, "30 minutes count from the refresh");
  assert.equal(h.calls.length, 4);
});

test("a failed read is unknown, so it has no age, and a refresh replaces it", async () => {
  const h = harness([{ error: Object.assign(new Error("offline"), { code: 1 }) }, { stdout: repoJson() }]);
  assert.equal(await h.github.read(repoA, "C:\\a"), null);
  assert.equal(h.github.age(repoA), null);
  assert.equal(await h.github.refresh(repoA, "C:\\a"), true);
  assert.deepEqual(await h.github.read(repoA, "C:\\a"), FACTS);
  assert.equal(h.calls.length, 2);
});

test("one gh read runs for a repository at a time: a read or a refresh that finds it running waits for its answer", async () => {
  const calls = [];
  const release = [];
  const github = createRepositoryGithub({
    now: () => 1_000_000,
    execFile: (_executable, _args, options, callback) => { calls.push(options.cwd); release.push(() => callback(null, repoJson())); },
  });
  const refreshing = github.refresh(repoA, "C:\\a");
  const reading = github.read(repoA, "C:\\a");
  const refreshingAgain = github.refresh(repoA, "C:\\a");
  const other = github.read(repoB, "C:\\b");
  assert.deepEqual(calls, ["C:\\a", "C:\\b"], "the second and third wait for the first; another repository has its own");
  for (const answer of release) answer();
  assert.deepEqual(await Promise.all([refreshing, refreshingAgain]), [true, true]);
  assert.deepEqual(await reading, FACTS);
  assert.deepEqual(await other, FACTS);
  await github.read(repoA, "C:\\a");
  assert.equal(calls.length, 2, "and the answer is held");
});
