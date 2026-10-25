import assert from "node:assert/strict";
import test from "node:test";

import { createTaskMerge } from "../desktop/runtime/task-merge.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const taskId = "T-4";
const headOid = "a".repeat(40);
const step = { repositoryId, taskId, kind: "merge", pullRequest: 12, headOid, mergeMethod: null, mergeMode: "direct" };
const auto = { ...step, mergeMode: "auto" };
const FIELDS = "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed,deleteBranchOnMerge,defaultBranchRef";
const repoJson = (over = {}) => JSON.stringify({
  squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false,
  defaultBranchRef: { name: "main" }, ...over,
});
const pullView = (over = {}) => ({ stdout: JSON.stringify({ state: "OPEN", autoMergeRequest: { enabledAt: "private" }, isInMergeQueue: false, ...over }) });

function harness({ attempt = { ok: true, pullRequest: 12 }, root = "C:\\repo", view = { stdout: repoJson() }, merge, after = pullView(), authorized = async () => true, given = step } = {}) {
  const calls = [];
  const posts = [];
  const runner = createTaskMerge({
    post: async (route, body) => {
      posts.push({ route, body });
      if (route === "grant-merge-attempt") return attempt;
      if (route === "worktree-root") return { ok: true, root };
      return { ok: true };
    },
    execFile: (executable, args, options, callback) => {
      calls.push({ executable, args, options });
      const answer = args[0] === "repo" ? view : args[1] === "merge" ? merge : args[1] === "view" ? after : undefined;
      callback?.(answer?.error ?? null, answer?.stdout ?? "");
    },
    timeoutMs: 3000,
  });
  return { run: () => runner.merge(given, authorized), calls, posts, merges: () => calls.filter(({ args }) => args[1] === "merge") };
}

test("merge records an attempt, selects the sole allowed repository method, and records no gh output", async () => {
  const h = harness();
  assert.deepEqual(await h.run(), { outcome: "merged" });
  assert.deepEqual(h.posts, [
    { route: "grant-merge-attempt", body: { repositoryId, taskId, headOid } },
    { route: "worktree-root", body: { repositoryId, payload: {} } },
    { route: "grant-merge-result", body: { repositoryId, taskId, headOid, outcome: "merged" } },
  ]);
  assert.deepEqual(h.calls.map(({ args }) => args), [
    ["repo", "view", "--json", FIELDS],
    ["pr", "merge", "12", "--squash", "--match-head-commit", headOid],
  ]);
  assert.equal(h.calls[1].options.cwd, "C:\\repo");
  assert.equal(h.calls[1].options.timeout, 3000);
  assert.equal(h.calls[1].options.shell, false);
  assert.equal(h.calls[1].options.env.GH_PROMPT_DISABLED, "1");
  assert.equal(h.calls[1].options.env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(h.calls[1].args.some((arg) => ["--admin", "--delete-branch", "--auto"].includes(arg)), false);
});

test("gh never receives the app's own runtime variables or tokens", async () => {
  const saved = process.env.POMEGR_MONITOR_TOKEN;
  process.env.POMEGR_MONITOR_TOKEN = "synthetic-token";
  try {
    const h = harness();
    await h.run();
    for (const call of h.calls) assert.equal(Object.hasOwn(call.options.env, "POMEGR_MONITOR_TOKEN"), false);
  } finally {
    if (saved === undefined) delete process.env.POMEGR_MONITOR_TOKEN; else process.env.POMEGR_MONITOR_TOKEN = saved;
  }
});

test("explicit methods skip repository discovery in direct mode", async () => {
  for (const method of ["squash", "merge", "rebase"]) {
    const h = harness({ given: { ...step, mergeMethod: method } });
    assert.deepEqual(await h.run(), { outcome: "merged" }, method);
    assert.deepEqual(h.calls.map(({ args }) => args), [["pr", "merge", "12", `--${method}`, "--match-head-commit", headOid]], method);
  }
});

test("repository discovery requires all the facts and refuses ambiguous capabilities", async () => {
  for (const stdout of [
    JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false }),
    repoJson({ rebaseMergeAllowed: "false" }),
    repoJson({ autoMergeAllowed: undefined }),
    repoJson({ mergeCommitAllowed: true }),
    repoJson({ squashMergeAllowed: false }),
    "not json",
  ]) {
    const h = harness({ view: { stdout } });
    assert.deepEqual(await h.run(), { outcome: "refused" }, stdout);
    assert.equal(h.merges().length, 0);
    assert.deepEqual(h.posts.find(({ route }) => route === "grant-merge-result").body, { repositoryId, taskId, headOid, outcome: "refused" });
  }
});

test("each sole allowed repository method is selected", async () => {
  for (const [key, method] of [["squashMergeAllowed", "squash"], ["mergeCommitAllowed", "merge"], ["rebaseMergeAllowed", "rebase"]]) {
    const flags = { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false, [key]: true };
    const h = harness({ view: { stdout: repoJson(flags) } });
    assert.deepEqual(await h.run(), { outcome: "merged" }, method);
    assert.deepEqual(h.calls[1].args, ["pr", "merge", "12", `--${method}`, "--match-head-commit", headOid]);
  }
});

test("a grant refusal before gh prevents every command", async () => {
  for (const given of [step, auto, { ...auto, mergeMethod: "squash" }]) {
    const h = harness({ authorized: async () => false, given });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.calls.length, 0);
  }
});

test("ambiguous methods, changed pull request, and refused attempt never merge", async () => {
  for (const config of [
    { view: { stdout: repoJson({ mergeCommitAllowed: true }) } },
    { attempt: { ok: true, pullRequest: 13 } },
    { attempt: { ok: false, error: "not_active" } },
  ]) {
    const h = harness(config);
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.merges().length, 0);
  }
});

test("a step without a known merge mode or method is refused before any attempt", async () => {
  for (const given of [{ ...step, mergeMode: null }, { ...step, mergeMode: "queue" }, { ...step, mergeMode: undefined }, { ...step, mergeMethod: "ff" }, { ...step, kind: "delete_branch" }]) {
    const h = harness({ given });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.deepEqual(h.posts, []);
    assert.equal(h.calls.length, 0);
  }
});

test("grant authorization is checked immediately before each gh command", async () => {
  let checks = 0;
  const h = harness({ authorized: async () => ++checks === 1 });
  assert.deepEqual(await h.run(), { outcome: "refused" });
  assert.equal(checks, 2);
  assert.equal(h.calls.length, 1);
});

test("merge command failures are classified without returning command output", async () => {
  for (const [error, outcome] of [
    [Object.assign(new Error("no"), { code: 1 }), "refused"],
    [Object.assign(new Error("timeout"), { code: 1, killed: true }), "failed"],
    [Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), "failed"],
    [Object.assign(new Error("spawn"), { code: "ENOENT" }), "failed"],
  ]) {
    const h = harness({ merge: { error, stdout: "private output" } });
    assert.deepEqual(await h.run(), { outcome });
    const result = h.posts.find(({ route }) => route === "grant-merge-result");
    assert.deepEqual(result.body, { repositoryId, taskId, headOid, outcome });
  }
});

test("auto mode asks GitHub to merge when its own rules allow, with the exact arguments", async () => {
  const h = harness({ given: auto, after: pullView() });
  assert.deepEqual(await h.run(), { outcome: "auto_enabled" });
  assert.deepEqual(h.calls.map(({ args }) => args), [
    ["repo", "view", "--json", FIELDS],
    ["pr", "merge", "12", "--squash", "--auto", "--match-head-commit", headOid],
    ["pr", "view", "12", "--json", "state,autoMergeRequest,isInMergeQueue"],
  ]);
  assert.deepEqual(h.posts.map(({ route }) => route), ["grant-merge-attempt", "worktree-root", "grant-merge-result"]);
  assert.deepEqual(h.posts[2].body, { repositoryId, taskId, headOid, outcome: "auto_enabled" });
  assert.equal(h.calls[1].options.shell, false);
  const explicit = harness({ given: { ...auto, mergeMethod: "rebase" } });
  assert.deepEqual(await explicit.run(), { outcome: "auto_enabled" });
  assert.deepEqual(explicit.merges().map(({ args }) => args), [["pr", "merge", "12", "--rebase", "--auto", "--match-head-commit", headOid]]);
});

test("after an auto merge command, a merged pull request is merged, a queued or waiting one is auto_enabled, and an unconfirmed one failed", async () => {
  for (const [after, outcome] of [
    [pullView({ state: "MERGED", autoMergeRequest: null }), "merged"],
    [pullView({ state: "OPEN" }), "auto_enabled"],
    [pullView({ state: "OPEN", autoMergeRequest: null, isInMergeQueue: true }), "auto_enabled"],
    [pullView({ state: "OPEN", autoMergeRequest: null }), "failed"],
    [pullView({ state: "CLOSED", autoMergeRequest: null }), "failed"],
    [{ stdout: "not json" }, "failed"],
    [{ error: Object.assign(new Error("offline"), { code: 1 }), stdout: "private" }, "failed"],
  ]) {
    const h = harness({ given: auto, after });
    assert.deepEqual(await h.run(), { outcome }, JSON.stringify(after));
    assert.equal(h.posts.at(-1).body.outcome, outcome);
  }
});

test("auto mode is refused without calling gh pr merge when the repository does not allow it or its settings are unknown", async () => {
  for (const view of [{ stdout: repoJson({ autoMergeAllowed: false }) }, { stdout: "not json" }, { error: Object.assign(new Error("offline"), { code: 1 }) }]) {
    for (const given of [auto, { ...auto, mergeMethod: "squash" }]) {
      const h = harness({ given, view });
      assert.deepEqual(await h.run(), { outcome: "refused" });
      assert.equal(h.merges().length, 0);
      assert.equal(h.posts.at(-1).body.outcome, "refused");
    }
  }
});

test("no merge command ever carries --delete-branch or --admin, whatever the mode", async () => {
  for (const given of [step, auto, { ...step, mergeMethod: "merge" }, { ...auto, mergeMethod: "rebase" }]) {
    const h = harness({ given });
    await h.run();
    assert.equal(h.merges().length, 1);
    assert.equal(h.merges()[0].args.some((arg) => /delete|admin/u.test(arg)), false, h.merges()[0].args.join(" "));
    assert.equal(h.merges()[0].args.includes("--auto"), given.mergeMode === "auto");
  }
});
