import assert from "node:assert/strict";
import test from "node:test";

import { isBranchName } from "../shared/git-branch-name.mjs";
import { createTaskMerge } from "../desktop/runtime/task-merge.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const step = { repositoryId, taskId: "T-4", kind: "delete_branch", pullRequest: 12, branch: "tasks/T-4" };
const FIELDS = "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed,autoMergeAllowed,deleteBranchOnMerge,defaultBranchRef";
const repoJson = (over = {}) => JSON.stringify({
  squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false, autoMergeAllowed: true, deleteBranchOnMerge: false,
  defaultBranchRef: { name: "main" }, ...over,
});
const named = (value) => ({ stdout: JSON.stringify({ nameWithOwner: value }) });

function harness({ view = { stdout: repoJson() }, name = named("PomegrHQ/pomegr"), api = {}, authorized = async () => true, given = step, root = "C:\\repo" } = {}) {
  const calls = [];
  const posts = [];
  const runner = createTaskMerge({
    post: async (route, body) => {
      posts.push({ route, body });
      return route === "worktree-root" ? { ok: true, root } : { ok: true };
    },
    execFile: (executable, args, options, callback) => {
      calls.push({ executable, args, options });
      const answer = args[0] === "api" ? api : args[3] === "nameWithOwner" ? name : view;
      callback(answer.error ?? null, answer.stdout ?? "");
    },
    timeoutMs: 3000,
  });
  return { run: () => runner.deleteBranch(given, authorized), calls, posts, deletes: () => calls.filter(({ args }) => args[0] === "api") };
}
const posted = (h) => h.posts.filter(({ route }) => route === "grant-branch-result").map(({ body }) => body);

test("Git ref rules: names that could be an option, a path trick, or an invalid ref are refused", () => {
  for (const name of ["tasks/T-4", "feature/x-1.2", "a", "release_1", "x+y", "a".repeat(200), "main"]) assert.equal(isBranchName(name), true, name);
  for (const name of ["", " ", "-x", ".x", "a/.b", "a.", "x.lock", "a/b.lock/c", "a..b", "a//b", "/a", "a/", "a b", "a\nb", "a\tb", "a~1", "a^", "a:b", "a?b", "a*b", "a[b",
    "a\\b", "a@{b", "@", "ü", "a;b", "a$(x)", "a".repeat(201), null, undefined, 4, {}, ["a"]]) assert.equal(isBranchName(name), false, String(name));
});

test("deletes the merged head branch with an argument array after the owner and repository are read from gh", async () => {
  const saved = process.env.POMEGR_MONITOR_TOKEN;
  process.env.POMEGR_MONITOR_TOKEN = "synthetic-token";
  try {
    const h = harness();
    assert.deepEqual(await h.run(), { outcome: "deleted" });
    assert.deepEqual(h.calls.map(({ args }) => args), [
      ["repo", "view", "--json", FIELDS],
      ["repo", "view", "--json", "nameWithOwner"],
      ["api", "-X", "DELETE", "repos/PomegrHQ/pomegr/git/refs/heads/tasks/T-4"],
    ]);
    assert.deepEqual(h.posts, [
      { route: "worktree-root", body: { repositoryId, payload: {} } },
      { route: "grant-branch-result", body: { repositoryId, taskId: "T-4", outcome: "deleted" } },
    ]);
    for (const call of h.calls) {
      assert.equal(call.executable, "gh");
      assert.equal(call.options.cwd, "C:\\repo");
      assert.equal(call.options.shell, false);
      assert.equal(call.options.timeout, 3000);
      assert.equal(call.options.env.GH_PROMPT_DISABLED, "1");
      assert.equal(Object.hasOwn(call.options.env, "POMEGR_MONITOR_TOKEN"), false);
    }
  } finally {
    if (saved === undefined) delete process.env.POMEGR_MONITOR_TOKEN; else process.env.POMEGR_MONITOR_TOKEN = saved;
  }
});

test("an invalid step or branch name runs nothing and posts nothing", async () => {
  for (const given of [{ ...step, branch: "a..b" }, { ...step, branch: "-x" }, { ...step, branch: "a b" }, { ...step, branch: undefined }, { ...step, pullRequest: 0 },
    { ...step, taskId: "bad" }, { ...step, repositoryId: "repo-x" }, { ...step, kind: "merge" }, null]) {
    const h = harness({ given });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.posts, []);
  }
});

test("the repository's default branch, or a default branch Pomegr cannot read, is never deleted", async () => {
  for (const view of [{ stdout: repoJson({ defaultBranchRef: { name: "tasks/T-4" } }) }, { stdout: repoJson({ defaultBranchRef: null }) }, { stdout: "not json" },
    { error: Object.assign(new Error("offline"), { code: 1 }) }]) {
    const h = harness({ view });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.deletes().length, 0);
    assert.deepEqual(posted(h), [{ repositoryId, taskId: "T-4", outcome: "refused" }]);
  }
});

test("an owner and repository name that gh does not give in the expected shape refuses the delete", async () => {
  for (const name of [named("no-slash"), named("a/b/c"), named("../x"), named("a/.."), named("a/."), named("a b/c"), named(7), named(""), { stdout: "not json" }, { error: Object.assign(new Error("x"), { code: 1 }) }]) {
    const h = harness({ name });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.deletes().length, 0);
    assert.deepEqual(posted(h), [{ repositoryId, taskId: "T-4", outcome: "refused" }]);
  }
});

test("a delete that gh refuses or cannot finish is recorded as refused without its output", async () => {
  for (const error of [Object.assign(new Error("422"), { code: 1 }), Object.assign(new Error("timeout"), { killed: true }), Object.assign(new Error("spawn"), { code: "ENOENT" })]) {
    const h = harness({ api: { error, stdout: "private output" } });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.deepEqual(posted(h), [{ repositoryId, taskId: "T-4", outcome: "refused" }]);
    assert.doesNotMatch(JSON.stringify(h.posts), /private output/u);
  }
});

test("a stopped grant is checked before each gh command and posts nothing", async () => {
  for (const allowed of [0, 1, 2]) {
    let checks = 0;
    const h = harness({ authorized: async () => ++checks <= allowed });
    assert.deepEqual(await h.run(), { outcome: "skipped" });
    assert.equal(h.deletes().length, 0);
    assert.deepEqual(posted(h), []);
  }
});

test("the delete never uses a shell string, a force option, or session text", async () => {
  const h = harness();
  await h.run();
  const [call] = h.deletes();
  assert.equal(call.args.length, 4);
  assert.equal(call.args.some((arg) => /--(?:force|delete-branch)|-f$/u.test(arg)), false);
  assert.equal(call.options.shell, false);
});
