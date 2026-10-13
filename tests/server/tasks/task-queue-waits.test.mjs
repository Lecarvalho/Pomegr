import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { DESKTOP_AUTH_HEADER } from "../../../shared/local-auth.mjs";
import { createRequestHandler } from "../../../server/serving/request-handler.mjs";
import { WAIT_REASONS, WAIT_TASK_LIMIT, projectWaits } from "../../../server/serving/task-routes.mjs";
import { TASK_QUEUE_WAIT_REASONS, TASK_QUEUE_WAIT_TASK_LIMIT, explainQueueWaits } from "../../../server/tasks/task-queue-waits.mjs";
import {
  GATE_FACTS, REPOSITORY, SESSION, createTask, openTemporaryStore, passingGates, pauseReasonKey, queueSettings, queueTask, setMeta, setQueueRow,
  startedTask,
} from "./queue-test-support.mjs";

const A = "feat-aaaaaaaaaaaa";
const B = "feat-bbbbbbbbbbbb";
const FEATURES = [{ id: A }, { id: B }];
const TOKEN = "t".repeat(43);
const SECRET_ROOT = "C:/Work/SECRET-ROOT/repo";

const task = (number, overrides = {}) => ({ id: `T-${number}`, featureId: null, step: null, state: "not_queued", queuePosition: null, ...overrides });
const queued = (number, overrides = {}) => task(number, { state: "queued", ...overrides });
const because = (reason, taskIds = [], more = 0) => ({ reason, taskIds, more });
const explain = (tasks, status = "running", blockedBy = null) => explainQueueWaits({ status, blockedBy, tasks, features: FEATURES });
const waitOf = (waits, id) => waits.find((wait) => wait.taskId === id);

/** The board of the example: feature work T-66 to T-69 in three steps, and the single task T-63 at the top of Ready. */
const EXAMPLE = [
  queued(63, { queuePosition: 0 }),
  queued(66, { featureId: A, step: 1 }), queued(67, { featureId: A, step: 1 }), queued(68, { featureId: A, step: 2 }), queued(69, { featureId: A, step: 3 }),
];

test("a single task waits behind feature work, wherever its card is in Ready", () => {
  assert.deepEqual(explain(EXAMPLE), [
    { taskId: "T-63", place: 5, reasons: [because("feature_first", ["T-66", "T-67", "T-68", "T-69"])] },
    { taskId: "T-66", place: 1, reasons: [], candidate: true },
    { taskId: "T-67", place: 2, reasons: [], candidate: true },
    { taskId: "T-68", place: 3, reasons: [because("previous_step", ["T-66"])] },
    { taskId: "T-69", place: 4, reasons: [because("previous_step", ["T-66"])] },
  ]);
});

test("a single task behind other single tasks names them, and a later feature names the earlier one", () => {
  const waits = explain([queued(1, { queuePosition: 2 }), queued(2, { queuePosition: 0 }), queued(3, { queuePosition: 1 }), queued(4, { featureId: B, step: 1 }), queued(5, { featureId: A, step: 1 })]);
  assert.deepEqual(waitOf(waits, "T-5"), { taskId: "T-5", place: 1, reasons: [], candidate: true });
  assert.deepEqual(waitOf(waits, "T-4"), { taskId: "T-4", place: 2, reasons: [because("earlier_tasks", ["T-5"])] });
  assert.deepEqual(waitOf(waits, "T-2"), { taskId: "T-2", place: 3, reasons: [because("feature_first", ["T-5", "T-4"])] });
  assert.deepEqual(waitOf(waits, "T-1"), { taskId: "T-1", place: 5, reasons: [because("feature_first", ["T-5", "T-4"]), because("earlier_tasks", ["T-2", "T-3"])] });
});

test("a queue that is off, blocked, or paused says so first, and still says what starts before the task", () => {
  assert.deepEqual(waitOf(explain(EXAMPLE, "idle"), "T-63").reasons, [because("queue_off"), because("feature_first", ["T-66", "T-67", "T-68", "T-69"])]);
  // An idle queue is not a blocker: the task the queue would start first carries only that it is off.
  assert.deepEqual(waitOf(explain(EXAMPLE, "idle"), "T-66"), { taskId: "T-66", place: 1, reasons: [because("queue_off")], candidate: true });
  assert.deepEqual(waitOf(explain(EXAMPLE, "blocked", "T-2"), "T-66").reasons, [because("queue_blocked", ["T-2"])]);
  assert.deepEqual(waitOf(explain(EXAMPLE, "paused", "T-66"), "T-67").reasons, [because("queue_paused", ["T-66"])]);
  // A blocker that names no task is still a blocked queue, and a status outside the contract is not known.
  assert.deepEqual(waitOf(explain(EXAMPLE, "paused", "C:/secret"), "T-66").reasons, [because("queue_paused")]);
  assert.deepEqual(waitOf(explain(EXAMPLE, "resting"), "T-66").reasons, [because("unknown")]);
});

test("a scheduled task before its own time has no place in the order and waits for its time", () => {
  const waits = explain([task(1, { state: "scheduled", due: false }), task(2, { state: "scheduled", due: true }), queued(3)]);
  assert.deepEqual(waitOf(waits, "T-1"), { taskId: "T-1", place: null, reasons: [because("own_schedule")] });
  assert.equal(waitOf(waits, "T-2").place, 1);
  assert.deepEqual(waitOf(explain([task(1, { state: "scheduled", due: false })], "idle"), "T-1").reasons, [because("queue_off"), because("own_schedule")]);
});

test("running work holds the tasks outside its step, and a started task is not listed as waiting", () => {
  const single = explain([queued(5, { inFlight: true }), queued(6)]);
  assert.deepEqual(single, [{ taskId: "T-6", place: 1, reasons: [because("running_work", ["T-5"])] }]);
  // The queued rest of a running step still starts; the next step waits on the running task, and a single task on both.
  const step = explain([queued(1, { featureId: A, step: 1, inFlight: true }), queued(2, { featureId: A, step: 1 }), queued(3, { featureId: A, step: 2 }), queued(4)]);
  assert.deepEqual(step, [
    { taskId: "T-2", place: 1, reasons: [], candidate: true },
    { taskId: "T-3", place: 2, reasons: [because("previous_step", ["T-1"])] },
    { taskId: "T-4", place: 3, reasons: [because("feature_first", ["T-2", "T-3"]), because("running_work", ["T-1"])] },
  ]);
});

test("a held feature names the prerequisite the queue will not start, and the work that goes first", () => {
  const waits = explain([task(1, { featureId: A, step: 1 }), queued(2, { featureId: A, step: 2 }), queued(3)]);
  assert.deepEqual(waitOf(waits, "T-3"), { taskId: "T-3", place: 1, reasons: [], candidate: true });
  assert.deepEqual(waitOf(waits, "T-2"), { taskId: "T-2", place: 2, reasons: [because("previous_step", ["T-1"]), because("earlier_tasks", ["T-3"])] });
});

test("facts that name no reason are not known, never a pass", () => {
  // A start that never linked is about to pause the queue: the rule answers no start for it and knows no fixed reason.
  assert.deepEqual(explain([queued(1, { unlinked: true })]), [{ taskId: "T-1", place: 1, reasons: [because("unknown")] }]);
  for (const input of [undefined, null, "queue", {}, { status: "running", tasks: "none" }]) assert.deepEqual(explainQueueWaits(input), []);
  assert.deepEqual(explain([{ id: "C:/secret", state: "queued" }, null, queued(1), queued(1)]).map((wait) => wait.taskId), ["T-1"]);
});

test("a reason names at most eight tasks and counts the rest", () => {
  const tasks = [...Array.from({ length: 11 }, (_, index) => queued(index + 1, { featureId: A, step: 1 })), queued(20)];
  assert.deepEqual(waitOf(explain(tasks), "T-20").reasons, [because("feature_first", ["T-1", "T-2", "T-3", "T-4", "T-5", "T-6", "T-7", "T-8"], 3)]);
  assert.equal(TASK_QUEUE_WAIT_TASK_LIMIT, 8);
});

test("the route's mirrored wait constants match the rule module", () => {
  assert.deepEqual([...WAIT_REASONS], [...TASK_QUEUE_WAIT_REASONS]);
  assert.equal(WAIT_TASK_LIMIT, TASK_QUEUE_WAIT_TASK_LIMIT);
});

/** The example on a real store: T-1 and T-2 in step 1, T-3 in step 2, T-4 in step 3, and the single task T-5. */
function exampleBoard(store) {
  const feature = store.apply(REPOSITORY, "feature_create", { name: "Queue controls" }).board.features[0].id;
  for (const step of [1, 1, 2, 3]) createTask(store, REPOSITORY, { featureId: feature, step });
  createTask(store);
  for (let number = 1; number <= 5; number += 1) queueTask(store, `T-${number}`);
}

test("moving a single task to the top of Ready does not make it next, and its wait says why", async (context) => {
  const { store } = await openTemporaryStore(context);
  exampleBoard(store);
  const ready = store.readBoard(REPOSITORY).columns[1].id;
  const moved = store.apply(REPOSITORY, "move", { id: "T-5", columnId: ready, position: 0 }, { resolveGateFacts: passingGates });
  assert.equal(moved.ok, true);
  assert.deepEqual(moved.board.queue.order, ["T-1", "T-2", "T-3", "T-4", "T-5"]);
  assert.deepEqual(waitOf(moved.board.queue.waits, "T-5"), { taskId: "T-5", place: 5, reasons: [because("queue_off"), because("feature_first", ["T-1", "T-2", "T-3", "T-4"])] });
  assert.equal(queueSettings(store, true).ok, true);
  const { waits } = store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue;
  assert.deepEqual(waits, [
    { taskId: "T-1", place: 1, reasons: [] },
    { taskId: "T-2", place: 2, reasons: [] },
    { taskId: "T-3", place: 3, reasons: [because("previous_step", ["T-1"])] },
    { taskId: "T-4", place: 4, reasons: [because("previous_step", ["T-1"])] },
    { taskId: "T-5", place: 5, reasons: [because("feature_first", ["T-1", "T-2", "T-3", "T-4"])] },
  ]);
  // Reading the waits starts nothing and changes nothing.
  assert.equal(store.readBoard(REPOSITORY).queue.status, "running");
  assert.equal(store.readBoard(REPOSITORY).tasks.every((entry) => entry.session === null && entry.state === "queued"), true);
});

test("a start the gates hold names each gate, and a gate with no fact reads unknown, never passed", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  const dirty = () => ({ ...GATE_FACTS, usage: { ...GATE_FACTS.usage, claude: { fiveHourPercent: 91, sevenDayPercent: 40 } }, treeClean: false });
  // The gates hold only a start, so a queue that is off names none of them.
  assert.deepEqual(waitOf(store.readBoard(REPOSITORY, { resolveGateFacts: dirty }).queue.waits, "T-1").reasons, [because("queue_off")]);
  assert.equal(queueSettings(store, true).ok, true);
  const held = store.readBoard(REPOSITORY, { resolveGateFacts: dirty }).queue.waits;
  assert.deepEqual(waitOf(held, "T-1"), { taskId: "T-1", place: 1, reasons: [because("usage_over"), because("tree_dirty")] });
  // Only the task the queue would start is judged by the gates.
  assert.deepEqual(waitOf(held, "T-2"), { taskId: "T-2", place: 2, reasons: [because("earlier_tasks", ["T-1"])] });
  const unknown = [because("usage_unknown"), because("provider_status_unknown"), because("tree_unknown")];
  for (const resolveGateFacts of [() => null, () => { throw new Error(`fatal: ${SECRET_ROOT}`); }, undefined]) {
    assert.deepEqual(waitOf(store.readBoard(REPOSITORY, { resolveGateFacts }).queue.waits, "T-1").reasons, unknown);
  }
  assert.deepEqual(waitOf(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, "T-1").reasons, []);
});

test("a queue that is blocked or paused names its task, and its schedule holds the next start", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-2");
  setQueueRow(directory, "blocked", "T-1");
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, [{ taskId: "T-2", place: 1, reasons: [because("queue_blocked", ["T-1"])] }]);
  setQueueRow(directory, "paused", "T-2");
  setMeta(directory, pauseReasonKey(), "cli_missing");
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, [{ taskId: "T-2", place: 1, reasons: [because("queue_paused", ["T-2"])] }]);
  setQueueRow(directory, "running");
  const schedule = { startAt: new Date(clock.now + 3_600_000).toISOString(), stopAfter: null };
  assert.equal(store.apply(REPOSITORY, "queue_settings", { schedule }).ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, [{ taskId: "T-2", place: 1, reasons: [because("before_queue_start")] }]);
  clock.now += 7_200_000;
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, [{ taskId: "T-2", place: 1, reasons: [] }]);
});

test("a scheduled task waits for its own time, then takes its place", async (context) => {
  const { store, clock } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-1");
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-2", at: new Date(clock.now + 3_600_000).toISOString() }).ok, true);
  assert.equal(queueSettings(store, true).ok, true);
  assert.deepEqual(waitOf(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, "T-2"), { taskId: "T-2", place: null, reasons: [because("own_schedule")] });
  clock.now += 3_600_000;
  assert.deepEqual(waitOf(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, "T-2"), { taskId: "T-2", place: 2, reasons: [because("earlier_tasks", ["T-1"])] });
});

test("a started task leaves the waits, and the task behind it names it as running", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  assert.equal(Object.hasOwn(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue, "waits"), false, "a board with no waiting task carries no waits");
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  assert.equal(queueSettings(store, true).ok, true);
  // A live dispatch has started the task before any session links.
  startedTask(directory, 1, { mintedAt: clock.now });
  const running = [{ taskId: "T-2", place: 1, reasons: [because("running_work", ["T-1"])] }];
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, running);
  startedTask(directory, 1, { session: SESSION });
  assert.deepEqual(store.readBoard(REPOSITORY, { resolveGateFacts: passingGates }).queue.waits, running);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
});

test("projectWaits rebuilds valid waits and drops them whole when one value is outside the contract", () => {
  const valid = [
    { taskId: "T-63", place: 5, reasons: [because("queue_off"), because("feature_first", ["T-66", "T-67"], 2)] },
    { taskId: "T-7", place: null, reasons: [because("own_schedule")] },
    { taskId: "T-8", place: 1, reasons: [] },
  ];
  const noisy = valid.map((wait) => ({ ...wait, text: "secret", candidate: true, reasons: wait.reasons.map((entry) => ({ ...entry, root: SECRET_ROOT })) }));
  assert.deepEqual(projectWaits(noisy), valid);
  for (const broken of [
    null, undefined, "waits", [], {},
    [{ ...valid[0], taskId: "63" }],
    [{ ...valid[0], place: 0 }],
    [{ ...valid[0], place: 1.5 }],
    [{ ...valid[0], reasons: "none" }],
    [{ ...valid[0], reasons: [because("git status failed")] }],
    [{ ...valid[0], reasons: [because("feature_first", [SECRET_ROOT])] }],
    [{ ...valid[0], reasons: [because("feature_first", Array.from({ length: 9 }, (_, index) => `T-${index + 1}`))] }],
    [{ ...valid[0], reasons: [because("feature_first", ["T-1"], -1)] }],
    [valid[1], "T-1"],
  ]) assert.equal(projectWaits(broken), undefined);
});

test("GET /api/tasks serves the waits as task IDs, places, and fixed reasons only", async (context) => {
  const { store } = await openTemporaryStore(context);
  exampleBoard(store);
  assert.equal(queueSettings(store, true).ok, true);
  const runtime = { resolveTaskGateFacts: () => ({ ...GATE_FACTS, treeClean: false, root: SECRET_ROOT }) };
  const server = http.createServer(createRequestHandler({ runtime, taskStore: store, authorizationToken: TOKEN }));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks?repositoryId=${REPOSITORY}`, { headers: { [DESKTOP_AUTH_HEADER]: TOKEN } });
  const text = await response.text();
  const { queue } = JSON.parse(text);
  assert.deepEqual(Object.keys(queue), ["status", "blockedBy", "pauseReason", "order", "gates", "waits"]);
  assert.deepEqual(queue.waits.map((wait) => Object.keys(wait)), Array.from({ length: 5 }, () => ["taskId", "place", "reasons"]));
  assert.deepEqual(waitOf(queue.waits, "T-1").reasons, [because("tree_dirty")]);
  assert.deepEqual(waitOf(queue.waits, "T-5"), { taskId: "T-5", place: 5, reasons: [because("feature_first", ["T-1", "T-2", "T-3", "T-4"])] });
  assert.equal(text.includes("SECRET-ROOT"), false);
  assert.equal(text.includes("candidate"), false);
});
