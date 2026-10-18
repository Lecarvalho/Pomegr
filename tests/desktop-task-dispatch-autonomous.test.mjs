import assert from "node:assert/strict";
import test from "node:test";

import { repositoryId, root, token, json, basePlan, fakeChild, harness, go, aborted } from "./helpers/task-dispatch-harness.mjs";

const autonomousRequest = (isAuthorized = () => true) => ({
  attemptId: `pilot-${"a".repeat(24)}_T-3`, expectedUpdatedAt: "2026-10-18T12:00:00.000Z", expectedTaskDigest: "a".repeat(64),
  expectedRun: { provider: null, model: null, effort: null }, isAuthorized,
});
const autonomousWorktree = `${root}\\.pomegr\\worktrees\\T-3`;
const worktrees = { ensure: async () => ({ ok: true, directory: autonomousWorktree, created: true, branchCreated: true }) };

test("autonomous starts require a grant callback, skip confirmation, and share the native slot", async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees }, answer: async (url) => {
    if (url.endsWith("start-check")) return json({ ok: true });
    await pending;
    return json({ ok: true, plan: { ...basePlan(), worktree: true } });
  } });
  assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", { ...autonomousRequest(), isAuthorized: undefined }), { status: "invalid" });
  const started = h.start.startAutonomous(repositoryId, "T-3", autonomousRequest((selection) => { seen.push(selection); return true; }));
  assert.deepEqual(await go(h), { status: "busy" });
  assert.deepEqual(await h.start.startQueued(repositoryId, "T-3"), { status: "busy" });
  release();
  assert.deepEqual(await started, { status: "started" });
  assert.equal(h.spawns[0][2].cwd, autonomousWorktree);
  assert.deepEqual(h.log, ["start-plan", "start-check"]);
  assert.deepEqual(seen.at(-1), { taskId: "T-3", provider: "claude", model: null, effort: null });
  const { isAuthorized: _callback, ...decision } = autonomousRequest();
  assert.deepEqual(h.calls[0].body.payload, { id: "T-3", worktree: true, autonomous: decision });
  assert.deepEqual(h.calls.find((call) => call.url.endsWith("start-check")).body.payload, { id: "T-3", token, worktree: true });
});

test("autonomous starts refuse a plan that does not confirm its requested worktree", async () => {
  let ensured = false;
  const h = harness({ overrides: { worktrees: { ensure: async () => { ensured = true; return { ok: true, directory: autonomousWorktree }; } } } });
  assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", autonomousRequest()), { status: "failed" });
  assert.equal(h.calls[0].body.payload.worktree, true);
  assert.equal(ensured, false);
  assert.equal(h.spawns.length, 0);
  assert.equal(aborted(h).length, 1);
});

test("autonomous grant revocation prevents worktree effects and aborts the claimed dispatch", async () => {
  let ensured = false;
  const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees: { ensure: async () => { ensured = true; return { ok: true, directory: autonomousWorktree }; } } } });
  assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", autonomousRequest((selection) => selection === undefined)), { status: "cancelled" });
  assert.equal(ensured, false);
  assert.equal(h.spawns.length, 0);
  assert.equal(aborted(h).length, 1);
});

test("autonomous final gate revalidation and revoked grant each prevent spawning", async () => {
  for (const revoke of [false, true]) {
    let valid = true;
    const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees }, answer: async (url) => {
      if (url.endsWith("start-check")) {
        valid = !revoke;
        return json(revoke ? { ok: true } : { ok: false, error: "gate_held" });
      }
      return json({ ok: true, plan: { ...basePlan(), worktree: true } });
    } });
    assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", autonomousRequest(() => valid)), { status: revoke ? "cancelled" : "gate_held" });
    assert.equal(h.spawns.length, 0);
    assert.equal(aborted(h).length, 1);
  }
});

test("a final autonomous gate refusal removes a newly created worktree after aborting the claim", async () => {
  for (const check of [
    { answer: json({ ok: false, error: "gate_held" }), status: "gate_held" },
    { answer: async () => { throw new Error("private transport failure"); }, status: "unavailable" },
  ]) {
    const calls = [];
    const worktrees = {
      ensure: async (selection) => { calls.push(["ensure", selection]); return { ok: true, directory: autonomousWorktree, created: true, branchCreated: true }; },
      remove: async (selection) => { calls.push(["remove", selection]); return { ok: true }; },
    };
    const h = harness({ plan: { ...basePlan(), worktree: true }, overrides: { worktrees }, answer: async (url) => {
      if (url.endsWith("start-check")) {
        if (typeof check.answer === "function") return check.answer(url);
        return check.answer;
      }
      return json({ ok: true, plan: { ...basePlan(), worktree: true } });
    } });
    assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", autonomousRequest()), { status: check.status });
    assert.deepEqual(aborted(h).map((call) => call.body), [{ repositoryId, payload: { id: "T-3", token } }]);
    assert.equal(h.spawns.length, 0);
    assert.deepEqual(calls, [
      ["ensure", { repositoryRoot: root, repositoryId, taskId: "T-3" }],
      ["remove", { repositoryRoot: root, repositoryId, taskId: "T-3", deleteBranch: true }],
    ]);
  }
});

test("an ambiguous autonomous launcher outcome keeps the durable claim and worktree", async () => {
  let removed = false;
  const h = harness({ plan: { ...basePlan(), worktree: true }, answer: async (url) => json(url.endsWith("start-check") ? { ok: true } : { ok: true, plan: { ...basePlan(), worktree: true } }),
    spawnImpl: () => fakeChild(1), overrides: { worktrees: { ensure: async () => ({ ok: true, directory: root, created: true }), remove: async () => { removed = true; } } } });
  assert.deepEqual(await h.start.startAutonomous(repositoryId, "T-3", autonomousRequest()), { status: "uncertain" });
  assert.equal(aborted(h).length, 0);
  assert.equal(removed, false);
});
