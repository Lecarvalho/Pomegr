import assert from "node:assert/strict";
import test from "node:test";
import { nextQueueStart, orderQueue, queueWhenTurnedOn } from "../../../server/tasks/task-queue.mjs";

// A queue record as the store hands it to the rule.
const task = (number, overrides = {}) => ({
  id: `T-${number}`, featureId: null, step: null, state: "queued", queuePosition: number, inFlight: false, unlinked: false, ...overrides,
});
const features = [{ id: "feat-aaaaaaaaaaaa" }, { id: "feat-bbbbbbbbbbbb" }];
const FEATURE = features[0].id;
const OTHER_FEATURE = features[1].id;
const next = (tasks, status = "running", list = features) => nextQueueStart({ status, tasks, features: list });

test("queueWhenTurnedOn runs unless a task needs the user, then blocks at the lowest-numbered one", () => {
  assert.deepEqual(queueWhenTurnedOn([]), { status: "running", blockedBy: null });
  assert.deepEqual(queueWhenTurnedOn([task(1), task(2, { state: "done" }), task(3, { state: "not_queued" }), task(4, { state: "scheduled" })]), { status: "running", blockedBy: null });
  for (const state of ["needs_review", "stalled", "blocked"]) {
    assert.deepEqual(queueWhenTurnedOn([task(1), task(7, { state })]), { status: "blocked", blockedBy: "T-7" }, state);
  }
  // Numeric, not textual: T-2 sorts before T-10, whatever the list order.
  assert.deepEqual(queueWhenTurnedOn([task(10, { state: "blocked" }), task(2, { state: "stalled" }), task(30, { state: "needs_review" })]), { status: "blocked", blockedBy: "T-2" });
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
  assert.deepEqual(next([task(1, { queuePosition: 5 }), task(2, { queuePosition: 1 })]), { start: "T-2" });
  assert.deepEqual(next([task(4, { queuePosition: null }), task(3, { queuePosition: 9 })]), { start: "T-3" });
});

test("the start is always the first task of orderQueue, for features, steps, and tasks without a feature alike", () => {
  const tasks = [
    task(1, { queuePosition: 0 }),
    task(2, { featureId: OTHER_FEATURE, step: 1, queuePosition: 1 }),
    task(3, { featureId: FEATURE, step: 1, state: "done", queuePosition: null }),
    task(4, { featureId: FEATURE, step: 2, queuePosition: 2 }),
    task(5, { featureId: FEATURE, step: 2, queuePosition: 3 }),
    task(6, { queuePosition: 4 }),
  ];
  assert.deepEqual(orderQueue(tasks, features).order, ["T-4", "T-5", "T-2", "T-1", "T-6"]);
  assert.deepEqual(next(tasks), { start: orderQueue(tasks, features).order[0] });
  assert.deepEqual(next(tasks), { start: "T-4" });
  // Removing the first from the queue moves the start with it.
  assert.deepEqual(next(tasks.map((entry) => (entry.id === "T-4" ? { ...entry, state: "not_queued", queuePosition: null } : entry))), { start: "T-5" });
});

test("one task at a time: any task in flight holds the queue, whatever its state", () => {
  for (const state of ["not_queued", "queued", "scheduled", "done"]) {
    assert.equal(next([task(1), task(2, { state, inFlight: true })]), null, state);
  }
  assert.equal(next([task(1, { inFlight: true })]), null);
  assert.deepEqual(next([task(1), task(2, { inFlight: false })]), { start: "T-1" });
  // Only a literal true counts as in flight; the store supplies booleans.
  assert.deepEqual(next([task(1), task(2, { inFlight: "yes" })]), { start: "T-1" });
});

test("a candidate whose start expired with no session pauses the queue instead of starting again", () => {
  assert.deepEqual(next([task(1, { unlinked: true }), task(2)]), { pause: "T-1" });
  // Only the candidate is judged: an unlinked task further down the order is not the queue's concern yet.
  assert.deepEqual(next([task(1), task(2, { unlinked: true })]), { start: "T-1" });
  // A task that is in flight wins over any pause: the queue is simply waiting.
  assert.equal(next([task(1, { unlinked: true }), task(2, { inFlight: true })]), null);
  // An unlinked task that is not queued is not a candidate.
  assert.equal(next([task(1, { state: "not_queued", unlinked: true })]), null);
});

test("a candidate waits for every earlier step of its feature and never skips ahead to a later task", () => {
  const step = (number, stepNumber, overrides = {}) => task(number, { featureId: FEATURE, step: stepNumber, ...overrides });
  assert.deepEqual(next([step(1, 1), step(2, 2)]), { start: "T-1" });
  assert.deepEqual(next([step(1, 1, { state: "done" }), step(2, 2)]), { start: "T-2" });
  // Step 1 is not done: its task is still queued behind, in progress, or waiting on the user.
  for (const state of ["not_queued", "scheduled", "needs_review", "stalled", "blocked"]) {
    assert.equal(next([step(1, 1, { state }), step(2, 2)]), null, state);
  }
  // The queue waits; a queued task without a feature further down does not jump the line.
  assert.equal(next([step(1, 1, { state: "needs_review" }), step(2, 2), task(3)]), null);
  // One undone task in an earlier step is enough, and every step before the candidate counts.
  assert.equal(next([step(1, 1, { state: "done" }), step(2, 2, { state: "done" }), step(3, 2, { state: "stalled" }), step(4, 3)]), null);
  assert.equal(next([step(1, 1, { state: "stalled" }), step(2, 2, { state: "done" }), step(3, 3)]), null);
  // Tasks of the same step are not earlier steps of each other.
  assert.deepEqual(next([step(1, 2, { state: "done" }), step(2, 2), step(3, 1, { state: "done" })]), { start: "T-2" });
});

test("another feature's steps do not hold a candidate", () => {
  const tasks = [
    task(1, { featureId: OTHER_FEATURE, step: 1, state: "stalled" }),
    task(2, { featureId: FEATURE, step: 1 }),
  ];
  // The stalled task is in the other feature's step 1, so it holds nothing of this feature, in either feature order.
  assert.deepEqual(next(tasks), { start: "T-2" });
  assert.deepEqual(next(tasks, "running", [features[1], features[0]]), { start: "T-2" });
});

test("an unlinked candidate pauses before the step rule is consulted", () => {
  const tasks = [task(1, { featureId: FEATURE, step: 1, state: "stalled" }), task(2, { featureId: FEATURE, step: 2, unlinked: true })];
  assert.deepEqual(next(tasks), { pause: "T-2" });
});

test("a task that names no listed feature or an invalid step is a task without a feature", () => {
  assert.deepEqual(next([task(1, { featureId: "feat-cccccccccccc", step: 2 })]), { start: "T-1" });
  assert.deepEqual(next([task(1, { featureId: FEATURE, step: 0 })]), { start: "T-1" });
  assert.deepEqual(next([task(1, { featureId: FEATURE, step: "2" }), task(2, { featureId: FEATURE, step: 1, state: "stalled" })]), { start: "T-1" });
});

test("records the rule cannot place are ignored and never throw", () => {
  const garbage = [null, undefined, "T-1", 7, [], {}, { id: "nope", state: "queued" }, { id: "T-0", state: "queued" }, { id: 3, state: "queued" }];
  assert.equal(next(garbage), null);
  assert.deepEqual(next([...garbage, task(2)]), { start: "T-2" });
  // A repeated ID counts once, as in orderQueue: the first record wins.
  assert.deepEqual(next([task(1, { unlinked: true }), task(1, { unlinked: false })]), { pause: "T-1" });
  assert.deepEqual(nextQueueStart({ status: "running", tasks: [task(1)], features: [null, "x", { id: "" }, { id: 3 }] }), { start: "T-1" });
});

test("the rule leaves its input alone", () => {
  const tasks = [task(1, { featureId: FEATURE, step: 1 }), task(2, { unlinked: true })];
  const snapshot = JSON.stringify({ tasks, features });
  next(tasks);
  assert.equal(JSON.stringify({ tasks, features }), snapshot);
});
