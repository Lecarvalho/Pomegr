import assert from "node:assert/strict";
import test from "node:test";
import { orderQueue } from "../../../server/tasks/task-queue.mjs";

const A = "feat-aaaaaaaaaaaa";
const B = "feat-bbbbbbbbbbbb";
const FEATURES = [{ id: A }, { id: B }];

function task(number, overrides = {}) {
  return { id: `T-${number}`, featureId: null, state: "not_queued", queuePosition: null, ...overrides };
}
const queued = (number, overrides = {}) => task(number, { state: "queued", ...overrides });

test("an empty or missing input yields an empty order", () => {
  assert.deepEqual(orderQueue([], []), { order: [] });
  assert.deepEqual(orderQueue(undefined, undefined), { order: [] });
  assert.deepEqual(orderQueue([queued(1)], undefined), { order: ["T-1"] });
  assert.deepEqual(orderQueue([], FEATURES), { order: [] });
});

test("queued tasks run by feature order, then the place of their cards, then task number, whatever the input order", () => {
  const tasks = [
    queued(8, { featureId: B, queuePosition: 0 }),
    queued(5, { featureId: A, queuePosition: 2 }),
    queued(3, { featureId: A, queuePosition: 1 }),
    queued(9, { featureId: B, queuePosition: 1 }),
    queued(4, { featureId: A, queuePosition: 1 }),
  ];
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-3", "T-4", "T-5", "T-8", "T-9"]);
  // The feature list, not the task list or the feature ID, sets the feature order.
  assert.deepEqual(orderQueue(tasks, [{ id: B }, { id: A }]).order, ["T-8", "T-9", "T-3", "T-4", "T-5"]);
});

test("the place of a card decides the order inside a feature, not the task number", () => {
  const tasks = [queued(1, { featureId: A, queuePosition: 3 }), queued(2, { featureId: A, queuePosition: 1 }), queued(3, { featureId: A })];
  // A card with no place sorts last.
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-2", "T-1", "T-3"]);
});

test("tasks with the same place order by task number as numbers, not as text", () => {
  const tasks = [10, 2, 33, 1, 9].map((number) => queued(number, { featureId: A, queuePosition: 0 }));
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-1", "T-2", "T-9", "T-10", "T-33"]);
  const singles = [10, 2, 33, 1, 9].map((number) => queued(number, { queuePosition: 0 }));
  assert.deepEqual(orderQueue(singles, FEATURES).order, ["T-1", "T-2", "T-9", "T-10", "T-33"]);
});

test("single queued tasks follow every feature and run in the place of their cards", () => {
  const tasks = [
    queued(1, { queuePosition: 5 }),
    queued(2, { featureId: A, queuePosition: 9 }),
    queued(3, { queuePosition: 0 }),
    queued(4, { queuePosition: null }),
    queued(5, { queuePosition: 2 }),
    queued(6, { queuePosition: 2 }),
    queued(7, { queuePosition: Number.NaN }),
  ];
  // Position 0, then 2 (tie by number), then 5; no usable position runs last, by number.
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-2", "T-3", "T-5", "T-6", "T-1", "T-4", "T-7"]);
});

test("only queued tasks and due scheduled tasks are in the order", () => {
  const states = ["not_queued", "scheduled", "needs_review", "stalled", "blocked", "done"];
  const tasks = states.flatMap((state, index) => [
    task(index * 2 + 1, { state, featureId: A, queuePosition: index }),
    task(index * 2 + 2, { state, queuePosition: index }),
  ]);
  assert.deepEqual(orderQueue(tasks, FEATURES).order, []);
  assert.deepEqual(orderQueue([...tasks, queued(99, { featureId: A }), queued(100)], FEATURES).order, ["T-99", "T-100"]);
  assert.deepEqual(orderQueue([task(1, { state: "scheduled", due: true }), task(2, { state: "scheduled", due: false })], []).order, ["T-1"]);
});

test("a task naming an unknown feature is a single task", () => {
  const tasks = [
    queued(1, { featureId: "feat-000000000000", queuePosition: 1 }),
    queued(2, { featureId: A, queuePosition: 0 }),
    queued(3, { featureId: null, queuePosition: 2 }),
    queued(4, { featureId: 7, queuePosition: 3 }),
  ];
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-2", "T-1", "T-3", "T-4"]);
});

test("odd input never throws and is skipped", () => {
  const tasks = [
    null, undefined, 7, "T-1", [], {},
    { id: "T-0", state: "queued" }, { id: "T-01", state: "queued" }, { id: "T-1x", state: "queued" }, { id: 4, state: "queued" },
    { id: "T-1234567890", state: "queued" }, { id: "t-5", state: "queued" },
    queued(1, { queuePosition: 1 }),
    queued(1, { queuePosition: 0 }),
    { id: "T-2", state: "queued" },
    { id: "T-3" },
    { id: "T-4", state: "queued", featureId: undefined, queuePosition: "3" },
  ];
  const features = [null, 5, {}, { id: "" }, { id: 8 }, { id: A }, { id: A }];
  assert.deepEqual(orderQueue(tasks, features), { order: ["T-1", "T-2", "T-4"] });
  assert.deepEqual(orderQueue("tasks", "features"), { order: [] });
  assert.deepEqual(orderQueue({ length: 3 }, { length: 2 }), { order: [] });
});

test("the first record of a repeated task ID wins and no ID appears twice", () => {
  const result = orderQueue([queued(1, { featureId: A, queuePosition: 2 }), queued(1, { featureId: A, queuePosition: 0 }), queued(2, { featureId: A, queuePosition: 1 })], FEATURES);
  assert.deepEqual(result.order, ["T-2", "T-1"]);
});

test("the rule changes nothing it is given and holds only IDs", () => {
  const tasks = [queued(2, { featureId: A, queuePosition: 4 }), queued(1, { queuePosition: 2 })];
  const features = [{ id: A, name: "never copied" }];
  const snapshot = JSON.stringify([tasks, features]);
  const result = orderQueue(tasks, features);
  assert.equal(JSON.stringify([tasks, features]), snapshot);
  assert.deepEqual(Object.keys(result), ["order"]);
  assert.equal(JSON.stringify(result).includes("never copied"), false);
});

test("a task in flight is not in the order", () => {
  const tasks = [queued(1, { featureId: A, inFlight: true }), queued(2, { featureId: A }), queued(4, { inFlight: true }), queued(5)];
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-2", "T-5"]);
  assert.deepEqual(orderQueue([task(1, { state: "scheduled", due: true, inFlight: true })], []).order, []);
});
