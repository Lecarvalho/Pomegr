import assert from "node:assert/strict";
import test from "node:test";
import { TASK_SCHEDULE_HORIZON_MS as CONTRACT_HORIZON_MS } from "../../../shared/task-contract.ts";
import { projectSchedule } from "../../../server/serving/task-routes.mjs";
import { nextQueueStart, orderQueue, queueWindowHold, taskIsDue } from "../../../server/tasks/task-queue.mjs";
import { TASK_SCHEDULE_HORIZON_MS, normalizeQueueAddPayload, normalizeQueueSchedule } from "../../../server/tasks/task-record.mjs";
import {
  FACTS, REPOSITORY, SESSION, createTask, metaValue, openTemporaryStore, passingGates, queueRow, queueSettings, queueTask, setMeta,
  startedTask, updateTask, withDatabase,
} from "./queue-test-support.mjs";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (time) => new Date(time).toISOString();
const start = (taskId, repositoryId = REPOSITORY) => ({ repositoryId, taskId });
const starts = (store) => store.nextQueueStarts({ resolveGateFacts: passingGates });
const schedule = (store, startAt, stopAfter) => store.apply(REPOSITORY, "queue_settings", { schedule: { startAt, stopAfter } });
const scheduleTask = (store, id, at) => store.apply(REPOSITORY, "queue_add", { id, at });
const taskOf = (board, id) => board.tasks.find((task) => task.id === id);
const storedTasks = (directory) => withDatabase(directory, (database) =>
  database.prepare("SELECT number, state, position, scheduled_at, queue_position, session_id, dispatch_token, updated_at FROM tasks ORDER BY number").all().map((row) => ({ ...row })));

test("a scheduled task is due from its own time on, and one with no time has nothing to wait for", () => {
  assert.equal(taskIsDue(1000, 999), false);
  assert.equal(taskIsDue(1000, 1000), true);
  assert.equal(taskIsDue(1000, 5000), true);
  assert.equal(taskIsDue(null, 0), true);
  for (const junk of ["1000", 1.5, NaN, {}]) assert.equal(taskIsDue(junk, 5000), false, String(junk));
  assert.equal(taskIsDue(1000, NaN), false);
});

test("a queue starts nothing before its start time or from its stop time on", () => {
  assert.equal(queueWindowHold({ startAt: null, stopAfter: null }, 500), null);
  assert.equal(queueWindowHold({ startAt: 1000, stopAfter: null }, 999), "before_queue_start");
  assert.equal(queueWindowHold({ startAt: 1000, stopAfter: null }, 1000), null);
  assert.equal(queueWindowHold({ startAt: null, stopAfter: 2000 }, 1999), null);
  assert.equal(queueWindowHold({ startAt: null, stopAfter: 2000 }, 2000), "after_queue_stop");
  assert.equal(queueWindowHold({ startAt: 1000, stopAfter: 2000 }, 1500), null);
  // A start time missed while nothing was asking counts only while the stop time has not come.
  assert.equal(queueWindowHold({ startAt: 1000, stopAfter: 2000 }, 9000), "after_queue_stop");
  // Settings that are not times are not set; an unknown clock starts nothing on a scheduled queue.
  assert.equal(queueWindowHold({ startAt: "1000", stopAfter: 1.5 }, 0), null);
  assert.equal(queueWindowHold(null, 0), null);
  assert.equal(queueWindowHold({ startAt: 1000, stopAfter: null }, NaN), "after_queue_stop");
  assert.equal(queueWindowHold({}, NaN), null);
});

test("a scheduled task is in the order only once it is due, and one that is not due lets the tasks behind it start", () => {
  const tasks = [
    { id: "T-1", featureId: null, step: null, state: "scheduled", queuePosition: 0, due: false },
    { id: "T-2", featureId: null, step: null, state: "queued", queuePosition: 1 },
    { id: "T-3", featureId: null, step: null, state: "scheduled", queuePosition: 2, due: true },
  ];
  assert.deepEqual(orderQueue(tasks, []).order, ["T-2", "T-3"]);
  assert.deepEqual(nextQueueStart({ status: "running", tasks, features: [] }), { starts: ["T-2"] });
  const due = tasks.map((task) => ({ ...task, due: task.state === "scheduled" }));
  assert.deepEqual(orderQueue(due, []).order, ["T-1", "T-2", "T-3"]);
  assert.deepEqual(nextQueueStart({ status: "running", tasks: due, features: [] }), { starts: ["T-1"] });
});

test("a scheduled task that is not due keeps its feature step open: the rest of the step starts, the next step waits", () => {
  const features = [{ id: "f" }];
  const tasks = [
    { id: "T-1", featureId: "f", step: 1, state: "scheduled", queuePosition: 0, due: false },
    { id: "T-2", featureId: "f", step: 1, state: "queued", queuePosition: 1 },
    { id: "T-3", featureId: "f", step: 2, state: "queued", queuePosition: 2 },
  ];
  assert.deepEqual(nextQueueStart({ status: "running", tasks, features }), { starts: ["T-2"] });
  const later = tasks.map((task) => (task.id === "T-2" ? { ...task, state: "done" } : task));
  assert.equal(nextQueueStart({ status: "running", tasks: later, features }), null, "step 1 is not done while T-1 waits for its time");
  const due = later.map((task) => (task.id === "T-1" ? { ...task, due: true } : task));
  assert.deepEqual(nextQueueStart({ status: "running", tasks: due, features }), { starts: ["T-1"] });
});

test("the horizon matches the contract, and a start time is an instant inside it, not behind the clock", () => {
  assert.equal(TASK_SCHEDULE_HORIZON_MS, CONTRACT_HORIZON_MS);
  const now = Date.UTC(2026, 9, 8, 12);
  assert.deepEqual(normalizeQueueAddPayload({ id: "T-1" }, now), { number: 1, at: null });
  assert.deepEqual(normalizeQueueAddPayload({ id: "T-1", at: null }, now), { number: 1, at: null });
  assert.deepEqual(normalizeQueueAddPayload({ id: "T-7", at: iso(now + HOUR) }, now), { number: 7, at: now + HOUR });
  assert.deepEqual(normalizeQueueAddPayload({ id: "T-7", at: iso(now - 30_000) }, now), { number: 7, at: now - 30_000 }, "a time just set is not behind the clock");
  assert.deepEqual(normalizeQueueAddPayload({ id: "T-7", at: iso(now + TASK_SCHEDULE_HORIZON_MS) }, now), { number: 7, at: now + TASK_SCHEDULE_HORIZON_MS });
  for (const at of [
    iso(now - 2 * MINUTE), iso(now + TASK_SCHEDULE_HORIZON_MS + 1), "2026-10-09T02:00:00Z", "2026-10-09T02:00:00.000+02:00", "2026-10-09 02:00", "02:00",
    "2026-13-09T02:00:00.000Z", now + HOUR, "", "C:\\repo", {}, [], true,
  ]) assert.equal(normalizeQueueAddPayload({ id: "T-1", at }, now), undefined, String(at));
  assert.equal(normalizeQueueAddPayload({ id: "T-1", at: iso(now + HOUR), extra: 1 }, now), undefined);
  assert.equal(normalizeQueueAddPayload({ id: "T-0", at: iso(now + HOUR) }, now), undefined);
});

test("a queue schedule is exactly two instants or nulls, the stop after the start, and a stored time may stay", () => {
  const now = Date.UTC(2026, 9, 8, 12);
  const none = { startAt: null, stopAfter: null };
  assert.deepEqual(normalizeQueueSchedule(none, none, now), none);
  assert.deepEqual(normalizeQueueSchedule({ startAt: iso(now + HOUR), stopAfter: iso(now + 5 * HOUR) }, none, now), { startAt: now + HOUR, stopAfter: now + 5 * HOUR });
  assert.deepEqual(normalizeQueueSchedule({ startAt: null, stopAfter: iso(now + HOUR) }, none, now), { startAt: null, stopAfter: now + HOUR });
  // A start time that has passed is kept as stored while the stop time is edited; a new one behind the clock is refused.
  const stored = { startAt: now - 3 * HOUR, stopAfter: null };
  assert.deepEqual(normalizeQueueSchedule({ startAt: iso(now - 3 * HOUR), stopAfter: iso(now + HOUR) }, stored, now), { startAt: now - 3 * HOUR, stopAfter: now + HOUR });
  assert.equal(normalizeQueueSchedule({ startAt: iso(now - 3 * HOUR), stopAfter: null }, none, now), undefined);
  for (const value of [
    { startAt: iso(now + 2 * HOUR), stopAfter: iso(now + HOUR) }, { startAt: iso(now + HOUR), stopAfter: iso(now + HOUR) },
    { startAt: null }, { stopAfter: null }, { startAt: null, stopAfter: null, on: true }, { startAt: "02:00", stopAfter: null },
    { startAt: null, stopAfter: now + HOUR }, { startAt: null, stopAfter: iso(now + TASK_SCHEDULE_HORIZON_MS + 1) }, null, [], "soon",
  ]) assert.equal(normalizeQueueSchedule(value, none, now), undefined, JSON.stringify(value));
});

test("queue_add with a time schedules a task in the place it had or at the end, and without one takes the time off", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  for (let index = 0; index < 3; index += 1) createTask(store);
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  const at = clock.now + HOUR;

  const scheduled = scheduleTask(store, "T-1", iso(at));
  assert.equal(scheduled.ok, true);
  assert.equal(taskOf(scheduled.board, "T-1").state, "scheduled");
  assert.equal(taskOf(scheduled.board, "T-1").scheduledAt, iso(at));
  assert.deepEqual(scheduled.board.queue.order, ["T-2"], "not due: not in the order");
  // A task that was not queued joins at the end; a scheduled one can be given another time.
  assert.equal(scheduleTask(store, "T-3", iso(at)).ok, true);
  assert.equal(scheduleTask(store, "T-3", iso(at + HOUR)).ok, true);
  assert.deepEqual(storedTasks(directory).map((row) => [row.state, row.scheduled_at, row.position]), [["scheduled", at, 0], ["queued", null, 1], ["scheduled", at + HOUR, 2]]);

  // Without a time a scheduled task is queued again where it was.
  const cleared = store.apply(REPOSITORY, "queue_add", { id: "T-1" });
  assert.equal(taskOf(cleared.board, "T-1").state, "queued");
  assert.equal(taskOf(cleared.board, "T-1").scheduledAt, null);
  assert.deepEqual(cleared.board.queue.order, ["T-1", "T-2"]);
  // Remove from queue takes the time with it.
  const removed = store.apply(REPOSITORY, "queue_remove", { id: "T-3" });
  assert.equal(taskOf(removed.board, "T-3").state, "not_queued");
  assert.deepEqual(storedTasks(directory)[2].scheduled_at, null);
  assert.deepEqual(storedTasks(directory)[2].queue_position, null);
  assert.equal(queueRow(directory).queue_status, "idle", "scheduling never turns the queue on");
});

test("queue_add refuses a time that is not settable, a task with an outcome, and a task that already has a session", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  for (let index = 0; index < 6; index += 1) createTask(store);
  const at = iso(clock.now + HOUR);
  ["needs_review", "stalled", "blocked", "done"].forEach((state, index) => updateTask(directory, index + 1, { state }));
  startedTask(directory, 5, { session: SESSION });
  const before = storedTasks(directory);
  for (const id of ["T-1", "T-2", "T-3", "T-4", "T-5"]) assert.deepEqual(scheduleTask(store, id, at), { ok: false, error: "conflict" }, id);
  assert.deepEqual(scheduleTask(store, "T-9", at), { ok: false, error: "not_found" });
  for (const bad of [iso(clock.now - HOUR), iso(clock.now + TASK_SCHEDULE_HORIZON_MS + MINUTE), "tomorrow", 5]) {
    assert.deepEqual(scheduleTask(store, "T-6", bad), { ok: false, error: "invalid" }, String(bad));
  }
  assert.deepEqual(storedTasks(directory), before);
});

test("the queue does not start a scheduled task before its time, starts the tasks behind it, and starts it once the time has come", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  assert.equal(scheduleTask(store, "T-1", iso(clock.now + HOUR)).ok, true);
  queueTask(store, "T-2");
  assert.equal(queueSettings(store, true).ok, true);
  const before = storedTasks(directory);

  assert.deepEqual(starts(store), { ok: true, starts: [start("T-2")] });
  clock.now += HOUR - 1;
  assert.deepEqual(starts(store), { ok: true, starts: [start("T-2")] }, "one millisecond early");
  assert.deepEqual(storedTasks(directory), before, "asking writes nothing");
  // T-2 ran and finished; the scheduled task is alone and still waits for its time.
  updateTask(directory, 2, { state: "done", queue_position: null });
  assert.deepEqual(starts(store), { ok: true, starts: [] });
  assert.equal(store.readBoard(REPOSITORY).queue.status, "running", "a waiting task holds nothing and pauses nothing");
  clock.now += 1;
  assert.deepEqual(starts(store), { ok: true, starts: [start("T-1")] });
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-1"]);
  assert.equal(taskOf(store.readBoard(REPOSITORY), "T-1").state, "scheduled", "a due task keeps its state and its time");
});

test("a time missed while Pomegr was closed starts at the next question, and only inside the queue's window", async (context) => {
  const { store, clock } = await openTemporaryStore(context);
  createTask(store);
  assert.equal(scheduleTask(store, "T-1", iso(clock.now + HOUR)).ok, true);
  assert.equal(schedule(store, null, iso(clock.now + 6 * HOUR)).ok, true);
  assert.equal(queueSettings(store, true).ok, true);
  // Nothing asked for three hours: the time passed, the stop time has not.
  clock.now += 4 * HOUR;
  assert.deepEqual(starts(store), { ok: true, starts: [start("T-1")] });
  // Nothing asked until after the stop time: the missed start does not happen.
  clock.now += 3 * HOUR;
  assert.deepEqual(starts(store), { ok: true, starts: [] });
  assert.equal(store.readBoard(REPOSITORY).queue.status, "running");
});

test("a queue with a start time starts nothing before it, and one with a stop time nothing from it on", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  const startAt = clock.now + 2 * HOUR;
  const stopAfter = clock.now + 7 * HOUR;
  const set = schedule(store, iso(startAt), iso(stopAfter));
  assert.equal(set.ok, true);
  assert.deepEqual(set.board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: ["T-1", "T-2"], schedule: { startAt: iso(startAt), stopAfter: iso(stopAfter) } });
  assert.equal(metaValue(directory, `queue_start_at:${REPOSITORY}`), String(startAt));
  assert.equal(metaValue(directory, `queue_stop_after:${REPOSITORY}`), String(stopAfter));
  assert.equal(queueSettings(store, true).ok, true);

  assert.deepEqual(starts(store), { ok: true, starts: [] }, "before the start time");
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.next, { taskId: "T-1", provider: "claude", blockedBy: null, reasons: ["before_queue_start"] });
  clock.now = startAt;
  assert.deepEqual(starts(store), { ok: true, starts: [start("T-1")] });
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.gates.next.reasons, []);

  // T-1 runs past the stop time: its session is never touched, and nothing new starts.
  startedTask(directory, 1, { session: SESSION });
  clock.now = stopAfter;
  const before = storedTasks(directory);
  assert.deepEqual(starts(store), { ok: true, starts: [] });
  updateTask(directory, 1, { state: "done", queue_position: null });
  assert.deepEqual(starts(store), { ok: true, starts: [] }, "from the stop time on");
  assert.deepEqual(storedTasks(directory).find((row) => row.number === 1).session_id, before.find((row) => row.number === 1).session_id);
  const board = store.readBoard(REPOSITORY, { resolveGateFacts: passingGates });
  assert.deepEqual(board.queue.gates.next, { taskId: "T-2", provider: "claude", blockedBy: null, reasons: ["after_queue_stop"] });
  assert.equal(board.queue.status, "running", "the stop time holds starts; it does not turn the queue off or pause it");
  assert.equal(taskOf(board, "T-2").state, "queued");

  // Clearing the stop time lets the queue start again.
  assert.equal(schedule(store, iso(startAt), null).ok, true, "the stored start time may stay although it has passed");
  assert.equal(metaValue(directory, `queue_stop_after:${REPOSITORY}`), null);
  assert.deepEqual(starts(store), { ok: true, starts: [start("T-2")] });
});

test("the schedule setting changes nothing else, refuses what is not a schedule, and a damaged stored time reads as not set", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  assert.equal(queueSettings(store, true).ok, true);
  const tasks = storedTasks(directory);
  for (const bad of [{ startAt: iso(clock.now - HOUR), stopAfter: null }, { startAt: iso(clock.now + 2 * HOUR), stopAfter: iso(clock.now + HOUR) }, { startAt: null }, "02:00", null]) {
    assert.deepEqual(store.apply(REPOSITORY, "queue_settings", { schedule: bad }), { ok: false, error: "invalid" }, JSON.stringify(bad));
  }
  assert.deepEqual(store.apply(REPOSITORY, "queue_settings", { schedule: { startAt: null, stopAfter: null }, on: true }), { ok: false, error: "invalid" });
  assert.equal(schedule(store, null, iso(clock.now + HOUR)).ok, true);
  assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
  assert.deepEqual(storedTasks(directory), tasks);
  // Turning the queue off and on keeps the schedule.
  queueSettings(store, false);
  assert.deepEqual(queueSettings(store, true).board.queue.schedule, { startAt: null, stopAfter: iso(clock.now + HOUR) });
  // Both cleared: the board carries no schedule.
  assert.equal(Object.hasOwn(schedule(store, null, null).board.queue, "schedule"), false);
  for (const junk of ["soon", "-5", "1.5", ""]) {
    setMeta(directory, `queue_stop_after:${REPOSITORY}`, junk);
    assert.equal(Object.hasOwn(store.readBoard(REPOSITORY).queue, "schedule"), false, junk);
    assert.deepEqual(starts(store), { ok: true, starts: [start("T-1")] }, junk);
  }
});

test("a start by hand is held before the task's own time and never by the queue's schedule", async (context) => {
  const { store, clock } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  assert.equal(scheduleTask(store, "T-1", iso(clock.now + HOUR)).ok, true);
  assert.equal(schedule(store, iso(clock.now + 2 * HOUR), iso(clock.now + 3 * HOUR)).ok, true);
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates), { ok: false, error: "gate_held" });
  // T-2 has no time of its own: the queue's start time does not hold the user's own start.
  assert.equal(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates).ok, true);
  clock.now += HOUR;
  assert.equal(store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates).ok, true);
});

test("requeueing a task that ran on a schedule clears its time", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  assert.equal(scheduleTask(store, "T-1", iso(clock.now + HOUR)).ok, true);
  updateTask(directory, 1, { state: "stalled", session_id: SESSION });
  const requeued = store.apply(REPOSITORY, "resolve_requeue", { id: "T-1" });
  assert.equal(requeued.ok, true);
  assert.equal(taskOf(requeued.board, "T-1").state, "queued");
  assert.equal(taskOf(requeued.board, "T-1").scheduledAt, null);
});

test("the route serves a schedule only as two instants or nulls", () => {
  const valid = { startAt: "2026-10-09T02:00:00.000Z", stopAfter: null };
  assert.deepEqual(projectSchedule({ ...valid, root: "C:\\repo" }), valid);
  assert.deepEqual(projectSchedule({ startAt: null, stopAfter: "2026-10-09T07:00:00.000Z" }), { startAt: null, stopAfter: "2026-10-09T07:00:00.000Z" });
  for (const broken of [undefined, null, [], { startAt: null, stopAfter: null }, { startAt: "02:00", stopAfter: null }, { startAt: 5, stopAfter: null },
    { startAt: "2026-10-09T02:00:00.000Z" }, { startAt: "2026-10-09T02:00:00.000Z", stopAfter: "C:\\repo" }, { startAt: "2026-99-09T02:00:00.000Z", stopAfter: null }]) {
    assert.equal(projectSchedule(broken), undefined, JSON.stringify(broken));
  }
});
