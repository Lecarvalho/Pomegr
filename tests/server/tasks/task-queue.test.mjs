import assert from "node:assert/strict";
import test from "node:test";
import { earlierTaskBlocker, nextQueueStart, orderQueue } from "../../../server/tasks/task-queue.mjs";

const A = "feat-aaaaaaaaaaaa";
const B = "feat-bbbbbbbbbbbb";
const G1 = "grp-000000000001";
const G2 = "grp-000000000002";

function task(number, overrides = {}) {
  return { id: `T-${number}`, featureId: null, group: null, state: "not_queued", queuePosition: null, ...overrides };
}
const queued = (number, overrides = {}) => task(number, { state: "queued", ...overrides });
const flying = (number, overrides = {}) => queued(number, { inFlight: true, ...overrides });
const running = (tasks) => nextQueueStart({ status: "running", tasks });

test("an empty or missing input yields an empty order and no groups", () => {
  assert.deepEqual(orderQueue([]), { order: [], groups: new Map() });
  assert.deepEqual(orderQueue(undefined), { order: [], groups: new Map() });
  assert.deepEqual(orderQueue("tasks"), { order: [], groups: new Map() });
  assert.deepEqual(orderQueue([queued(1)]).order, ["T-1"]);
});

test("Ready order, not the feature, decides the order of the waiting cards", () => {
  const tasks = [
    queued(8, { featureId: B, queuePosition: 0 }),
    queued(5, { featureId: A, queuePosition: 3 }),
    queued(3, { queuePosition: 1 }),
    queued(9, { featureId: B, queuePosition: 4 }),
    queued(4, { featureId: A, queuePosition: 2 }),
  ];
  assert.deepEqual(orderQueue(tasks).order, ["T-8", "T-3", "T-4", "T-5", "T-9"]);
});

test("equal or unusable positions order by task number as numbers, not as text", () => {
  const tied = [10, 2, 33, 1, 9].map((number) => queued(number, { queuePosition: 0 }));
  assert.deepEqual(orderQueue(tied).order, ["T-1", "T-2", "T-9", "T-10", "T-33"]);
  const tasks = [queued(1, { queuePosition: null }), queued(2, { queuePosition: Number.NaN }), queued(3, { queuePosition: 7 }), queued(4, { queuePosition: 2 })];
  assert.deepEqual(orderQueue(tasks).order, ["T-4", "T-3", "T-1", "T-2"]);
});

test("only waiting due tasks are in the order", () => {
  const states = ["not_queued", "needs_review", "stalled", "blocked", "done"];
  const tasks = states.map((state, index) => task(index + 1, { state, queuePosition: index }));
  assert.deepEqual(orderQueue(tasks).order, []);
  const mixed = [
    task(1, { state: "scheduled", due: true, queuePosition: 0 }),
    task(2, { state: "scheduled", due: false, queuePosition: 1 }),
    task(3, { state: "scheduled", queuePosition: 2 }),
    flying(4, { queuePosition: 3 }),
    queued(5, { queuePosition: 4 }),
  ];
  assert.deepEqual(orderQueue(mixed).order, ["T-1", "T-5"]);
});

test("a group counts only while two or more of its tasks are in the queue", () => {
  const tasks = [
    queued(1, { group: G1 }),
    queued(2, { group: G1 }),
    queued(3, { group: G2 }),
    task(4, { state: "needs_review", group: G2 }),
    task(5, { state: "done", group: G2 }),
    queued(6),
  ];
  const { groups } = orderQueue(tasks);
  assert.equal(groups.get("T-1"), G1);
  assert.equal(groups.get("T-2"), G1);
  assert.equal(groups.get("T-3"), null, "a group of one is no group");
  assert.equal(groups.get("T-4"), null);
  assert.equal(groups.get("T-6"), null);
  // A member in flight and a member not due still count as in the queue.
  const held = orderQueue([flying(1, { group: G1 }), task(2, { state: "scheduled", due: false, group: G1 })]).groups;
  assert.equal(held.get("T-1"), G1);
  assert.equal(held.get("T-2"), G1);
});

test("odd input never throws and is skipped; the first record of a repeated ID wins", () => {
  const tasks = [
    null, undefined, 7, "T-1", [], {},
    { id: "T-0", state: "queued" }, { id: "T-01", state: "queued" }, { id: "T-1x", state: "queued" }, { id: 4, state: "queued" },
    { id: "T-1234567890", state: "queued" }, { id: "t-5", state: "queued" },
    queued(1, { queuePosition: 1 }),
    queued(1, { queuePosition: 0 }),
    { id: "T-2", state: "queued" },
    { id: "T-3" },
    { id: "T-4", state: "queued", group: "", queuePosition: "3" },
  ];
  assert.deepEqual(orderQueue(tasks).order, ["T-1", "T-2", "T-4"]);
  assert.deepEqual(orderQueue({ length: 3 }).order, []);
});

test("the rule changes nothing it is given", () => {
  const tasks = [queued(2, { group: G1, queuePosition: 4 }), queued(1, { group: G1, queuePosition: 2 }), flying(3)];
  const snapshot = JSON.stringify(tasks);
  orderQueue(tasks);
  nextQueueStart({ status: "running", tasks });
  earlierTaskBlocker("T-1", tasks);
  assert.equal(JSON.stringify(tasks), snapshot);
});

test("nothing starts unless the queue is running", () => {
  const tasks = [queued(1)];
  for (const status of ["stopped", "paused", "blocked", undefined]) assert.equal(nextQueueStart({ status, tasks }), null, String(status));
  assert.equal(nextQueueStart(undefined), null);
  assert.deepEqual(running(tasks), { starts: ["T-1"] });
  assert.equal(running([]), null);
});

test("the start is the top waiting card of Ready, across features and single tasks", () => {
  const tasks = [
    queued(1, { featureId: A, queuePosition: 2 }),
    queued(2, { queuePosition: 0 }),
    queued(3, { featureId: B, queuePosition: 1 }),
  ];
  assert.deepEqual(running(tasks), { starts: ["T-2"] });
  assert.deepEqual(running([tasks[0], tasks[2]]), { starts: ["T-3"] });
});

test("adjacency alone never groups: neighbors of one feature start one at a time", () => {
  const tasks = [queued(1, { featureId: A, queuePosition: 0 }), queued(2, { featureId: A, queuePosition: 1 }), queued(3, { featureId: A, queuePosition: 2 })];
  assert.deepEqual(running(tasks), { starts: ["T-1"] });
  assert.equal(running([flying(1, { featureId: A }), ...tasks.slice(1)]), null);
});

test("ungrouped cards are sequential: a task in flight holds every start", () => {
  const tasks = [flying(1, { queuePosition: 0 }), queued(2, { queuePosition: 1 }), queued(3, { featureId: B, queuePosition: 2 })];
  assert.equal(running(tasks), null);
});

test("a group starts together, across features, by Ready order", () => {
  const tasks = [
    queued(4, { featureId: B, group: G1, queuePosition: 0 }),
    queued(2, { featureId: A, group: G1, queuePosition: 1 }),
    queued(3, { queuePosition: 2 }),
    queued(1, { group: G1, queuePosition: 3 }),
  ];
  assert.deepEqual(running(tasks), { starts: ["T-4", "T-2", "T-1"] });
});

test("a group of one is no group: it starts alone", () => {
  const tasks = [queued(1, { group: G1, queuePosition: 0 }), queued(2, { queuePosition: 1 })];
  assert.deepEqual(running(tasks), { starts: ["T-1"] });
  // The other member left the queue.
  assert.deepEqual(running([queued(1, { group: G1, queuePosition: 0 }), task(2, { state: "done", group: G1 }), queued(3, { queuePosition: 1 })]), { starts: ["T-1"] });
});

test("the waiting rest of a running group starts, and nothing else does", () => {
  const tasks = [
    flying(1, { group: G1 }),
    queued(2, { group: G1, queuePosition: 1 }),
    queued(3, { queuePosition: 0 }),
    queued(4, { group: G2, queuePosition: 2 }),
    queued(5, { group: G2, queuePosition: 3 }),
    queued(6, { group: G1, queuePosition: 4 }),
  ];
  assert.deepEqual(running(tasks), { starts: ["T-2", "T-6"] });
});

test("in flight outside a group, or in another group, holds everything", () => {
  const group = [queued(2, { group: G1, queuePosition: 0 }), queued(3, { group: G1, queuePosition: 1 })];
  assert.equal(running([flying(1), ...group]), null);
  assert.equal(running([flying(1, { group: G2 }), flying(4, { group: G2 }), ...group]), null);
  // A task in flight outside the group holds even the waiting rest of a running group.
  assert.equal(running([flying(1, { group: G1 }), flying(5), queued(2, { group: G1 })]), null);
});

test("a scheduled member that is not due is skipped and holds nothing", () => {
  const tasks = [
    task(1, { state: "scheduled", due: false, group: G1, queuePosition: 0 }),
    queued(2, { group: G1, queuePosition: 1 }),
    queued(3, { group: G1, queuePosition: 2 }),
    queued(4, { queuePosition: 3 }),
  ];
  assert.deepEqual(running(tasks), { starts: ["T-2", "T-3"] });
  assert.deepEqual(running([task(1, { state: "scheduled", due: false, queuePosition: 0 }), queued(2, { queuePosition: 1 })]), { starts: ["T-2"] });
  assert.deepEqual(running([task(1, { state: "scheduled", due: true, queuePosition: 0 }), queued(2, { queuePosition: 1 })]), { starts: ["T-1"] });
});

test("an unlinked candidate pauses the queue at it", () => {
  assert.deepEqual(running([queued(1, { unlinked: true, queuePosition: 0 }), queued(2, { queuePosition: 1 })]), { pause: "T-1" });
  const group = [queued(1, { group: G1 }), queued(2, { group: G1, unlinked: true })];
  assert.deepEqual(running(group), { pause: "T-2" });
  // An unlinked task that is not a candidate does not pause.
  assert.deepEqual(running([queued(1, { queuePosition: 0 }), queued(2, { unlinked: true, queuePosition: 1 })]), { starts: ["T-1"] });
});

test("earlierTaskBlocker names the lowest task in flight outside the task's own group", () => {
  const tasks = [flying(5), flying(3), queued(7), flying(9, { group: G1 }), queued(10, { group: G1 }), queued(11, { group: G1 })];
  assert.equal(earlierTaskBlocker("T-7", tasks), "T-3");
  assert.equal(earlierTaskBlocker("T-10", tasks), "T-3");
  assert.equal(earlierTaskBlocker("T-10", [flying(9, { group: G1 }), queued(10, { group: G1 })]), null);
  assert.equal(earlierTaskBlocker("T-7", [queued(7), queued(8)]), null);
  assert.equal(earlierTaskBlocker("T-7", [flying(7)]), null, "a task never blocks itself");
  assert.equal(earlierTaskBlocker("T-99", tasks), null, "an unknown task has no blocker");
  assert.equal(earlierTaskBlocker("T-1", undefined), null);
});
