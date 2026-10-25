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
