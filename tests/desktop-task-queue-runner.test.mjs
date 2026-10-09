import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_AUTH_HEADER } from "../shared/local-auth.mjs";
import { createTaskQueueRunner } from "../desktop/runtime/task-queue-runner.mjs";

const origin = "http://127.0.0.1:4317";
const repoA = "repo-0123456789abcdef01234567";
const repoB = "repo-fedcba987654321001234567";

const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

/** Manual timers: nothing runs until `fire()`, which resolves once the whole tick and its re-arm are done. */
function scheduler() {
  const timers = [];
  const api = {
    timers,
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false, fired: false, unreffed: false, unref() { timer.unreffed = true; return timer; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    pending: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    async fire() {
      const [timer] = api.pending();
      assert.ok(timer, "a timer is armed");
      timer.fired = true;
      await timer.callback();
    },
  };
  return api;
}

/** Fake monitor: `next` answers queue-next (a value, or a function), pauses are recorded. */
function harness({ next = { ok: true, starts: [] }, startQueued, pauseAnswer, overrides = {} } = {}) {
  const timers = scheduler();
  const calls = [];
  const started = [];
  const starter = {
    startQueued: startQueued || (async (repositoryId, taskId) => { started.push({ repositoryId, taskId }); return { status: "started" }; }),
  };
  const runner = createTaskQueueRunner({
    starter,
    monitorOrigin: origin,
    authorizationToken: "secret",
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url, options) => {
      const route = url.split("/").pop();
      calls.push({ url, route, options, body: JSON.parse(options.body) });
      if (route === "queue-pause") return pauseAnswer ? pauseAnswer() : json({ ok: true });
      return typeof next === "function" ? next() : json(next);
    },
    ...overrides,
  });
  return { runner, timers, calls, started, pauses: () => calls.filter((call) => call.route === "queue-pause") };
}

const entries = (...ids) => ids.map(([repositoryId, taskId]) => ({ repositoryId, taskId }));

test("nothing runs before the first interval and the timer is unref'd", () => {
  const h = harness();
  h.runner.start();
  h.runner.start();
  assert.equal(h.calls.length, 0);
  assert.equal(h.timers.pending().length, 1);
  assert.equal(h.timers.timers[0].delay, 15_000);
  assert.equal(h.timers.timers[0].unreffed, true);
  assert.ok(Object.isFrozen(h.runner));
});

test("the interval defaults to 15 seconds and never drops below 5", () => {
  for (const [intervalMs, expected] of [[undefined, 15_000], [100, 5_000], [20_000, 20_000], [Number.NaN, 15_000], ["1000", 15_000]]) {
    const h = harness({ overrides: { intervalMs } });
    h.runner.start();
    assert.equal(h.timers.timers[0].delay, expected, String(intervalMs));
  }
});

test("without a trusted origin, a token or a queued starter nothing is armed", () => {
  for (const overrides of [
    { monitorOrigin: undefined }, { monitorOrigin: "http://example.com:4317" }, { monitorOrigin: "https://127.0.0.1:4317" },
    { monitorOrigin: "http://user:pw@127.0.0.1:4317" }, { monitorOrigin: "http://127.0.0.1:4317/x" },
    { authorizationToken: "" }, { authorizationToken: undefined }, { starter: {} }, { starter: undefined },
  ]) {
    const h = harness({ overrides });
    h.runner.start();
    assert.equal(h.timers.timers.length, 0, JSON.stringify(overrides));
  }
});

test("a tick posts queue-next with the desktop token, no redirects and an empty body", async () => {
  const h = harness();
  h.runner.start();
  await h.timers.fire();
  assert.equal(h.calls.length, 1);
  const [call] = h.calls;
  assert.equal(call.url, `${origin}/internal/tasks/queue-next`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.cache, "no-store");
  assert.equal(call.options.headers[DESKTOP_AUTH_HEADER], "secret");
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.deepEqual(call.body, {});
  assert.equal(h.timers.pending().length, 1, "the next tick is armed after the first settles");
});

test("each answered start is started once, in order and one at a time", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    next: { ok: true, starts: entries([repoA, "T-1"], [repoB, "T-7"], [repoA, "T-2"]) },
    startQueued: async (repositoryId, taskId) => {
      order.push(`begin ${taskId}`);
      if (taskId === "T-1") await gate;
      order.push(`end ${taskId}`);
      return { status: "started" };
    },
  });
  h.runner.start();
  const tick = h.timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["begin T-1"]);
  release();
  await tick;
  assert.deepEqual(order, ["begin T-1", "end T-1", "begin T-7", "end T-7", "begin T-2", "end T-2"]);
  assert.equal(h.pauses().length, 0);
});

test("a start status maps to a fixed pause or to nothing", async () => {
  const expectations = {
    started: null, busy: null, not_startable: null, gate_held: null, not_found: null, cancelled: null,
    cli_missing: "cli_missing", plugin_missing: "plugin_missing", unsupported_platform: "unsupported_platform",
    worktree_dirty: "worktree_dirty",
    failed: "start_failed", unavailable: "start_failed", invalid: "start_failed", unsupported_provider: "start_failed",
    surprise: "start_failed", "": "start_failed", 7: "start_failed", undefined: "start_failed", null: "start_failed",
  };
  for (const [key, reason] of Object.entries(expectations)) {
    const status = key === "undefined" ? undefined : key === "null" ? null : /^\d+$/u.test(key) ? Number(key) : key;
    const h = harness({
      next: { ok: true, starts: entries([repoA, "T-3"]) },
      startQueued: async () => ({ status }),
    });
    h.runner.start();
    await h.timers.fire();
    const pauses = h.pauses();
    if (reason === null) { assert.equal(pauses.length, 0, key); continue; }
    assert.equal(pauses.length, 1, key);
    assert.equal(pauses[0].url, `${origin}/internal/tasks/queue-pause`);
    assert.deepEqual(pauses[0].body, { repositoryId: repoA, payload: { id: "T-3", reason } }, key);
    assert.equal(pauses[0].options.headers[DESKTOP_AUTH_HEADER], "secret");
    assert.equal(pauses[0].options.redirect, "error");
  }
});

test("a thrown start, or one with no result, pauses with start_failed", async () => {
  for (const startQueued of [async () => { throw new Error("boom"); }, async () => undefined, async () => null, () => { throw new Error("sync"); }]) {
    const h = harness({ next: { ok: true, starts: entries([repoA, "T-3"]) }, startQueued });
    h.runner.start();
    await h.timers.fire();
    assert.deepEqual(h.pauses().map((call) => call.body), [{ repositoryId: repoA, payload: { id: "T-3", reason: "start_failed" } }]);
  }
});

test("a failed pause is swallowed and the chain goes on", async () => {
  for (const pauseAnswer of [() => { throw new Error("down"); }, () => json({ ok: false, error: "not_found" }), () => new Response("not json")]) {
    const h = harness({
      next: { ok: true, starts: entries([repoA, "T-1"], [repoB, "T-2"]) },
      startQueued: async () => ({ status: "failed" }),
      pauseAnswer,
    });
    h.runner.start();
    await h.timers.fire();
    assert.equal(h.pauses().length, 2);
    assert.equal(h.timers.pending().length, 1);
  }
});

test("a failed queue-next does nothing: no start, no pause, and the next tick is armed", async () => {
  const answers = [
    () => { throw new Error("down"); },
    () => json({ ok: false, error: "unavailable" }),
    () => json({ starts: entries([repoA, "T-1"]) }),
    () => json({ ok: "true", starts: entries([repoA, "T-1"]) }),
    () => json(["not", "an", "object"]),
    () => json("text"),
    () => json(null),
    () => json({ ok: true, starts: "T-1" }),
    () => new Response("not json"),
  ];
  for (const next of answers) {
    const h = harness({ next });
    h.runner.start();
    await h.timers.fire();
    assert.equal(h.started.length, 0);
    assert.equal(h.pauses().length, 0);
    assert.equal(h.timers.pending().length, 1);
  }
});

test("invalid entries are dropped and at most sixteen valid ones are started", async () => {
  const mixed = [
    { repositoryId: repoA, taskId: "T-1" },
    { repositoryId: "repo-bad", taskId: "T-2" },
    { repositoryId: repoA, taskId: "T-0" },
    { repositoryId: repoA, taskId: "T-03" },
    { repositoryId: repoA, taskId: 4 },
    { repositoryId: null, taskId: "T-5" },
    null, "T-6", [repoA, "T-7"],
    { repositoryId: repoB, taskId: "T-8", extra: "ignored" },
  ];
  let h = harness({ next: { ok: true, starts: mixed } });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(h.started, entries([repoA, "T-1"], [repoB, "T-8"]));

  const many = Array.from({ length: 20 }, (_, index) => ({ repositoryId: repoA, taskId: `T-${index + 1}` }));
  h = harness({ next: { ok: true, starts: [{ repositoryId: "nope", taskId: "T-1" }, ...many] } });
  h.runner.start();
  await h.timers.fire();
  assert.equal(h.started.length, 16);
  assert.deepEqual(h.started[0], { repositoryId: repoA, taskId: "T-1" });
});

test("a slow start never overlaps the next tick", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({
    next: { ok: true, starts: entries([repoA, "T-1"]) },
    startQueued: async () => { await gate; return { status: "started" }; },
  });
  h.runner.start();
  const tick = h.timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.timers.pending().length, 0, "no timer is armed while the tick runs");
  assert.equal(h.calls.length, 1);
  release();
  await tick;
  assert.equal(h.timers.pending().length, 1);
  assert.equal(h.timers.pending()[0].unreffed, true);
  await h.timers.fire();
  assert.equal(h.calls.filter((call) => call.route === "queue-next").length, 2);
});

test("dispose clears the timer, stops mid-tick and makes later ticks no-ops", async () => {
  let h = harness();
  h.runner.start();
  const [armed] = h.timers.timers;
  h.runner.dispose();
  assert.equal(armed.cleared, true);
  await armed.callback();
  assert.equal(h.calls.length, 0, "a tick that still fires after dispose does nothing");
  assert.equal(h.timers.timers.length, 1, "and arms nothing");
  h.runner.start();
  assert.equal(h.timers.timers.length, 1, "a disposed runner cannot be started again");

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const begun = [];
  h = harness({
    next: { ok: true, starts: entries([repoA, "T-1"], [repoA, "T-2"]) },
    startQueued: async (repositoryId, taskId) => { begun.push(taskId); await gate; return { status: "unavailable" }; },
  });
  h.runner.start();
  const tick = h.timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  h.runner.dispose();
  release();
  await tick;
  assert.deepEqual(begun, ["T-1"], "the next start never begins");
  assert.equal(h.pauses().length, 0, "a start refused while closing does not pause the queue");
  assert.equal(h.timers.pending().length, 0);
});

test("the runner exposes only start and dispose, and returns nothing", async () => {
  const h = harness({ next: { ok: true, starts: entries([repoA, "T-1"]) } });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(Object.keys(h.runner).sort(), ["dispose", "start"]);
  assert.equal(h.runner.start(), undefined);
  assert.equal(h.runner.dispose(), undefined);
});

test("a queue paused by one start of a step starts nothing more in that tick, and other queues go on", async () => {
  const begun = [];
  const h = harness({
    next: { ok: true, starts: entries([repoA, "T-1"], [repoA, "T-2"], [repoB, "T-7"], [repoA, "T-3"]) },
    startQueued: async (repositoryId, taskId) => { begun.push(taskId); return { status: taskId === "T-1" ? "failed" : "started" }; },
  });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(begun, ["T-1", "T-7"]);
  assert.deepEqual(h.pauses().map((call) => call.body), [{ repositoryId: repoA, payload: { id: "T-1", reason: "start_failed" } }]);
});

test("a held start of a step does not stop the rest of the step", async () => {
  const begun = [];
  const h = harness({
    next: { ok: true, starts: entries([repoA, "T-1"], [repoA, "T-2"]) },
    startQueued: async (repositoryId, taskId) => { begun.push(taskId); return { status: taskId === "T-1" ? "gate_held" : "started" }; },
  });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(begun, ["T-1", "T-2"]);
  assert.equal(h.pauses().length, 0);
});
