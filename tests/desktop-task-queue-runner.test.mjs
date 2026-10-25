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
function harness({ next = { ok: true, starts: [] }, startQueued, pauseAnswer, cleanups, cleanWorktree, overrides = {} } = {}) {
  const timers = scheduler();
  const calls = [];
  const started = [];
  const starter = {
    startQueued: startQueued || (async (repositoryId, taskId) => { started.push({ repositoryId, taskId }); return { status: "started" }; }),
    // Only a starter that can remove worktrees is asked to.
    ...(cleanWorktree ? { cleanWorktree } : {}),
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
      if (route === "worktree-cleanups") return typeof cleanups === "function" ? cleanups() : json(cleanups ?? { ok: true, cleanups: [] });
      if (route === "worktree-cleaned") return json({ ok: true });
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
    started: null, busy: null, not_startable: null, gate_held: null, tree_dirty: null, not_found: null, cancelled: null,
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

const rootA = "C:\\Work\\a";
const cleanup = (repositoryId, taskId, repositoryRoot = rootA) => ({ repositoryId, taskId, repositoryRoot });
const routes = (h) => h.calls.map((call) => call.route);

function grantHarness({ steps = [], next = [], start, responses = {} } = {}) {
  const timers = scheduler(), calls = [], launches = [];
  const granted = (kind) => async (repositoryId, taskId, authorized, run) => {
    launches.push({ repositoryId, taskId, kind, ...(run === undefined ? {} : { run }) });
    return start ? start({ repositoryId, taskId, kind }, authorized) : { status: await authorized() ? "started" : "cancelled" };
  };
  const runner = createTaskQueueRunner({
    monitorOrigin: origin, authorizationToken: "secret", setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    starter: { startQueued: granted("queue"), startGranted: granted("start"), startGrantedReview: granted("review") },
    fetch: async (url, options) => {
      const route = url.split("/").pop(), body = JSON.parse(options.body);
      calls.push({ route, body, options });
      if (responses[route]) return responses[route](body);
      return json(route === "queue-next" ? { ok: true, starts: next }
        : route === "grant-next" ? { ok: true, steps }
          : route === "grant-check" ? { ok: true, active: true }
            : route === "grant-end-all" ? { ok: true, ended: 1 } : { ok: true });
    },
  });
  return { runner, timers, calls, launches };
}
const grantStep = (taskId, kind = "start", repositoryId = repoA) => ({ repositoryId, taskId, kind });

test("grant runner forwards valid review runs and drops malformed run steps", async () => {
  const valid = [grantStep("T-1", "review"),
    ...["claude", "codex"].flatMap((provider) => [null, "model-1.2:variant[long]", "a".repeat(120)].flatMap((model) =>
      [null, "low", "medium", "high", "xhigh"].map((effort) => ({ ...grantStep("T-2", "review"), run: { provider, model, effort } }))))];
  const base = { provider: "codex", model: null, effort: null };
  const invalid = [null, [], "codex", {}, { ...base, provider: null }, { ...base, provider: "other" },
    { provider: "codex", effort: null }, { provider: "codex", model: null }, { ...base, extra: true },
    ...["", "bad model", "-flag", "a".repeat(121), "a\n", 42].map((model) => ({ ...base, model })),
    ...["max", "unknown", 42].map((effort) => ({ ...base, effort }))];
  for (const step of valid) {
    const h = grantHarness({ steps: [...invalid.map((run) => ({ ...grantStep("T-3", "review"), run })), step] });
    h.runner.start(); await h.timers.fire();
    assert.deepEqual(h.launches, [step]);
    assert.deepEqual(h.calls.filter(({ route }) => route === "grant-record").map(({ body }) => body),
      [{ repositoryId: step.repositoryId, taskId: step.taskId, kind: step.kind }]);
  }
});

test("grant send-backs are posted before starts and reviews without launching a session", async () => {
  const h = grantHarness({ steps: [grantStep("T-1", "start"), grantStep("T-2", "send_back"), grantStep("T-3", "review"), grantStep("T-4", "send_back"), grantStep("T-5", "sent_back")] });
  h.runner.start(); await h.timers.fire();
  assert.deepEqual(h.calls.filter(({ route }) => route === "grant-send-back").map(({ body }) => body), [
    { repositoryId: repoA, taskId: "T-2" }, { repositoryId: repoA, taskId: "T-4" },
  ]);
  assert.deepEqual(h.launches.map(({ taskId, kind }) => [taskId, kind]), [["T-1", "start"], ["T-3", "review"]]);
  assert.ok(routes(h).indexOf("grant-send-back") < routes(h).indexOf("grant-check"));
});

test("grant send-back refusals and request failures are settled and do not end the grant", async () => {
  for (const response of [() => { throw Error("offline"); }, () => new Response("invalid json"), () => json({ ok: false, error: "not_ready" })]) {
    const h = grantHarness({ steps: [grantStep("T-1", "send_back"), grantStep("T-2", "start")], responses: { "grant-send-back": response } });
    h.runner.start(); await h.timers.fire();
    assert.deepEqual(h.launches.map(({ taskId, kind }) => [taskId, kind]), [["T-2", "start"]]);
    assert.equal(routes(h).includes("grant-end"), false);
  }
});

test("grant restart cleanup runs once on the first tick before any queue or grant work", async () => {
  const h = grantHarness(); h.runner.start();
  assert.deepEqual(h.calls, []);
  await h.timers.fire(); await h.timers.fire();
  assert.deepEqual(routes(h), ["grant-end-all", "queue-next", "grant-next", "queue-next", "grant-next"]);
  assert.deepEqual(h.calls[0].body, { reason: "app_restart" });
  assert.equal(h.calls[0].options.headers[DESKTOP_AUTH_HEADER], "secret");
  assert.equal(h.calls[0].options.redirect, "error");
});

test("queue starts finish first and grant start and review steps run serially and record success", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const steps = [grantStep("T-2"), grantStep("T-3", "review")];
  const checks = [];
  const h = grantHarness({ next: entries([repoA, "T-1"]), steps, start: async (step, authorized) => {
    if (step.kind === "queue") await gate;
    else { checks.push(await authorized()); checks.push(await authorized()); }
    return { status: "started" };
  } });
  h.runner.start(); const tick = h.timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.launches, [grantStep("T-1", "queue")]);
  assert.equal(routes(h).includes("grant-next"), false);
  release(); await tick;
  assert.deepEqual(h.launches, [grantStep("T-1", "queue"), ...steps]);
  assert.deepEqual(checks, [true, true, true, true]);
  assert.deepEqual(h.calls.filter(({ route }) => route === "grant-check").map(({ body }) => body), Array(4).fill({ repositoryId: repoA }));
  assert.deepEqual(h.calls.filter(({ route }) => route === "grant-record").map(({ body }) => body), steps);
  assert.deepEqual(routes(h).slice(2), ["grant-next", "grant-check", "grant-check", "grant-record", "grant-check", "grant-check", "grant-record"]);
});

test("grant settled statuses post nothing and failures end only that repository and skip its remaining steps", async () => {
  for (const status of ["busy", "not_startable", "gate_held", "tree_dirty", "cancelled", "not_found", "failed", "cli_missing", "worktree_dirty", "unknown", undefined]) {
    const settled = ["busy", "not_startable", "gate_held", "tree_dirty", "cancelled", "not_found"].includes(status);
    const h = grantHarness({ steps: [grantStep("T-1"), grantStep("T-2", "review"), grantStep("T-3", "start", repoB)], start: async () => ({ status }) });
    h.runner.start(); await h.timers.fire();
    assert.equal(h.launches.length, settled ? 3 : 2, String(status));
    assert.equal(routes(h).includes("grant-record"), false);
    assert.deepEqual(h.calls.filter(({ route }) => route === "grant-end").map(({ body }) => body), settled ? [] : [
      { repositoryId: repoA, reason: "start_failed" }, { repositoryId: repoB, reason: "start_failed" },
    ]);
  }
});

test("grant request failures and not_active records are swallowed and ticks continue", async () => {
  for (const route of ["grant-next", "grant-check", "grant-record", "grant-end"]) {
    for (const response of [() => { throw Error("offline"); }, () => new Response("invalid json"), () => json({ ok: false, error: "not_active" })]) {
      const h = grantHarness({ steps: [grantStep("T-1")], responses: { [route]: response },
        ...(route === "grant-end" ? { start: async () => { throw Error("launch"); } } : {}) });
      h.runner.start(); await h.timers.fire(); await h.timers.fire();
      assert.equal(h.timers.pending().length, 1);
      assert.equal(routes(h).filter((name) => name === route).length, 2);
      if (route !== "grant-end") assert.equal(routes(h).includes("grant-end"), false);
    }
  }
});

test("failed restart cleanup disables grant execution for this runner but leaves the queue timer alive", async () => {
  for (const response of [() => { throw Error("offline"); }, () => new Response("invalid json"),
    () => json({ ok: false }), () => json({ ok: true }), () => json({ ok: true, ended: -1 })]) {
    const h = grantHarness({ steps: [grantStep("T-1")], responses: { "grant-end-all": response } });
    h.runner.start(); await h.timers.fire(); await h.timers.fire();
    assert.deepEqual(h.launches, []);
    assert.deepEqual(routes(h), ["grant-end-all", "queue-next", "queue-next"]);
    assert.equal(h.timers.pending().length, 1);
  }
});

test("grant step validation ignores malformed steps and caps each tick at sixteen", async () => {
  const valid = Array.from({ length: 20 }, (_, index) => grantStep(`T-${index + 1}`, index % 2 ? "review" : "start"));
  const h = grantHarness({ steps: [null, [], grantStep("T-0"), grantStep("T-1", "merge"), grantStep("T-1", "start", "invalid"), ...valid] });
  h.runner.start(); await h.timers.fire();
  assert.deepEqual(h.launches, valid.slice(0, 16));
});

test("a queue request failure does not suppress grant work", async () => {
  const h = grantHarness({ steps: [grantStep("T-1")], responses: { "queue-next": () => { throw Error("offline"); } } });
  h.runner.start(); await h.timers.fire();
  assert.deepEqual(h.launches, [grantStep("T-1")]);
});

test("dispose stops grants in flight, revokes their callback and never records or ends a session", async () => {
  let release, authorized;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = grantHarness({ steps: [grantStep("T-1"), grantStep("T-2", "review")], start: async (_step, check) => {
    authorized = check; await gate; return { status: "started" };
  } });
  h.runner.start(); const tick = h.timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  h.runner.dispose();
  assert.equal(await authorized(), false);
  release(); await tick;
  assert.deepEqual(h.launches, [grantStep("T-1")]);
  assert.equal(routes(h).includes("grant-record"), false);
  assert.equal(routes(h).includes("grant-end"), false);
  assert.equal(h.timers.pending().length, 0);
});

test("a starter that cannot remove worktrees is never asked which wait", async () => {
  const h = harness();
  h.runner.start();
  for (let tick = 0; tick < 5; tick += 1) await h.timers.fire();
  assert.deepEqual(routes(h), Array(5).fill("queue-next"));
});

test("the worktrees of done tasks are removed on the first tick and every fourth after it, and only a removed one is reported", async () => {
  const outcomes = { "T-1": "removed", "T-2": "absent", "T-3": "kept", "T-4": "failed", "T-5": undefined };
  const cleaned = [];
  const h = harness({
    cleanups: { ok: true, cleanups: [cleanup(repoA, "T-1"), cleanup(repoA, "T-2"), cleanup(repoB, "T-3"), cleanup(repoB, "T-4"), cleanup(repoB, "T-5")] },
    cleanWorktree: async (repositoryId, taskId, repositoryRoot) => {
      cleaned.push({ repositoryId, taskId, repositoryRoot });
      if (taskId === "T-5") throw new Error("git");
      return outcomes[taskId];
    },
  });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(cleaned.map((entry) => entry.taskId), ["T-1", "T-2", "T-3", "T-4", "T-5"]);
  assert.deepEqual(cleaned[0], { repositoryId: repoA, taskId: "T-1", repositoryRoot: rootA });
  assert.deepEqual(routes(h), ["queue-next", "worktree-cleanups", "worktree-cleaned", "worktree-cleaned"]);
  assert.deepEqual(h.calls.filter((call) => call.route === "worktree-cleaned").map((call) => call.body), [
    { repositoryId: repoA, payload: { id: "T-1" } }, { repositoryId: repoA, payload: { id: "T-2" } },
  ]);
  assert.deepEqual(h.calls[1].body, {});
  for (let tick = 0; tick < 3; tick += 1) await h.timers.fire();
  assert.equal(routes(h).filter((route) => route === "worktree-cleanups").length, 1);
  await h.timers.fire();
  assert.equal(routes(h).filter((route) => route === "worktree-cleanups").length, 2);
});

test("a malformed or failed cleanup answer removes nothing, and the next tick is still armed", async () => {
  const answers = [
    () => json({ ok: false, error: "unavailable" }), () => json({ ok: true, cleanups: "T-1" }), () => json(null), () => { throw new Error("offline"); },
    () => json({ ok: true, cleanups: [null, cleanup("repo-x", "T-1"), cleanup(repoA, "T-0"), cleanup(repoA, "T-1", 7), { repositoryId: repoA, taskId: "T-1" }] }),
  ];
  for (const cleanups of answers) {
    const cleaned = [];
    const h = harness({ cleanups, cleanWorktree: async (...request) => { cleaned.push(request); return "removed"; } });
    h.runner.start();
    await h.timers.fire();
    assert.deepEqual(cleaned, []);
    assert.equal(routes(h).includes("worktree-cleaned"), false);
    assert.equal(h.timers.pending().length, 1);
  }
});

test("a disposed runner stops removing worktrees", async () => {
  const cleaned = [];
  const h = harness({
    cleanups: { ok: true, cleanups: [cleanup(repoA, "T-1"), cleanup(repoA, "T-2")] },
    cleanWorktree: async (_repositoryId, taskId) => { cleaned.push(taskId); h.runner.dispose(); return "removed"; },
  });
  h.runner.start();
  await h.timers.fire();
  assert.deepEqual(cleaned, ["T-1"]);
  assert.equal(routes(h).includes("worktree-cleaned"), false);
});
