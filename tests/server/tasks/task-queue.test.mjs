import assert from "node:assert/strict";
import test from "node:test";
import { orderQueue } from "../../../server/tasks/task-queue.mjs";

const A = "feat-aaaaaaaaaaaa";
const B = "feat-bbbbbbbbbbbb";
const FEATURES = [{ id: A }, { id: B }];

function task(number, overrides = {}) {
  return { id: `T-${number}`, featureId: null, step: null, state: "not_queued", queuePosition: null, ...overrides };
}
const queued = (number, overrides = {}) => task(number, { state: "queued", ...overrides });

test("an empty or missing input yields an empty order and no steps", () => {
  assert.deepEqual(orderQueue([], []), { order: [], steps: [] });
  assert.deepEqual(orderQueue(undefined, undefined), { order: [], steps: [] });
  assert.deepEqual(orderQueue([queued(1)], undefined), { order: ["T-1"], steps: [] });
  // A feature with no task has no step to list.
  assert.deepEqual(orderQueue([], FEATURES), { order: [], steps: [] });
});

test("queued tasks run by feature order, then step, then task number, whatever the input order", () => {
  const tasks = [
    queued(8, { featureId: B, step: 1 }),
    queued(5, { featureId: A, step: 2 }),
    queued(3, { featureId: A, step: 1 }),
    queued(9, { featureId: B, step: 2 }),
    queued(4, { featureId: A, step: 1 }),
  ];
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-3", "T-4", "T-5", "T-8", "T-9"]);
  // The feature list, not the task list or the feature ID, sets the feature order.
  assert.deepEqual(orderQueue(tasks, [{ id: B }, { id: A }]).order, ["T-8", "T-9", "T-3", "T-4", "T-5"]);
});

test("tasks of one step order by task number as numbers, not as text", () => {
  const tasks = [10, 2, 33, 1, 9].map((number) => queued(number, { featureId: A, step: 1 }));
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-1", "T-2", "T-9", "T-10", "T-33"]);
  const singles = [10, 2, 33, 1, 9].map((number) => queued(number, { queuePosition: 0 }));
  assert.deepEqual(orderQueue(singles, FEATURES).order, ["T-1", "T-2", "T-9", "T-10", "T-33"]);
});

test("single queued tasks follow every feature and run in the order they were queued", () => {
  const tasks = [
    queued(1, { queuePosition: 5 }),
    queued(2, { featureId: A, step: 1 }),
    queued(3, { queuePosition: 0 }),
    queued(4, { queuePosition: null }),
    queued(5, { queuePosition: 2 }),
    queued(6, { queuePosition: 2 }),
    queued(7, { queuePosition: Number.NaN }),
  ];
  // Position 0, then 2 (tie by number), then 5; no usable position runs last, by number.
  assert.deepEqual(orderQueue(tasks, FEATURES).order, ["T-2", "T-3", "T-5", "T-6", "T-1", "T-4", "T-7"]);
});

test("only queued tasks are in the order, in every other state", () => {
  const states = ["not_queued", "scheduled", "needs_review", "stalled", "blocked", "done"];
  const tasks = states.flatMap((state, index) => [
    task(index * 2 + 1, { state, featureId: A, step: index + 1, queuePosition: index }),
    task(index * 2 + 2, { state, queuePosition: index }),
  ]);
  assert.deepEqual(orderQueue(tasks, FEATURES).order, []);
  assert.deepEqual(orderQueue([...tasks, queued(99, { featureId: A, step: 9 }), queued(100)], FEATURES).order, ["T-99", "T-100"]);
});

test("steps lists every step of every feature, ascending, with its tasks of any state", () => {
  const tasks = [
    task(7, { state: "done", featureId: B, step: 1 }),
    queued(4, { featureId: A, step: 3 }),
    task(2, { state: "done", featureId: A, step: 1 }),
    task(10, { state: "stalled", featureId: A, step: 3 }),
    task(3, { state: "done", featureId: A, step: 1 }),
    task(5, { state: "not_queued", featureId: A, step: 2 }),
    queued(6),
  ];
  assert.deepEqual(orderQueue(tasks, FEATURES).steps, [
    { featureId: A, step: 1, taskIds: ["T-2", "T-3"], done: true },
    { featureId: A, step: 2, taskIds: ["T-5"], done: false },
    { featureId: A, step: 3, taskIds: ["T-4", "T-10"], done: false },
    { featureId: B, step: 1, taskIds: ["T-7"], done: true },
  ]);
});

test("a step is done only when it has tasks and every one of them is done", () => {
  const tasks = [
    task(1, { state: "done", featureId: A, step: 1 }),
    task(2, { state: "done", featureId: A, step: 2 }),
    queued(3, { featureId: A, step: 2 }),
  ];
  const { steps } = orderQueue(tasks, FEATURES);
  assert.deepEqual(steps.map((entry) => [entry.step, entry.done]), [[1, true], [2, false]]);
});

test("a task naming an unknown feature, or a step that is not an integer of at least 1, is a single task", () => {
  const tasks = [
    queued(1, { featureId: "feat-000000000000", step: 1, queuePosition: 1 }),
    queued(2, { featureId: A, step: 0, queuePosition: 0 }),
    queued(3, { featureId: A, step: 1.5, queuePosition: 2 }),
    queued(4, { featureId: A, step: null, queuePosition: 3 }),
    queued(5, { featureId: A, step: "1", queuePosition: 4 }),
    queued(6, { featureId: 7, step: 1, queuePosition: 5 }),
    queued(7, { featureId: A, step: 1 }),
  ];
  const result = orderQueue(tasks, FEATURES);
  assert.deepEqual(result.order, ["T-7", "T-2", "T-1", "T-3", "T-4", "T-5", "T-6"]);
  assert.deepEqual(result.steps, [{ featureId: A, step: 1, taskIds: ["T-7"], done: false }]);
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
    { id: "T-4", state: "queued", featureId: undefined, step: undefined, queuePosition: "3" },
  ];
  const features = [null, 5, {}, { id: "" }, { id: 8 }, { id: A }, { id: A }];
  assert.deepEqual(orderQueue(tasks, features), { order: ["T-1", "T-2", "T-4"], steps: [] });
  assert.deepEqual(orderQueue("tasks", "features"), { order: [], steps: [] });
  assert.deepEqual(orderQueue({ length: 3 }, { length: 2 }), { order: [], steps: [] });
});

test("the first record of a repeated task ID wins and no ID appears twice", () => {
  const result = orderQueue([queued(1, { featureId: A, step: 2 }), queued(1, { featureId: A, step: 1 }), queued(2, { featureId: A, step: 1 })], FEATURES);
  assert.deepEqual(result.order, ["T-2", "T-1"]);
  assert.deepEqual(result.steps.map((entry) => [entry.step, entry.taskIds]), [[1, ["T-2"]], [2, ["T-1"]]]);
});

test("the rule changes nothing it is given and holds only IDs and fixed fields", () => {
  const tasks = [queued(2, { featureId: A, step: 1, queuePosition: 4 }), queued(1, { queuePosition: 2 })];
  const features = [{ id: A, name: "never copied" }];
  const snapshot = JSON.stringify([tasks, features]);
  const result = orderQueue(tasks, features);
  assert.equal(JSON.stringify([tasks, features]), snapshot);
  assert.deepEqual(Object.keys(result).sort(), ["order", "steps"]);
  assert.deepEqual(Object.keys(result.steps[0]).sort(), ["done", "featureId", "step", "taskIds"]);
  assert.equal(JSON.stringify(result).includes("never copied"), false);
});

test("a task in flight is not in the order but stays in its step, so the step is not done", () => {
  const tasks = [queued(1, { featureId: A, step: 1, inFlight: true }), queued(2, { featureId: A, step: 1 }), queued(3, { featureId: A, step: 2 }), queued(4, { inFlight: true }), queued(5)];
  const { order, steps } = orderQueue(tasks, FEATURES);
  assert.deepEqual(order, ["T-2", "T-3", "T-5"]);
  assert.deepEqual(steps, [
    { featureId: A, step: 1, taskIds: ["T-1", "T-2"], done: false },
    { featureId: A, step: 2, taskIds: ["T-3"], done: false },
  ]);
  assert.deepEqual(orderQueue([task(1, { state: "scheduled", due: true, inFlight: true })], []).order, []);
});
