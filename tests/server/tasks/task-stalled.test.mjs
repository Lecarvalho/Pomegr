import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveTaskSessionFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { createTaskStallWatcher, sessionEnded } from "../../../server/tasks/task-stall.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY_ID = "repo-0123456789abcdef01234567";
const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const OTHER_SESSION = "codex:019a0000-2222-7333-8444-555566667777";
const START_FACTS = { root: "C:/Work/SECRET-ROOT/repo", pluginReady: true };
const CLOSED = { title: null, state: "closed", observedModel: null, writerReleased: false };

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-stalled-"));
  const clock = { now: 1_000_000 };
  const env = { directory, clock, store: openTaskStore({ directory, now: () => clock.now }) };
  context.after(async () => {
    env.store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; } catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return env;
}

const apply = (env, action, payload) => env.store.apply(REPOSITORY_ID, action, payload);
const board = (env) => env.store.readBoard(REPOSITORY_ID);
const taskOf = (env, id = "T-1") => board(env).tasks.find((task) => task.id === id);

function createTask(env) {
  const created = apply(env, "create", { text: "Fix the flaky test", doneWhen: { checks: [], own: null } });
  assert.equal(created.ok, true);
  return created.board.tasks.reduce((best, task) => (Number(task.id.slice(2)) > Number(best.slice(2)) ? task.id : best), "T-0");
}

/** Creates a task and links `session` to it the way a started session does. */
function startedTask(env, session = SESSION) {
  const id = createTask(env);
  const planned = env.store.planStart(REPOSITORY_ID, { id }, () => START_FACTS);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId: session }), { ok: true });
  return id;
}

function setQueue(env, status, blockedBy = null) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(env.directory, "tasks.sqlite"));
  try {
    database.prepare("UPDATE repositories SET queue_status = ?, queue_blocked_by = ? WHERE repository_id = ?").run(status, blockedBy, REPOSITORY_ID);
  } finally { database.close(); }
}

test("only an established end counts as ended", () => {
  assert.equal(sessionEnded({ state: "closed" }), true);
  assert.equal(sessionEnded({ state: "stopped" }), true);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: true }), true);
  for (const state of ["working", "needs_input", "idle", "open", "unknown", "ended", "", null, undefined]) {
    assert.equal(sessionEnded({ state, writerReleased: false }), false, String(state));
  }
  // A released writer does not outrank a state the catalog still shows.
  for (const state of ["working", "needs_input", "idle", "open"]) assert.equal(sessionEnded({ state, writerReleased: true }), false, state);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: "true" }), false);
  for (const facts of [null, undefined, "closed", 1]) assert.equal(sessionEnded(facts), false);
});

test("a linked task whose session closed with no report is stalled, and the decision is persisted", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  env.clock.now = 2_000_000;
  const seen = [];
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => { seen.push(sessionId); return CLOSED; }), { ok: true, stalled: 1 });
  assert.deepEqual(seen, [SESSION]);
  const task = taskOf(env, id);
  assert.equal(task.state, "stalled");
  assert.equal(task.report, null);
  assert.equal(task.session.id, SESSION);
  assert.equal(task.updatedAt, new Date(2_000_000).toISOString());

  env.store.close();
  env.store = openTaskStore({ directory: env.directory, now: () => env.clock.now });
  assert.equal(taskOf(env, id).state, "stalled");
});

test("a stopped session and a released Codex writer stall the task too", async (context) => {
  const env = await setup(context);
  const first = startedTask(env);
  const second = startedTask(env, OTHER_SESSION);
  const facts = { [SESSION]: { state: "stopped" }, [OTHER_SESSION]: { state: "unknown", writerReleased: true } };
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => facts[sessionId]), { ok: true, stalled: 2 });
  assert.equal(taskOf(env, first).state, "stalled");
  assert.equal(taskOf(env, second).state, "stalled");
});

test("an idle, open, working, or unknown session never stalls a task", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  for (const state of ["idle", "open", "working", "needs_input", "unknown"]) {
    assert.deepEqual(env.store.stallEndedTasks(() => ({ state, writerReleased: false })), { ok: true, stalled: 0 }, state);
  }
  assert.deepEqual(env.store.stallEndedTasks(() => null), { ok: true, stalled: 0 });
  assert.deepEqual(env.store.stallEndedTasks(() => { throw new Error("no facts"); }), { ok: true, stalled: 0 });
  assert.deepEqual(env.store.stallEndedTasks(null), { ok: true, stalled: 0 });
  assert.equal(taskOf(env, id).state, "not_queued");
});

test("a task without a session, and a task that already has a report, are left alone", async (context) => {
  const env = await setup(context);
  const unlinked = createTask(env);
  const reported = startedTask(env);
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).ok, true);
  const blocked = startedTask(env, OTHER_SESSION);
  assert.equal(env.store.blockTask({ sessionId: OTHER_SESSION, reason: "Needs a decision" }).ok, true);
  const seen = [];
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => { seen.push(sessionId); return CLOSED; }), { ok: true, stalled: 0 });
  assert.deepEqual(seen, []);
  assert.equal(taskOf(env, unlinked).state, "not_queued");
  assert.equal(taskOf(env, reported).state, "done");
  assert.equal(taskOf(env, blocked).state, "blocked");
});

test("a stalled task never leaves stalled by itself", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  env.store.stallEndedTasks(() => CLOSED);
  // The session is observed working again, and reports: neither changes the decision.
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "working" })), { ok: true, stalled: 0 });
  assert.deepEqual(env.store.completeTask({ sessionId: SESSION }, () => null), { ok: false, error: "already_reported" });
  assert.deepEqual(env.store.blockTask({ sessionId: SESSION, reason: "Too late" }), { ok: false, error: "already_reported" });
  const task = taskOf(env, id);
  assert.equal(task.state, "stalled");
  assert.equal(task.report, null);
});

test("a stalled task holds a running queue and leaves an idle or paused one as it is", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  setQueue(env, "running");
  env.store.stallEndedTasks(() => CLOSED);
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: id });

  for (const status of ["idle", "paused"]) {
    const other = await setup(context);
    startedTask(other);
    setQueue(other, status);
    other.store.stallEndedTasks(() => CLOSED);
    assert.equal(board(other).queue.status, status);
    assert.equal(board(other).queue.blockedBy, null);
  }
});

test("the user resolves a stalled task: mark done resumes the queue, requeue clears the link and it is not stalled again", async (context) => {
  const env = await setup(context);
  const done = startedTask(env);
  const requeued = startedTask(env, OTHER_SESSION);
  setQueue(env, "running");
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 2 });
  assert.equal(board(env).queue.blockedBy, done);

  assert.equal(apply(env, "resolve_done", { id: done }).ok, true);
  assert.equal(taskOf(env, done).state, "done");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: requeued });

  assert.equal(apply(env, "resolve_requeue", { id: requeued }).ok, true);
  assert.equal(board(env).queue.status, "running");
  const task = taskOf(env, requeued);
  assert.equal(task.state, "queued");
  assert.equal(task.session, null);
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 0 });
  assert.equal(taskOf(env, requeued).state, "queued");
});

test("the watcher sweeps once after start and once per burst of revisions, and stops", () => {
  const timers = [];
  const sweeps = [];
  let listener = null;
  let unsubscribed = 0;
  const watcher = createTaskStallWatcher({
    taskStore: { stallEndedTasks: (resolve) => { sweeps.push(resolve("s")); } },
    subscribe: (next) => { listener = next; return () => { unsubscribed += 1; }; },
    resolveSessionFacts: (id) => `facts:${id}`,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: (handle) => { timers[handle - 1] = null; },
  });
  assert.equal(timers.length, 1);
  listener({ domain: "sessions" });
  listener({ domain: "summary" });
  assert.equal(timers.length, 1);
  timers[0]();
  assert.deepEqual(sweeps, ["facts:s"]);
  listener({ domain: "sessions" });
  listener({ domain: "sessions" });
  assert.equal(timers.length, 2);
  timers[1]();
  assert.equal(sweeps.length, 2);

  listener({ domain: "sessions" });
  watcher.stop();
  assert.equal(timers[2], null);
  assert.equal(unsubscribed, 1);
  listener({ domain: "sessions" });
  watcher.sweep();
  assert.equal(timers.length, 3);
  assert.equal(sweeps.length, 2);
});

test("the watcher survives a store or a feed that throws", () => {
  const timers = [];
  const watcher = createTaskStallWatcher({
    taskStore: { stallEndedTasks: () => { throw new Error("store"); } },
    subscribe: () => { throw new Error("feed"); },
    resolveSessionFacts: () => null,
    setTimer: (run) => { timers.push(run); return timers.length; },
    clearTimer: () => {},
  });
  assert.doesNotThrow(() => timers[0]());
  assert.doesNotThrow(() => watcher.stop());
});

test("session facts say the Codex writer was released only from the primary agent's committed liveness", () => {
  const facts = (agents, sessions = []) => resolveTaskSessionFacts(OTHER_SESSION, {
    observationStore: { get: () => ({ publicState: { session: {}, agents } }) },
    catalogSessions: () => sessions,
  });
  assert.equal(facts([{ id: "primary", model: "m", liveness: { reason: "writer_released" } }]).writerReleased, true);
  assert.equal(facts([{ id: "primary", model: "m", liveness: { reason: "observation_gap" } }]).writerReleased, false);
  assert.equal(facts([{ id: "primary", model: "m", liveness: null }]).writerReleased, false);
  assert.equal(facts([{ id: "agent-2", liveness: { reason: "writer_released" } }]).writerReleased, false);
  const live = facts([{ id: "primary", liveness: { reason: "writer_released" } }], [{ id: OTHER_SESSION, activityStatus: "working" }]);
  assert.equal(sessionEnded(live), false);
  assert.equal(sessionEnded(facts([{ id: "primary", liveness: { reason: "writer_released" } }])), true);
});
