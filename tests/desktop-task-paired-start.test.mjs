import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createTaskStart } from "../desktop/runtime/task-dispatch.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const root = "C:\\Work\\repo";
const worktreeDirectory = "C:\\Data\\task-worktrees\\repo-0123456789abcdef01234567\\T-3";
const token = "A".repeat(43);
const plan = () => ({ taskId: "T-3", provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Do the thing", token });
const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function harness({ startPlan = plan(), planAnswer, worktrees } = {}) {
  const calls = [];
  const spawns = [];
  const starter = createTaskStart({
    isTrustedEvent: (event) => event?.trusted === true,
    monitorOrigin: "http://127.0.0.1:4317",
    authorizationToken: "secret",
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Windows" },
    fileExists: (file) => file === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" || file === "C:\\Users\\tester\\.local\\bin\\claude.exe",
    directoryExists: (directory) => directory === root,
    confirm: async () => { throw new Error("paired start must not open the native dialog"); },
    fetch: async (url, options) => {
      calls.push({ route: url.split("/").at(-1), body: JSON.parse(options.body) });
      if (url.endsWith("start-abort")) return json({ ok: true });
      return planAnswer ? planAnswer() : json({ ok: true, plan: startPlan });
    },
    spawn: (...args) => {
      spawns.push(args);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
    worktrees,
  });
  return { starter, calls, spawns };
}

test("paired manual start skips the native dialog and shares the desktop and queue slot", async () => {
  let releasePlan;
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  const h = harness({ planAnswer: async () => { await planGate; return json({ ok: true, plan: plan() }); } });
  const paired = h.starter.startPaired(repositoryId, "T-3", undefined, () => true);
  assert.deepEqual(await h.starter.start({ trusted: true }, repositoryId, "T-3"), { status: "busy" });
  assert.deepEqual(await h.starter.startQueued(repositoryId, "T-3"), { status: "busy" });
  releasePlan();
  assert.deepEqual(await paired, { status: "started" });
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.calls.map(({ route }) => route), ["start-plan"]);
  assert.deepEqual(await h.starter.startPaired(repositoryId, "T-3", false, () => true), { status: "invalid" });
  assert.deepEqual(await h.starter.startPaired(repositoryId, "T-3", undefined, null), { status: "invalid" });
});

test("paired authorization lost while the private plan is pending aborts without launching", async () => {
  let releasePlan;
  const planGate = new Promise((resolve) => { releasePlan = resolve; });
  let authorized = true;
  const h = harness({ planAnswer: async () => { await planGate; return json({ ok: true, plan: plan() }); } });
  const pending = h.starter.startPaired(repositoryId, "T-3", undefined, () => authorized);
  while (h.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  authorized = false;
  releasePlan();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.calls.at(-1), { route: "start-abort", body: { repositoryId, payload: { id: "T-3", token } } });
});

test("paired authorization is checked after worktree creation and just before launch", async () => {
  let releaseWorktree;
  const worktreeGate = new Promise((resolve) => { releaseWorktree = resolve; });
  let startedEnsure;
  const ensureStarted = new Promise((resolve) => { startedEnsure = resolve; });
  let authorized = true;
  const removed = [];
  const worktrees = {
    ensure: async () => { startedEnsure(); await worktreeGate; return { ok: true, directory: worktreeDirectory, created: true, branchCreated: true }; },
    remove: async (request) => { removed.push(request); return "removed"; },
  };
  const h = harness({ startPlan: { ...plan(), worktree: true }, worktrees });
  const pending = h.starter.startPaired(repositoryId, "T-3", true, () => authorized);
  await ensureStarted;
  authorized = false;
  releaseWorktree();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(h.spawns.length, 0);
  assert.equal(h.calls.at(-1).route, "start-abort");
  assert.deepEqual(removed, [{ repositoryRoot: root, repositoryId, taskId: "T-3", deleteBranch: true }]);
});
