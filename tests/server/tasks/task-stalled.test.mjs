import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOwnerProbeCounters } from "../../../server/normalize/session-registry.mjs";
import { createClaudeRegistryObservation } from "../../../server/providers/claude/registry-observation.mjs";
import { resolveTaskSessionFacts } from "../../../server/runtime/task-session-lookup.mjs";
import { createEndConfirmation, createLiveConfirmation, createTaskStallWatcher, END_CONFIRM_DELAY_MS, sessionEnded, sessionLive } from "../../../server/tasks/task-stall.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { passingGates } from "./queue-test-support.mjs";

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
  const created = apply(env, "create", { text: "Fix the flaky test", completeWhen: { checks: [], own: null } });
  assert.equal(created.ok, true);
  return created.board.tasks.reduce((best, task) => (Number(task.id.slice(2)) > Number(best.slice(2)) ? task.id : best), "T-0");
}

/** Creates a task and links `session` to it the way a started session does. */
function startedTask(env, session = SESSION) {
  const id = createTask(env);
  const planned = env.store.planStart(REPOSITORY_ID, { id }, () => START_FACTS, passingGates);
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
  assert.equal(sessionEnded({ state: "stopped" }, "claude"), true);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: true }), true);
  for (const state of ["working", "needs_input", "idle", "open", "unknown", "ended", "", null, undefined]) {
    assert.equal(sessionEnded({ state, writerReleased: false }), false, String(state));
  }
  // A released writer does not outrank a state the catalog still shows.
  for (const state of ["working", "needs_input", "idle", "open"]) assert.equal(sessionEnded({ state, writerReleased: true }), false, state);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: "true" }), false);
  for (const facts of [null, undefined, "closed", 1]) assert.equal(sessionEnded(facts), false);
});

test("a Codex session that reads Stopped ended only when its writer was released; Claude Code and Closed are unchanged", () => {
  // A failed or interrupted Codex turn reads Stopped while its process can still report.
  assert.equal(sessionEnded({ state: "stopped", writerReleased: false }, "codex"), false);
  assert.equal(sessionEnded({ state: "stopped" }, "codex"), false);
  assert.equal(sessionEnded({ state: "stopped", writerReleased: "true" }, "codex"), false);
  assert.equal(sessionEnded({ state: "stopped", writerReleased: true }, "codex"), true);
  assert.equal(sessionEnded({ state: "closed", writerReleased: false }, "codex"), true);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: true }, "codex"), true);
  assert.equal(sessionEnded({ state: "unknown", writerReleased: false }, "codex"), false);
  for (const facts of [{ state: "stopped", writerReleased: false }, { state: "stopped" }, { state: "stopped", writerReleased: true }]) {
    assert.equal(sessionEnded(facts, "claude"), true, JSON.stringify(facts));
  }
  assert.equal(sessionEnded({ state: "closed" }, "claude"), true);
  assert.equal(sessionEnded({ state: "idle", writerReleased: true }, "codex"), false);
});

test("a Stopped state ends only a recognized provider's session; Closed ends any, Unknown needs a released writer", () => {
  for (const providerId of [null, undefined, "", "gemini", "CLAUDE", "Codex", 7]) {
    for (const facts of [{ state: "stopped", writerReleased: false }, { state: "stopped" }, { state: "stopped", writerReleased: true }]) {
      assert.equal(sessionEnded(facts, providerId), false, `${String(providerId)} ${JSON.stringify(facts)}`);
    }
    assert.equal(sessionEnded({ state: "closed" }, providerId), true, String(providerId));
    assert.equal(sessionEnded({ state: "unknown", writerReleased: true }, providerId), true, String(providerId));
    assert.equal(sessionEnded({ state: "unknown", writerReleased: false }, providerId), false, String(providerId));
  }
  assert.equal(sessionEnded({ state: "stopped", writerReleased: false }), false);
});

test("a stopped session of an unrecognized provider prefix leaves the task as it is", async (context) => {
  const env = await setup(context);
  const id = startedTask(env, "gemini:019a0000-2222-7333-8444-555566667777");
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "stopped", writerReleased: true })), { ok: true, stalled: 0, recovered: 0 });
  assert.equal(taskOf(env, id).state, "not_queued");
});

test("a linked task whose session closed with no report is stalled, and the decision is persisted", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  env.clock.now = 2_000_000;
  const seen = [];
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => { seen.push(sessionId); return CLOSED; }), { ok: true, stalled: 1, recovered: 0 });
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
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => facts[sessionId]), { ok: true, stalled: 2, recovered: 0 });
  assert.equal(taskOf(env, first).state, "stalled");
  assert.equal(taskOf(env, second).state, "stalled");
});

test("a Codex session that reads Stopped with its writer present leaves the task as it is, and its later report is accepted", async (context) => {
  const env = await setup(context);
  const id = startedTask(env, OTHER_SESSION);
  setQueue(env, "running");
  const present = { state: "stopped", writerReleased: false };
  assert.deepEqual(env.store.stallEndedTasks(() => present), { ok: true, stalled: 0, recovered: 0 });
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "stopped" })), { ok: true, stalled: 0, recovered: 0 });
  assert.equal(taskOf(env, id).state, "not_queued");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "running", blockedBy: null });
  // The turn failed, then the same process recovered and reported: the report is accepted.
  const reported = env.store.completeTask({ sessionId: OTHER_SESSION }, () => null);
  assert.equal(reported.ok, true);
  assert.equal(reported.state, "needs_review");
  assert.equal(taskOf(env, id).state, "needs_review");
});

test("a Codex session that reads Stopped with its writer released stalls the task once; Closed stalls it too", async (context) => {
  const env = await setup(context);
  const id = startedTask(env, OTHER_SESSION);
  setQueue(env, "running");
  const released = { state: "stopped", writerReleased: true };
  assert.deepEqual(env.store.stallEndedTasks(() => released), { ok: true, stalled: 1, recovered: 0 });
  assert.equal(taskOf(env, id).state, "stalled");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: id });
  assert.deepEqual(env.store.stallEndedTasks(() => released), { ok: true, stalled: 0, recovered: 0 });

  const closed = await setup(context);
  const closedId = startedTask(closed, OTHER_SESSION);
  assert.deepEqual(closed.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 1, recovered: 0 });
  assert.equal(taskOf(closed, closedId).state, "stalled");
});

test("a Claude Code session that reads Stopped stalls the task as before", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "stopped", writerReleased: false })), { ok: true, stalled: 1, recovered: 0 });
  assert.equal(taskOf(env, id).state, "stalled");
});

test("an idle, open, working, or unknown session never stalls a task", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  for (const state of ["idle", "open", "working", "needs_input", "unknown"]) {
    assert.deepEqual(env.store.stallEndedTasks(() => ({ state, writerReleased: false })), { ok: true, stalled: 0, recovered: 0 }, state);
  }
  assert.deepEqual(env.store.stallEndedTasks(() => null), { ok: true, stalled: 0, recovered: 0 });
  assert.deepEqual(env.store.stallEndedTasks(() => { throw new Error("no facts"); }), { ok: true, stalled: 0, recovered: 0 });
  assert.deepEqual(env.store.stallEndedTasks(null), { ok: true, stalled: 0, recovered: 0 });
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
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => { seen.push(sessionId); return CLOSED; }), { ok: true, stalled: 0, recovered: 0 });
  assert.deepEqual(seen, []);
  assert.equal(taskOf(env, unlinked).state, "not_queued");
  assert.equal(taskOf(env, reported).state, "needs_review");
  assert.equal(taskOf(env, blocked).state, "blocked");
});

test("only a working or needs-input reading counts as live", () => {
  for (const state of ["working", "needs_input"]) assert.equal(sessionLive({ state }), true, state);
  for (const state of ["idle", "open", "closed", "stopped", "unknown", "", null, undefined]) assert.equal(sessionLive({ state }), false, String(state));
  for (const facts of [null, undefined, "working", 1]) assert.equal(sessionLive(facts), false);
});

test("a stalled task stays stalled while its session reads idle, open, ended, unknown, or missing", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  env.store.stallEndedTasks(() => CLOSED);
  for (const facts of [{ state: "idle" }, { state: "open" }, CLOSED, { state: "stopped" }, { state: "unknown" }, null]) {
    assert.deepEqual(env.store.stallEndedTasks(() => facts), { ok: true, stalled: 0, recovered: 0 }, String(facts?.state));
  }
  assert.deepEqual(env.store.stallEndedTasks(() => { throw new Error("feed failed"); }), { ok: true, stalled: 0, recovered: 0 });
  assert.equal(taskOf(env, id).state, "stalled");
});

test("a stalled task whose own session works again leaves Stalled, keeps its link, and frees the queue", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  setQueue(env, "running");
  env.store.stallEndedTasks(() => CLOSED);
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: id });
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "needs_input" })), { ok: true, stalled: 0, recovered: 1 });
  const task = taskOf(env, id);
  assert.equal(task.state, "not_queued");
  assert.equal(task.report, null);
  assert.equal(task.session.id, SESSION);
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "running", blockedBy: null });
  // The stall rule watches it again: it stalls when the session ends once more, and its report is accepted until then.
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 1, recovered: 0 });
  assert.deepEqual(env.store.stallEndedTasks(() => ({ state: "working" })), { ok: true, stalled: 0, recovered: 1 });
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).state, "needs_review");
});

test("a recovered task releases the queue to the next task that still holds it", async (context) => {
  const env = await setup(context);
  const first = startedTask(env);
  const second = startedTask(env, OTHER_SESSION);
  setQueue(env, "running");
  env.store.stallEndedTasks(() => CLOSED);
  assert.equal(board(env).queue.blockedBy, first);
  const facts = (sessionId) => (sessionId === SESSION ? { state: "working" } : CLOSED);
  assert.deepEqual(env.store.stallEndedTasks(facts), { ok: true, stalled: 0, recovered: 1 });
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: second });
  for (const status of ["idle", "paused"]) {
    const other = await setup(context);
    const stalled = startedTask(other);
    other.store.stallEndedTasks(() => CLOSED);
    setQueue(other, status);
    other.store.stallEndedTasks(() => ({ state: "working" }));
    assert.equal(taskOf(other, stalled).state, "not_queued");
    assert.equal(board(other).queue.status, status, "recovery never turns a queue on");
  }
});

test("the session Pomegr started reports its stalled task: a completion frees the queue, a block keeps holding it", async (context) => {
  const env = await setup(context);
  const completed = startedTask(env);
  setQueue(env, "running");
  env.store.stallEndedTasks(() => CLOSED);
  assert.deepEqual(env.store.completeTask({ sessionId: SESSION }, () => null), { ok: true, state: "needs_review", results: [] });
  assert.equal(taskOf(env, completed).state, "needs_review");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "running", blockedBy: null });
  assert.deepEqual(env.store.blockTask({ sessionId: SESSION, reason: "New issue needs a decision" }), { ok: true, state: "blocked" });
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: completed });

  const other = await setup(context);
  const blocked = startedTask(other);
  setQueue(other, "running");
  other.store.stallEndedTasks(() => CLOSED);
  assert.deepEqual(other.store.blockTask({ sessionId: SESSION, reason: "Needs a decision" }), { ok: true, state: "blocked" });
  assert.equal(taskOf(other, blocked).state, "blocked");
  assert.deepEqual({ status: board(other).queue.status, blockedBy: board(other).queue.blockedBy }, { status: "blocked", blockedBy: blocked });
  // A reported task is not moved back by a live reading.
  assert.deepEqual(other.store.stallEndedTasks(() => ({ state: "working" })), { ok: true, stalled: 0, recovered: 0 });
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
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 2, recovered: 0 });
  assert.equal(board(env).queue.blockedBy, done);

  assert.equal(apply(env, "resolve_done", { id: done }).ok, true);
  assert.equal(taskOf(env, done).state, "done");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: requeued });

  assert.equal(apply(env, "resolve_requeue", { id: requeued }).ok, true);
  assert.equal(board(env).queue.status, "running");
  const task = taskOf(env, requeued);
  assert.equal(task.state, "queued");
  assert.equal(task.session, null);
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 0, recovered: 0 });
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

test("an end is confirmed only by a second ended reading after the delay, with no other reading between", () => {
  let clock = 0;
  const confirmation = createEndConfirmation({ delayMs: 100, now: () => clock });
  assert.equal(confirmation.dueIn(), null);
  assert.equal(confirmation.read("a", true), false);
  assert.equal(confirmation.dueIn(), 100);
  clock = 99;
  assert.equal(confirmation.read("a", true), false);
  assert.equal(confirmation.dueIn(), 1);
  assert.equal(confirmation.read("a", false), false);
  assert.equal(confirmation.dueIn(), null);
  clock = 150;
  assert.equal(confirmation.read("a", true), false, "the first reading was dropped");
  assert.equal(confirmation.read("b", true), false);
  clock = 250;
  confirmation.retain(["a"]);
  assert.equal(confirmation.read("a", true), true);
  assert.equal(confirmation.read("b", true), false, "a session no sweep read starts again");
  assert.equal(confirmation.read("a", true), false, "a confirmed end is not kept");
});

/** The watcher on the real store, with a clock and timers the test moves. */
function watched(env, resolveSessionFacts) {
  const timers = [];
  const clock = { now: 5_000 };
  const watcher = createTaskStallWatcher({
    taskStore: env.store, subscribe: () => () => {}, resolveSessionFacts, now: () => clock.now,
    setTimer: (run, delay) => { timers.push({ run, delay }); return timers.length; },
    clearTimer: (handle) => { timers[handle - 1] = null; },
  });
  return { watcher, clock, timers };
}

test("one closed reading that the next reading reverses leaves the task as it is, and its report is accepted", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  setQueue(env, "running");
  let facts = CLOSED;
  const { watcher, clock, timers } = watched(env, () => facts);
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "not_queued", "one closed reading stalls nothing");
  assert.equal(timers.at(-1).delay, END_CONFIRM_DELAY_MS + 50, "the second reading is scheduled");
  // The session reads live again before the second reading.
  facts = { state: "working", writerReleased: false };
  clock.now += 2_000;
  watcher.sweep();
  facts = CLOSED;
  clock.now += END_CONFIRM_DELAY_MS;
  timers.at(-1).run();
  assert.equal(taskOf(env, id).state, "not_queued", "a closed reading after a live one is a first reading again");
  facts = { state: "working", writerReleased: false };
  clock.now += END_CONFIRM_DELAY_MS;
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "not_queued");
  assert.equal(board(env).queue.status, "running");
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).ok, true);
  assert.equal(taskOf(env, id).state, "needs_review");
  watcher.stop();
});

test("an end that a second reading confirms after the delay stalls the task once", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  setQueue(env, "running");
  const { watcher, clock, timers } = watched(env, () => CLOSED);
  watcher.sweep();
  clock.now += END_CONFIRM_DELAY_MS - 1;
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "not_queued", "a second reading before the delay confirms nothing");
  assert.equal(timers.length, 2, "one start sweep and one confirming timer");
  clock.now += 1;
  timers.at(-1).run();
  assert.equal(taskOf(env, id).state, "stalled");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "blocked", blockedBy: id });
  assert.equal(timers.length, 2, "nothing waits for a second reading any more");
  watcher.stop();
});

test("a task that reports or is requeued between the two readings is not stalled", async (context) => {
  const env = await setup(context);
  const reported = startedTask(env);
  const requeued = startedTask(env, OTHER_SESSION);
  const { watcher, clock, timers } = watched(env, () => CLOSED);
  watcher.sweep();
  assert.equal(env.store.blockTask({ sessionId: SESSION, reason: "Needs a decision" }).ok, true);
  assert.equal(apply(env, "resolve_requeue", { id: requeued }).ok, true);
  clock.now += END_CONFIRM_DELAY_MS;
  timers.at(-1).run();
  assert.equal(taskOf(env, reported).state, "blocked");
  assert.equal(taskOf(env, requeued).state, "queued");
  assert.equal(timers.length, 2, "no reading waits for confirmation");
  watcher.stop();
});

async function claudeRegistry(context, readings) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-stalled-registry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const localId = SESSION.slice("claude:".length);
  await writeFile(path.join(root, "42.json"), JSON.stringify({ sessionId: localId, status: "busy", pid: 42, procStart: "owner-start" }));
  const counters = createOwnerProbeCounters();
  const observation = createClaudeRegistryObservation({
    root, counters,
    validateOwners: (entries) => new Map(entries.map((entry) => [entry.sessionId, readings.ownerIsCurrent])),
    ownerExists: () => readings.processExists,
  });
  // The catalog reading the stall sweep judges: Closed only for a session in the closed set.
  const facts = (sessionId) => {
    const { registry, closedSessionIds } = observation.read();
    const local = sessionId.slice("claude:".length);
    return { title: null, observedModel: null, writerReleased: false,
      state: closedSessionIds.has(local) ? "closed" : registry.has(local) ? "working" : "unknown" };
  };
  return { counters, facts };
}

test("one false reading that a live Claude Code process is gone does not stall its task", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  const readings = { ownerIsCurrent: true, processExists: true };
  const { counters, facts } = await claudeRegistry(context, readings);
  const { watcher, clock, timers } = watched(env, facts);
  watcher.sweep();
  readings.ownerIsCurrent = false;
  watcher.sweep();
  assert.equal(facts(SESSION).state, "closed", "the catalog shows the session closed for one reading");
  assert.equal(taskOf(env, id).state, "not_queued");
  readings.ownerIsCurrent = true;
  clock.now += END_CONFIRM_DELAY_MS;
  timers.at(-1).run();
  assert.equal(facts(SESSION).state, "working");
  assert.equal(taskOf(env, id).state, "not_queued");
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).ok, true);
  const counted = counters.snapshot();
  assert.deepEqual([counted.sessionsClosed, counted.sessionsReinstated], [1, 1], "the reversed reading is counted");
  watcher.stop();
});

test("a Claude Code process that stays gone stalls its task at the second reading", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  const readings = { ownerIsCurrent: true, processExists: true };
  const { counters, facts } = await claudeRegistry(context, readings);
  const { watcher, clock, timers } = watched(env, facts);
  watcher.sweep();
  readings.ownerIsCurrent = false;
  readings.processExists = false;
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "not_queued");
  clock.now += END_CONFIRM_DELAY_MS;
  timers.at(-1).run();
  assert.equal(taskOf(env, id).state, "stalled");
  assert.equal(counters.snapshot().sessionsReinstated, 0);
  watcher.stop();
});

test("a live reading is confirmed only by an open reading after the delay, with no ended or unknown reading between", () => {
  const clock = { now: 0 };
  const confirmation = createLiveConfirmation({ delayMs: 1000, now: () => clock.now });
  const working = { state: "working" };
  assert.equal(confirmation.dueIn(), null);
  assert.equal(confirmation.read("s", { state: "idle" }), false, "an idle reading starts no wait");
  assert.equal(confirmation.dueIn(), null);
  assert.equal(confirmation.read("s", working), false, "the first live reading only starts the wait");
  assert.equal(confirmation.dueIn(), 1000);
  clock.now = 999;
  assert.equal(confirmation.read("s", { state: "idle" }), false, "too early");
  clock.now = 1000;
  assert.equal(confirmation.read("s", { state: "idle" }), true, "an open reading after the delay confirms");
  assert.equal(confirmation.dueIn(), null);
  for (const between of [CLOSED, { state: "unknown" }, null]) {
    clock.now = 0;
    confirmation.read("s", working);
    clock.now = 500;
    assert.equal(confirmation.read("s", between), false);
    clock.now = 1500;
    assert.equal(confirmation.read("s", working), false, `${String(between?.state)} between drops the first live reading`);
    clock.now = 2500;
    assert.equal(confirmation.read("s", working), true);
  }
  confirmation.read("s", working);
  confirmation.retain([]);
  assert.equal(confirmation.dueIn(), null, "a session the sweep did not read is forgotten");
});

test("the watcher moves a stalled task back only when a later reading confirms the session works again", async (context) => {
  const env = await setup(context);
  const id = startedTask(env);
  setQueue(env, "running");
  env.store.stallEndedTasks(() => CLOSED);
  let facts = { state: "working", writerReleased: false };
  const { watcher, clock, timers } = watched(env, () => facts);
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "stalled", "one live reading moves nothing");
  assert.equal(timers.at(-1).delay, END_CONFIRM_DELAY_MS + 50, "the confirming reading is scheduled");
  // The session reads closed again before the confirming reading: the wait starts over.
  facts = CLOSED;
  clock.now += 2_000;
  watcher.sweep();
  facts = { state: "working", writerReleased: false };
  clock.now += END_CONFIRM_DELAY_MS;
  watcher.sweep();
  assert.equal(taskOf(env, id).state, "stalled", "a live reading after a closed one is a first reading again");
  // The turn finished before the confirming reading: Idle is open, so it confirms.
  facts = { state: "idle", writerReleased: false };
  clock.now += END_CONFIRM_DELAY_MS;
  timers.at(-1).run();
  assert.equal(taskOf(env, id).state, "not_queued");
  assert.deepEqual({ status: board(env).queue.status, blockedBy: board(env).queue.blockedBy }, { status: "running", blockedBy: null });
  watcher.stop();
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
