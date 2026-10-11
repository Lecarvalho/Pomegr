import assert from "node:assert/strict";
import test from "node:test";
import { nextQueueStart, orderQueue, previousStepBlocker, queueWhenTurnedOn } from "../../../server/tasks/task-queue.mjs";

// A queue record as the store hands it to the rule.
const task = (number, overrides = {}) => ({
  id: `T-${number}`, featureId: null, state: "queued", queuePosition: number, inFlight: false, unlinked: false, ...overrides,
});
const features = [{ id: "feat-aaaaaaaaaaaa" }, { id: "feat-bbbbbbbbbbbb" }];
const FEATURE = features[0].id;
const OTHER_FEATURE = features[1].id;
const next = (tasks, status = "running", list = features) => nextQueueStart({ status, tasks, features: list });

test("queueWhenTurnedOn runs unless a task is stalled or blocked, then blocks at the lowest-numbered one", () => {
  assert.deepEqual(queueWhenTurnedOn([]), { status: "running", blockedBy: null });
  assert.deepEqual(queueWhenTurnedOn([task(1), task(2, { state: "done" }), task(3, { state: "not_queued" }), task(4, { state: "scheduled" })]), { status: "running", blockedBy: null });
  // A task in review is finished work that waits for the owner: it never holds the queue.
  assert.deepEqual(queueWhenTurnedOn([task(1), task(7, { state: "needs_review" })]), { status: "running", blockedBy: null });
  for (const state of ["stalled", "blocked"]) {
    assert.deepEqual(queueWhenTurnedOn([task(1), task(7, { state })]), { status: "blocked", blockedBy: "T-7" }, state);
  }
  // Numeric, not textual: T-2 sorts before T-10, whatever the list order.
  assert.deepEqual(queueWhenTurnedOn([task(10, { state: "blocked" }), task(2, { state: "stalled" }), task(1, { state: "needs_review" })]), { status: "blocked", blockedBy: "T-2" });
});

test("queueWhenTurnedOn never throws and ignores records it cannot place", () => {
  for (const value of [undefined, null, "T-1", 7, {}, [null, undefined, 3, "x", [], { state: "stalled" }, { id: "T-0", state: "stalled" }, { id: "t-1", state: "stalled" }, { id: 4, state: "stalled" }]]) {
    assert.deepEqual(queueWhenTurnedOn(value), { status: "running", blockedBy: null }, JSON.stringify(value));
  }
  assert.deepEqual(queueWhenTurnedOn([{ id: "nonsense", state: "blocked" }, { id: "T-9", state: "blocked" }]), { status: "blocked", blockedBy: "T-9" });
});

test("a queue that is not running starts and pauses nothing", () => {
  const tasks = [task(1), task(2, { unlinked: true })];
  for (const status of ["idle", "blocked", "paused", "unknown", "", undefined, null, 1]) assert.equal(nextQueueStart({ status, tasks, features }), null, String(status));
  assert.equal(next(tasks, "running") !== null, true);
  for (const input of [undefined, null, "running", 7, [], {}]) assert.equal(nextQueueStart(input), null, JSON.stringify(input));
});

test("a running queue with nothing queued has nothing to do", () => {
  assert.equal(next([]), null);
  assert.equal(next([task(1, { state: "not_queued", queuePosition: null }), task(2, { state: "done" }), task(3, { state: "scheduled" })]), null);
  assert.equal(nextQueueStart({ status: "running" }), null);
  assert.equal(nextQueueStart({ status: "running", tasks: "T-1", features: 7 }), null);
});

test("the first queued task starts, in the order the board marks as next", () => {
  assert.deepEqual(next([task(1, { queuePosition: 5 }), task(2, { queuePosition: 1 })]), { starts: ["T-2"] });
  assert.deepEqual(next([task(4, { queuePosition: null }), task(3, { queuePosition: 9 })]), { starts: ["T-3"] });
});

test("the start is the first task of orderQueue, for features and tasks without a feature alike", () => {
  const tasks = [
    task(1, { queuePosition: 0 }),
    task(2, { featureId: OTHER_FEATURE, queuePosition: 1 }),
    task(3, { featureId: FEATURE, state: "done", queuePosition: null }),
    task(4, { featureId: FEATURE, queuePosition: 2 }),
    task(5, { featureId: FEATURE, queuePosition: 3 }),
    task(6, { queuePosition: 4 }),
  ];
  assert.deepEqual(orderQueue(tasks, features).order, ["T-4", "T-5", "T-2", "T-1", "T-6"]);
  assert.equal(next(tasks).starts[0], orderQueue(tasks, features).order[0]);
  // A feature's tasks start one at a time, never together.
  assert.deepEqual(next(tasks), { starts: ["T-4"] });
  // Removing the first from the queue moves the start with it.
  assert.deepEqual(next(tasks.map((entry) => (entry.id === "T-4" ? { ...entry, state: "not_queued", queuePosition: null } : entry))), { starts: ["T-5"] });
});

test("one task at a time: a task in flight holds the queue, whatever its state", () => {
  for (const state of ["not_queued", "queued", "scheduled", "done"]) {
    assert.equal(next([task(1), task(2, { state, inFlight: true })]), null, state);
  }
  assert.equal(next([task(1, { inFlight: true })]), null);
  assert.deepEqual(next([task(1), task(2, { inFlight: false })]), { starts: ["T-1"] });
  // Only a literal true counts as in flight; the store supplies booleans.
  assert.deepEqual(next([task(1), task(2, { inFlight: "yes" })]), { starts: ["T-1"] });
});

test("a candidate whose start expired with no session pauses the queue instead of starting again", () => {
  assert.deepEqual(next([task(1, { unlinked: true }), task(2)]), { pause: "T-1" });
  // Only the candidate is judged: an unlinked task further down the order is not the queue's concern yet.
  assert.deepEqual(next([task(1), task(2, { unlinked: true })]), { starts: ["T-1"] });
  // A task that is in flight wins over any pause: the queue is simply waiting.
  assert.equal(next([task(1, { unlinked: true }), task(2, { inFlight: true })]), null);
  // An unlinked task that is not queued is not a candidate.
  assert.equal(next([task(1, { state: "not_queued", unlinked: true })]), null);
});

test("a candidate waits for the task before it in its feature and never skips ahead to a later task", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  assert.deepEqual(next([card(1), card(2)]), { starts: ["T-1"] });
  assert.deepEqual(next([card(1, { state: "done" }), card(2)]), { starts: ["T-2"] });
  // The task before it started and is not settled: stalled, blocked, or linked to a session.
  for (const state of ["stalled", "blocked"]) {
    assert.equal(next([card(1, { state }), card(2)]), null, state);
  }
  assert.equal(next([card(1, { linked: true, state: "not_queued", queuePosition: null }), card(2)]), null);
  // A task in review is finished work: the next one starts.
  assert.deepEqual(next([card(1, { state: "needs_review" }), card(2)]), { starts: ["T-2"] });
  // The queue waits; a queued task without a feature further down does not jump the line.
  assert.equal(next([card(1, { state: "stalled" }), card(2), task(3)]), null);
  // A task of the feature that has not started never holds a later card.
  assert.deepEqual(next([card(1, { state: "not_queued", queuePosition: null }), card(2)]), { starts: ["T-2"] });
});

test("a scheduled task that is not due holds the rest of its feature, and the queue waits when that feature is first", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  const tasks = [card(1, { state: "scheduled", due: false }), card(2), task(3, { featureId: OTHER_FEATURE }), task(4)];
  assert.deepEqual(orderQueue(tasks, features).order, ["T-2", "T-3", "T-4"]);
  assert.equal(next(tasks), null);
  // With the other feature first, or with no feature, the queue goes on.
  assert.deepEqual(next(tasks, "running", [features[1], features[0]]), { starts: ["T-3"] });
  assert.deepEqual(next(tasks.filter((entry) => entry.featureId === null)), { starts: ["T-4"] });
});

test("another feature's tasks do not hold a candidate", () => {
  const tasks = [
    task(1, { featureId: OTHER_FEATURE, state: "stalled" }),
    task(2, { featureId: FEATURE }),
  ];
  assert.deepEqual(next(tasks), { starts: ["T-2"] });
  assert.deepEqual(next(tasks, "running", [features[1], features[0]]), { starts: ["T-2"] });
});

test("an unlinked candidate pauses before the previous-task rule is consulted", () => {
  const tasks = [task(1, { featureId: FEATURE, state: "stalled" }), task(2, { featureId: FEATURE, unlinked: true })];
  assert.deepEqual(next(tasks), { pause: "T-2" });
});

test("a task that names no listed feature is a task without a feature", () => {
  assert.deepEqual(next([task(1, { featureId: "feat-cccccccccccc" })]), { starts: ["T-1"] });
});

test("records the rule cannot place are ignored and never throw", () => {
  const garbage = [null, undefined, "T-1", 7, [], {}, { id: "nope", state: "queued" }, { id: "T-0", state: "queued" }, { id: 3, state: "queued" }];
  assert.equal(next(garbage), null);
  assert.deepEqual(next([...garbage, task(2)]), { starts: ["T-2"] });
  // A repeated ID counts once, as in orderQueue: the first record wins.
  assert.deepEqual(next([task(1, { unlinked: true }), task(1, { unlinked: false })]), { pause: "T-1" });
  assert.deepEqual(nextQueueStart({ status: "running", tasks: [task(1)], features: [null, "x", { id: "" }, { id: 3 }] }), { starts: ["T-1"] });
});

test("the rule leaves its input alone", () => {
  const tasks = [task(1, { featureId: FEATURE }), task(2, { unlinked: true })];
  const snapshot = JSON.stringify({ tasks, features });
  next(tasks);
  assert.equal(JSON.stringify({ tasks, features }), snapshot);
});

test("exactly one task starts, by card place inside a feature", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  assert.deepEqual(next([card(3, { queuePosition: 0 }), card(1, { queuePosition: 2 }), card(2, { queuePosition: 1 }), task(5)]), { starts: ["T-3"] });
  // Tasks without a feature start one at a time.
  assert.deepEqual(next([task(1), task(2)]), { starts: ["T-1"] });
});

test("any task in flight holds the queue, in the same feature, another feature, or none", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  assert.equal(next([card(1, { inFlight: true }), card(2), task(3)]), null);
  assert.equal(next([task(1, { featureId: OTHER_FEATURE, inFlight: true }), card(2)]), null);
  assert.equal(next([task(1, { inFlight: true }), card(2), card(3)]), null);
});

test("an unlinked first task of a feature pauses the queue at it", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  assert.deepEqual(next([card(1), card(2, { unlinked: true })]), { starts: ["T-1"] });
  assert.deepEqual(next([card(1, { unlinked: true }), card(2)]), { pause: "T-1" });
});

test("previousStepBlocker names the unsettled task a waiting task waits on", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  // No feature: nothing to wait on.
  assert.equal(previousStepBlocker("T-1", [task(1), task(2, { state: "stalled" })]), null);
  assert.equal(previousStepBlocker("T-9", [card(1)]), null);
  // A started task blocks (lowest number first), settled ones do not.
  assert.equal(previousStepBlocker("T-5", [card(5), card(4, { inFlight: true }), card(3, { state: "blocked" })]), "T-3");
  assert.equal(previousStepBlocker("T-5", [card(5), card(2, { linked: true }), card(3, { state: "stalled" })]), "T-2");
  assert.equal(previousStepBlocker("T-5", [card(5), card(1, { state: "done" }), card(2, { state: "needs_review" })]), null);
  // A waiting task blocks only from a lower place; the lowest place is named.
  assert.equal(previousStepBlocker("T-5", [card(5, { queuePosition: 4 }), card(6, { queuePosition: 2 }), card(7, { queuePosition: 1 }), card(8, { queuePosition: 9 })]), "T-7");
  assert.equal(previousStepBlocker("T-5", [card(5, { queuePosition: 4 }), card(1, { state: "scheduled", queuePosition: 3 })]), "T-1");
  // A task that never started and is not waiting does not block; another feature never does.
  assert.equal(previousStepBlocker("T-5", [card(5), card(1, { state: "not_queued", queuePosition: 0 })]), null);
  assert.equal(previousStepBlocker("T-5", [card(5), task(1, { featureId: OTHER_FEATURE, state: "stalled" })]), null);
});
