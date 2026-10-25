import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import Module from "node:module";
import test from "node:test";
import * as dispatch from "../desktop/runtime/task-dispatch.mjs";

const repositoryId = "repo-0123456789abcdef01234567";
const taskId = "T-3";
const trusted = { trusted: true };
const root = "C:\\Work\\repo";
const worktree = `${root}\\.pomegr\\worktrees\\T-3`;
const token = "A".repeat(43);
const basePlan = () => ({ taskId, provider: "claude", model: null, effort: null, repositoryRoot: root, prompt: "Review the work", token });
const json = (value) => new Response(JSON.stringify(value));

function harness({ plan = basePlan(), answer, locate = async () => null, overrides = {} } = {}) {
  const calls = [], launches = [], order = [];
  const starter = dispatch.createTaskStart({
    platform: "win32", monitorOrigin: "http://127.0.0.1:4317", authorizationToken: "secret",
    isTrustedEvent: (event) => event === trusted,
    environment: { USERPROFILE: "C:\\Users\\tester", PATH: "C:\\Tools", POMEGR_MONITOR_TOKEN: "private" },
    fileExists: (file) => file.endsWith("claude.exe") || file.endsWith("codex.exe"),
    directoryExists: (directory) => directory === root || directory === worktree,
    confirm: async () => true,
    confirmReview: async (request) => { assert.deepEqual(request, { taskId }); order.push("confirm"); return true; },
    worktrees: { locate, ensure: () => assert.fail("a review never creates a worktree") },
    terminal: { ensureHost: async () => { order.push("host"); }, create: async (plan) => { order.push("create"); launches.push(plan); } },
    fetch: async (url, options) => {
      const route = url.split("/").pop(); order.push(route);
      calls.push({ route, body: JSON.parse(options.body) });
      return json(route.endsWith("abort") ? { ok: true } : answer ?? { ok: true, plan });
    },
    ...overrides,
  });
  return { starter, calls, launches, order };
}
const go = (h) => h.starter.startReview(trusted, repositoryId, taskId);
const aborted = (h) => h.calls.filter(({ route }) => route === "review-abort");

test("granted reviews never confirm and check authority before and after the plan and host", async () => {
  for (let revokedAt = 1; revokedAt <= 5; revokedAt++) {
    const order = [];
    const h = harness({ overrides: {
      confirm: () => assert.fail("no builder confirmation"), confirmReview: () => assert.fail("a grant already confirms"),
      fetch: async (url) => { order.push(url.split("/").pop()); return json({ ok: true, plan: basePlan() }); },
      worktrees: { locate: async () => { order.push("locate"); return worktree; } },
      terminal: { ensureHost: async () => order.push("host"), create: async () => order.push("create") },
    } });
    let checks = 0;
    assert.deepEqual(await h.starter.startGrantedReview(repositoryId, taskId, async () => { order.push("check"); return ++checks !== revokedAt; }),
      { status: revokedAt === 5 ? "started" : "cancelled" });
    const success = ["check", "review-plan", "check", "locate", "check", "host", "check", "create"];
    const index = success.map((value, i) => value === "check" ? i : -1).filter((i) => i >= 0)[revokedAt - 1];
    assert.deepEqual(order, revokedAt === 5 ? success : [...success.slice(0, index + 1), ...(revokedAt > 1 ? ["review-abort"] : [])]);
  }
});

test("granted reviews fail closed and all granted entries share the manual and queue busy slot", async () => {
  const h = harness();
  assert.deepEqual(await h.starter.startGrantedReview(repositoryId, taskId), { status: "invalid" });
  assert.deepEqual(await h.starter.startGrantedReview(repositoryId, taskId, async () => { throw Error("offline"); }), { status: "cancelled" });
  for (const entry of ["startGranted", "startGrantedReview"]) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const pending = h.starter[entry](repositoryId, taskId, () => gate);
    for (const name of ["startGranted", "startGrantedReview", "startQueued"]) {
      assert.deepEqual(await h.starter[name](repositoryId, taskId, async () => true), { status: "busy" });
    }
    assert.deepEqual(await go(h), { status: "busy" });
    assert.deepEqual(await h.starter.start(trusted, repositoryId, taskId), { status: "busy" });
    release(false); await pending;
  }
});

test("granted entries have no renderer IPC or preload exposure", async () => {
  const handlers = new Map(), calls = [];
  const remove = dispatch.installTaskStartIpc({ queueRunner: false,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    starter: { start: async () => { calls.push("manual"); }, startReview: async () => { calls.push("review"); }, openWorktree: async () => {},
      startGranted: () => assert.fail("renderer reached a grant"), startGrantedReview: () => assert.fail("renderer reached a grant") },
  });
  assert.deepEqual([...handlers.keys()].sort(), ["pomegr:task-review-start", "pomegr:task-start", "pomegr:task-worktree-open"]);
  await handlers.get(dispatch.TASK_START_CHANNEL)(trusted, repositoryId, taskId);
  await handlers.get(dispatch.TASK_REVIEW_START_CHANNEL)(trusted, repositoryId, taskId);
  assert.deepEqual(calls, ["manual", "review"]);
  assert.doesNotMatch(await readFile(new URL("../desktop/runtime/preload.cjs", import.meta.url), "utf8"), /startGranted|task-grant/iu);
  remove();
});

test("review refuses untrusted events, invalid IDs, unavailable runtime and non-Windows before posting", async () => {
  const h = harness();
  for (const args of [[{}, repositoryId, taskId], [trusted, "repo-bad", taskId], [trusted, repositoryId, "T-03"]]) {
    assert.deepEqual(await h.starter.startReview(...args), { status: "invalid" });
  }
  assert.deepEqual(h.order, []);
  for (const [overrides, status] of [[{ platform: "linux" }, "unsupported_platform"], [{ authorizationToken: "" }, "unavailable"], [{ fileExists: () => false }, "cli_missing"]]) {
    const refused = harness({ overrides });
    assert.deepEqual(await go(refused), { status }); assert.deepEqual(refused.order, []);
  }
});

test("cancelling the native confirmation posts nothing", async () => {
  const h = harness({ overrides: { confirmReview: async () => false } });
  assert.deepEqual(await go(h), { status: "cancelled" });
  assert.deepEqual(h.calls, []); assert.deepEqual(h.launches, []);
});

test("review confirmation has fixed copy, safe default and a live owner window", async () => {
  const window = { isDestroyed: () => false };
  let shown;
  const dialog = { showMessageBox: async (owner, options) => { assert.equal(owner, window); shown = options; return { response: 0 }; } };
  assert.equal(await dispatch.confirmTaskReviewStart(dialog, () => window, { taskId }), true);
  assert.equal(shown.title, "Start a review session?");
  assert.equal(shown.message, "Pomegr starts a separate session that reviews T-3's work in its folder and reports a verdict. It changes no code and does not move the task.");
  assert.deepEqual(shown.buttons, ["Start review", "Cancel"]);
  assert.equal(shown.defaultId, 1); assert.equal(shown.cancelId, 1);
  assert.equal(await dispatch.confirmTaskReviewStart(dialog, () => null, { taskId }), false);
  assert.equal(await dispatch.confirmTaskReviewStart({ showMessageBox: async () => ({ response: 1 }) }, () => window, { taskId }), false);
  assert.match(await readFile(new URL("../desktop/runtime/shell-main.mjs", import.meta.url), "utf8"), /confirmReview:.*confirmTaskReviewStart/u);
});

test("review uses the located folder or root without ensure, a unique review key, and a private token", async () => {
  for (const located of [worktree, null, "relative"]) {
    const h = harness({ locate: async (request) => { assert.deepEqual(request, { repositoryRoot: root, repositoryId, taskId }); return located; } });
    assert.deepEqual(await go(h), { status: "started" });
    assert.deepEqual(h.order, ["confirm", "review-plan", "host", "create"]);
    assert.deepEqual(h.calls, [{ route: "review-plan", body: { repositoryId, payload: { id: taskId } } }]);
    assert.equal(h.launches[0].cwd, located === worktree ? worktree : root);
    assert.match(h.launches[0].key, new RegExp(`^${repositoryId}/${taskId}/review-[a-f0-9]{32}$`));
    assert.equal(h.launches[0].env.POMEGR_TASK_TOKEN, token);
    assert.equal(h.launches[0].env.POMEGR_MONITOR_TOKEN, undefined);
    assert.equal(h.launches[0].env.PATH, "C:\\Tools");
    await go(h); assert.notEqual(h.launches[0].key, h.launches[1].key);
  }
});

test("review provider arguments never include image or remote-control flags", async () => {
  for (const provider of ["claude", "codex"]) {
    const h = harness({ plan: { ...basePlan(), provider, model: "model-1", effort: "high", images: ["private"], remoteControl: true } });
    assert.deepEqual(await go(h), { status: "started" });
    assert.deepEqual(h.launches[0].args, ["--model", "model-1", ...(provider === "claude" ? ["--effort", "high"] : ["-c", "model_reasoning_effort=high"]), "Review the work"]);
  }
});

test("malformed review plans abort with the validated token and never launch", async () => {
  for (const change of [{ taskId: "T-4" }, { provider: "__proto__" }, { model: "bad model" }, { model: undefined }, { effort: "max" },
    { prompt: "-option" }, { prompt: "" }, { prompt: "x".repeat(8001) }, { prompt: "a\0b" },
    { repositoryRoot: "relative" }, { repositoryRoot: "C:\\missing" }, { repositoryRoot: "C:\\Work\\..\\repo" }]) {
    const h = harness({ plan: { ...basePlan(), ...change } });
    assert.deepEqual(await go(h), { status: "failed" }); assert.deepEqual(h.launches, []);
    assert.deepEqual(aborted(h), [{ route: "review-abort", body: { repositoryId, payload: { id: taskId, token } } }]);
  }
  const h = harness({ plan: { ...basePlan(), token: "invalid" } });
  assert.deepEqual(await go(h), { status: "failed" }); assert.deepEqual(aborted(h), []);
});

test("monitor refusals preserve fixed statuses and never leak private errors", async () => {
  for (const [error, status] of [["not_startable", "not_startable"], ["plugin_missing", "plugin_missing"], ["private", "unavailable"]]) {
    const h = harness({ answer: { ok: false, error } });
    assert.deepEqual(await go(h), { status }); assert.deepEqual(h.launches, []);
  }
});

test("every failure after a valid plan aborts its dispatch", async () => {
  for (const overrides of [
    { terminal: { ensureHost: async () => { throw Error("host"); } } },
    { terminal: { ensureHost: async () => {}, create: async () => { throw Error("create"); } } },
    { worktrees: { locate: async () => { throw Error("locate"); } } },
    { fileExists: (file) => file.endsWith("codex.exe") },
  ]) {
    const h = harness({ overrides });
    const answer = await go(h);
    assert.deepEqual(answer, { status: overrides.fileExists ? "cli_missing" : "failed" });
    assert.equal(aborted(h).length, 1);
  }
});

test("review and builder starts share the exclusive slot", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ overrides: { confirm: async () => { await gate; return true; }, confirmReview: async () => { await gate; return true; } } });
  const builder = h.starter.start(trusted, repositoryId, taskId);
  assert.deepEqual(await go(h), { status: "busy" }); release(); await builder;
  const review = go(h);
  assert.deepEqual(await h.starter.start(trusted, repositoryId, taskId), { status: "busy" });
  await review;
});

test("review IPC installs, contains errors and removes its channel", async () => {
  assert.equal(dispatch.TASK_REVIEW_START_CHANNEL, "pomegr:task-review-start");
  const handlers = new Map();
  const remove = dispatch.installTaskStartIpc({ queueRunner: false,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) },
    starter: { startReview: async (...args) => { assert.deepEqual(args, [trusted, repositoryId, taskId]); throw Error("private"); } },
  });
  assert.deepEqual(await handlers.get(dispatch.TASK_REVIEW_START_CHANNEL)(trusted, repositoryId, taskId), { status: "failed" });
  remove(); assert.equal(handlers.size, 0);
});

test("preload validates review IDs before invoking the fixed channel", async () => {
  const require = createRequire(import.meta.url), invokes = [];
  let bridge;
  const original = Module._load, previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {} };
  Module._load = function (name, ...args) {
    if (name === "electron") return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: async (...args) => { invokes.push(args); return { status: "started" }; } } };
    return original.call(this, name, ...args);
  };
  try { require("../desktop/runtime/preload.cjs"); }
  finally { Module._load = original; globalThis.window = previousWindow; }
  for (const [repo, id] of [["bad", taskId], [repositoryId, "T-0"], [repositoryId, 3]]) assert.deepEqual(await bridge.taskReviewStart(repo, id), { status: "invalid" });
  assert.deepEqual(invokes, []);
  assert.deepEqual(await bridge.taskReviewStart(repositoryId, taskId), { status: "started" });
  assert.deepEqual(invokes, [["pomegr:task-review-start", repositoryId, taskId]]);
});
