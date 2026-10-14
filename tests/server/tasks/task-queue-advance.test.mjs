import assert from "node:assert/strict";
import test from "node:test";
import { nextQueueStart, orderQueue, queueWhenTurnedOn } from "../../../server/tasks/task-queue.mjs";

// A queue record as the store hands it to the rule.
const task = (number, overrides = {}) => ({
  id: `T-${number}`, featureId: null, group: null, state: "queued", queuePosition: number, inFlight: false, unlinked: false, ...overrides,
});
const FEATURE = "feat-aaaaaaaaaaaa";
const OTHER_FEATURE = "feat-bbbbbbbbbbbb";
const GROUP = "grp-aaaaaaaaaaaa";
const OTHER_GROUP = "grp-bbbbbbbbbbbb";
const next = (tasks, status = "running") => nextQueueStart({ status, tasks });

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
  for (const status of ["idle", "blocked", "paused", "unknown", "", undefined, null, 1]) assert.equal(nextQueueStart({ status, tasks }), null, String(status));
  assert.equal(next(tasks, "running") !== null, true);
  for (const input of [undefined, null, "running", 7, [], {}]) assert.equal(nextQueueStart(input), null, JSON.stringify(input));
});

test("a running queue with nothing queued has nothing to do", () => {
  assert.equal(next([]), null);
  assert.equal(next([task(1, { state: "not_queued", queuePosition: null }), task(2, { state: "done" }), task(3, { state: "scheduled" })]), null);
  assert.equal(nextQueueStart({ status: "running" }), null);
  assert.equal(nextQueueStart({ status: "running", tasks: "T-1" }), null);
});

test("the first queued task starts, in the order the board marks as next", () => {
  assert.deepEqual(next([task(1, { queuePosition: 5 }), task(2, { queuePosition: 1 })]), { starts: ["T-2"] });
  assert.deepEqual(next([task(4, { queuePosition: null }), task(3, { queuePosition: 9 })]), { starts: ["T-3"] });
});

test("the starts always begin with the first task of orderQueue, for grouped, featured, and plain tasks alike", () => {
  const tasks = [
    task(1, { queuePosition: 0 }),
    task(2, { featureId: OTHER_FEATURE, queuePosition: 1 }),
    task(3, { featureId: FEATURE, state: "done", queuePosition: null }),
    task(4, { featureId: FEATURE, group: GROUP, queuePosition: 2 }),
    task(5, { featureId: OTHER_FEATURE, group: GROUP, queuePosition: 3 }),
    task(6, { queuePosition: 4 }),
  ];
  assert.deepEqual(orderQueue(tasks).order, ["T-1", "T-2", "T-4", "T-5", "T-6"]);
  assert.deepEqual(next(tasks), { starts: ["T-1"] });
  // Without T-1 and T-2 ahead, T-4 and T-5 share a group, so they start together, across features.
  const ahead = tasks.filter((entry) => entry.id !== "T-1" && entry.id !== "T-2");
  assert.equal(next(ahead).starts[0], orderQueue(ahead).order[0]);
  assert.deepEqual(next(ahead), { starts: ["T-4", "T-5"] });
  // Removing the first from the queue moves the start with it, and the group of one is no group.
  assert.deepEqual(next(ahead.map((entry) => (entry.id === "T-4" ? { ...entry, state: "not_queued", queuePosition: null } : entry))), { starts: ["T-5"] });
});

test("one task at a time: a task in flight outside a group holds the queue, whatever its state", () => {
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

test("a candidate never skips ahead of the top card of Ready, and a feature or a stalled task holds nothing of it", () => {
  const card = (number, overrides = {}) => task(number, { featureId: FEATURE, ...overrides });
  assert.deepEqual(next([card(1), card(2)]), { starts: ["T-1"] });
  assert.deepEqual(next([card(1, { state: "done" }), card(2)]), { starts: ["T-2"] });
  // A task that waits on the user (or review) never holds the order; the stalled and blocked states stop the queue itself.
  for (const state of ["needs_review", "stalled", "blocked", "not_queued"]) assert.deepEqual(next([card(1, { state }), card(2)]), { starts: ["T-2"] }, state);
  // Another feature's task holds nothing either.
  assert.deepEqual(next([task(1, { featureId: OTHER_FEATURE, state: "stalled" }), card(2), task(3)]), { starts: ["T-2"] });
  // A task in flight does hold: the next card waits for it.
  assert.equal(next([card(1, { inFlight: true }), card(2)]), null);
});

test("an unlinked candidate pauses wherever its feature stands", () => {
  const tasks = [task(1, { featureId: FEATURE, state: "stalled" }), task(2, { featureId: FEATURE, unlinked: true })];
  assert.deepEqual(next(tasks), { pause: "T-2" });
});

test("records the rule cannot place are ignored and never throw", () => {
  const garbage = [null, undefined, "T-1", 7, [], {}, { id: "nope", state: "queued" }, { id: "T-0", state: "queued" }, { id: 3, state: "queued" }];
  assert.equal(next(garbage), null);
  assert.deepEqual(next([...garbage, task(2)]), { starts: ["T-2"] });
  // A repeated ID counts once, as in orderQueue: the first record wins.
  assert.deepEqual(next([task(1, { unlinked: true }), task(1, { unlinked: false })]), { pause: "T-1" });
  assert.deepEqual(nextQueueStart({ status: "running", tasks: [task(1)] }), { starts: ["T-1"] });
});

test("the rule leaves its input alone", () => {
  const tasks = [task(1, { featureId: FEATURE, group: GROUP }), task(2, { group: GROUP, unlinked: true })];
  const snapshot = JSON.stringify({ tasks });
  next(tasks);
  assert.equal(JSON.stringify({ tasks }), snapshot);
});

test("every queued task of one group starts together, by Ready order, and a plain task starts alone", () => {
  const member = (number, overrides = {}) => task(number, { featureId: FEATURE, group: GROUP, ...overrides });
  assert.deepEqual(next([member(3), member(1), member(2), task(4, { group: OTHER_GROUP }), task(5)]), { starts: ["T-1", "T-2", "T-3"] });
  // A member that is not queued does not start; the other is a group of one.
  assert.deepEqual(next([member(1), member(2, { state: "not_queued" }), task(3)]), { starts: ["T-1"] });
  assert.deepEqual(next([task(1), task(2)]), { starts: ["T-1"] });
});

test("the waiting rest of a group joins its tasks in flight, and nothing else does", () => {
  const member = (number, overrides = {}) => task(number, { featureId: FEATURE, group: GROUP, ...overrides });
  // T-1 already started; T-2 was held by a gate and starts now.
  assert.deepEqual(next([member(1, { inFlight: true }), member(2), task(3), task(4)]), { starts: ["T-2"] });
  // The whole group is in flight: the cards after it wait.
  assert.equal(next([member(1, { inFlight: true }), member(2, { inFlight: true }), task(3)]), null);
  // A member done keeps the group of the other, still in flight, running; the next card waits.
  assert.equal(next([member(1, { state: "done" }), member(2, { inFlight: true }), task(3)]), null);
  // Every member in review or done releases the next card.
  assert.deepEqual(next([member(1, { state: "done" }), member(2, { state: "needs_review" }), task(3), task(4)]), { starts: ["T-3"] });
  // Tasks in flight in two groups, in another feature, or outside any group hold the queue.
  assert.equal(next([member(1, { inFlight: true }), task(2, { group: OTHER_GROUP, inFlight: true }), task(3, { group: OTHER_GROUP, inFlight: true }), member(4)]), null);
  assert.equal(next([task(1, { featureId: OTHER_FEATURE, inFlight: true }), member(2), member(3)]), null);
  assert.equal(next([task(1, { inFlight: true }), member(2), member(3)]), null);
});

test("an unlinked task among the starts of a group pauses the queue at it", () => {
  const member = (number, overrides = {}) => task(number, { featureId: FEATURE, group: GROUP, ...overrides });
  assert.deepEqual(next([member(1), member(2, { unlinked: true }), member(3)]), { pause: "T-2" });
  assert.deepEqual(next([member(1, { inFlight: true }), member(2, { unlinked: true })]), { pause: "T-2" });
});
