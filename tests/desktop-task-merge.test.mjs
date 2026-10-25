import assert from "node:assert/strict";
import test from "node:test";

import { createTaskMerge } from "../desktop/runtime/task-merge.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const taskId = "T-4";
const headOid = "a".repeat(40);
const step = { repositoryId, taskId, kind: "merge", pullRequest: 12, headOid, mergeMethod: null };

function harness({ attempt = { ok: true, pullRequest: 12 }, root = "C:\\repo", view = { stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}' }, merge, authorized = async () => true } = {}) {
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
      callback?.(args[1] === "view" ? view.error ?? null : merge?.error ?? null,
        args[1] === "view" ? view.stdout : merge?.stdout ?? "");
    },
    timeoutMs: 3000,
  });
  return { run: () => runner.merge(step, authorized), calls, posts };
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
    ["repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"],
    ["pr", "merge", "12", "--squash", "--match-head-commit", headOid],
  ]);
  assert.equal(h.calls[1].options.cwd, "C:\\repo");
  assert.equal(h.calls[1].options.timeout, 3000);
  assert.equal(h.calls[1].options.shell, false);
  assert.equal(h.calls[1].options.timeout, 3000);
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

test("explicit methods skip repository discovery", async () => {
  for (const method of ["squash", "merge", "rebase"]) {
    const calls = [];
    const explicit = { ...step, mergeMethod: method };
    const result = await createTaskMerge({
      post: async (route) => route === "grant-merge-attempt" ? { ok: true, pullRequest: 12 } : route === "worktree-root" ? { ok: true, root: "C:\\repo" } : { ok: true },
      execFile: (_exe, args, _options, callback) => { calls.push(args); callback(null, ""); },
    }).merge(explicit, async () => true);
    assert.deepEqual(result, { outcome: "merged" }, method);
    assert.deepEqual(calls, [["pr", "merge", "12", `--${method}`, "--match-head-commit", headOid]], method);
  }
});

test("repository discovery requires all method facts and refuses ambiguous capabilities", async () => {
  for (const stdout of [
    '{"squashMergeAllowed":true,"mergeCommitAllowed":false}',
    '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":"false"}',
    '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}',
  ]) {
    const h = harness({ view: { stdout } });
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.calls.filter(({ args }) => args[1] === "merge").length, 0);
    assert.deepEqual(h.posts.find(({ route }) => route === "grant-merge-result").body,
      { repositoryId, taskId, headOid, outcome: "refused" });
  }
});

test("each sole allowed repository method is selected", async () => {
  for (const [key, method] of [["squashMergeAllowed", "squash"], ["mergeCommitAllowed", "merge"], ["rebaseMergeAllowed", "rebase"]]) {
    const flags = { squashMergeAllowed: false, mergeCommitAllowed: false, rebaseMergeAllowed: false, [key]: true };
    const h = harness({ view: { stdout: JSON.stringify(flags) } });
    assert.deepEqual(await h.run(), { outcome: "merged" }, method);
    assert.deepEqual(h.calls[1].args, ["pr", "merge", "12", `--${method}`, "--match-head-commit", headOid]);
  }
});

test("a grant refusal before gh prevents every command", async () => {
  const h = harness({ authorized: async () => false });
  assert.deepEqual(await h.run(), { outcome: "refused" });
  assert.equal(h.calls.length, 0);
});

test("ambiguous methods, changed pull request, and refused attempt never merge", async () => {
  for (const config of [
    { view: { stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}' } },
    { attempt: { ok: true, pullRequest: 13 } },
    { attempt: { ok: false, error: "not_active" } },
  ]) {
    const h = harness(config);
    assert.deepEqual(await h.run(), { outcome: "refused" });
    assert.equal(h.calls.filter(({ args }) => args?.[1] === "merge").length, 0);
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
