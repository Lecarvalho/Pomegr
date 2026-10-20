import assert from "node:assert/strict";
import test from "node:test";
import { FACTS, GATE_FACTS, REPOSITORY, START_TIME, createTask, openTemporaryStore, passingGates, queueSettings, queueTask, startedTask, updateTask, withDatabase } from "./queue-test-support.mjs";
import { nextQueueStart } from "../../../server/tasks/task-queue.mjs";
import { explainQueueWaits } from "../../../server/tasks/task-queue-waits.mjs";

// What a task runs after (task-after.mjs): a hold on its start until every task it runs after is Done or deleted.

const after = (store, id, ...ids) => store.apply(REPOSITORY, "after_set", { id, after: ids });
const taskOf = (board, id) => board.tasks.find((task) => task.id === id);
const metaAfterRows = (directory) => withDatabase(directory, (database) => database.prepare("SELECT key, value FROM meta WHERE key LIKE 'task_after:%' ORDER BY key").all().map((row) => ({ ...row })));
const because = (reason, taskIds = []) => ({ reason, taskIds, more: 0 });

async function withTasks(context, count) {
  const env = await openTemporaryStore(context, "pomegr-task-after-");
  for (let index = 0; index < count; index += 1) createTask(env.store, REPOSITORY);
  return env;
}

test("after_set stores the list in meta, serves it on the task, and an empty list clears it", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  const result = after(store, "T-3", "T-1", "T-2");
  assert.equal(result.ok, true);
  assert.deepEqual(taskOf(result.board, "T-3").after, ["T-1", "T-2"]);
  assert.equal(Object.hasOwn(taskOf(result.board, "T-1"), "after"), false);
  assert.deepEqual(metaAfterRows(directory), [{ key: `task_after:${REPOSITORY}:T-3`, value: JSON.stringify(["T-1", "T-2"]) }]);
  assert.equal(after(store, "T-3").ok, true);
  assert.deepEqual(metaAfterRows(directory), []);
  assert.equal(Object.hasOwn(taskOf(store.readBoard(REPOSITORY), "T-3"), "after"), false);
});

test("after_set validates the payload and answers fixed errors", async (context) => {
  const { store } = await withTasks(context, 10);
  const before = store.readBoard(REPOSITORY);
  const nine = Array.from({ length: 9 }, (_, index) => `T-${index + 2}`);
  for (const payload of [undefined, null, [], { id: "T-1" }, { after: [] }, { id: "T-1", after: "T-2" }, { id: "T-1", after: ["T-1"] },
    { id: "T-1", after: ["T-2", "T-2"] }, { id: "T-1", after: ["t-2"] }, { id: "T-1", after: [2] }, { id: "T-1", after: nine }, { id: "T-1", after: [], extra: 1 }]) {
    assert.deepEqual(store.apply(REPOSITORY, "after_set", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  assert.deepEqual(after(store, "T-11", "T-1"), { ok: false, error: "not_found" });
  assert.deepEqual(after(store, "T-1", "T-11"), { ok: false, error: "not_found" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  assert.equal(after(store, "T-1", ...nine.slice(0, 8)).ok, true);
});

test("a list that would make tasks wait for each other is refused, directly or through other tasks", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  assert.equal(after(store, "T-2", "T-1").ok, true);
  assert.equal(after(store, "T-3", "T-2").ok, true);
  const rows = metaAfterRows(directory);
  assert.deepEqual(after(store, "T-1", "T-2"), { ok: false, error: "conflict" });
  assert.deepEqual(after(store, "T-1", "T-3"), { ok: false, error: "conflict" });
  assert.deepEqual(metaAfterRows(directory), rows);
  // Replacing a list is no loop: T-3 may run after T-1 instead of T-2.
  assert.equal(after(store, "T-3", "T-1").ok, true);
});

test("a task that has started takes no list; the task it runs after may be in any state", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  startedTask(directory, 1, { session: "claude:s-1" });
  assert.deepEqual(after(store, "T-1", "T-2"), { ok: false, error: "conflict" });
  updateTask(directory, 3, { state: "done" });
  assert.equal(after(store, "T-2", "T-1", "T-3").ok, true);
});

test("the queue passes a task that waits for an unfinished task, and starts it at its place once that task is Done", async (context) => {
  const { store, directory } = await withTasks(context, 4);
  // T-4 is in Backlog and not queued; T-1 runs after it.
  for (const id of ["T-1", "T-2", "T-3"]) queueTask(store, id);
  assert.equal(after(store, "T-1", "T-4").ok, true);
  queueSettings(store, true);
  const board = store.readBoard(REPOSITORY, { resolveGateFacts: passingGates });
  assert.deepEqual(board.queue.order, ["T-2", "T-3"]);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [{ repositoryId: REPOSITORY, taskId: "T-2" }]);
  const wait = board.queue.waits.find((entry) => entry.taskId === "T-1");
  assert.deepEqual(wait, { taskId: "T-1", place: null, reasons: [because("runs_after", ["T-4"])] });
  // Review is not enough: only Done frees it.
  updateTask(directory, 4, { state: "needs_review" });
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-2", "T-3"]);
  updateTask(directory, 4, { state: "done" });
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-1", "T-2", "T-3"]);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [{ repositoryId: REPOSITORY, taskId: "T-1" }]);
});

test("a manual start of a task that waits for an unfinished task is held", async (context) => {
  const { store, directory } = await withTasks(context, 2);
  assert.equal(after(store, "T-2", "T-1").ok, true);
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates), { ok: false, error: "gate_held" });
  updateTask(directory, 1, { state: "done" });
  assert.equal(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates).ok, true);
});

test("moving a dependency to Done releases board waits and starts only after every dependency is Done or deleted", async (context) => {
  const { store, directory } = await withTasks(context, 4);
  queueTask(store, "T-2");
  queueTask(store, "T-3");
  assert.equal(after(store, "T-2", "T-1", "T-4").ok, true);
  queueSettings(store, true);
  startedTask(directory, 1, { session: "claude:dependency" });
  assert.equal(store.completeTask({ sessionId: "claude:dependency" }, () => null).state, "needs_review");
  const read = () => store.readBoard(REPOSITORY, { resolveGateFacts: passingGates });
  const before = read();
  const readyCards = (board) => board.tasks.filter((task) => task.columnId === board.columns[1].id).map(({ id, position }) => ({ id, position }));
  const done = before.columns.find((column) => column.role === "done");
  assert.equal(taskOf(before, "T-1").state, "needs_review");
  assert.deepEqual(before.queue.order, ["T-3"]);
  assert.deepEqual(before.queue.waits.find((wait) => wait.taskId === "T-2").reasons, [because("runs_after", ["T-1", "T-4"])]);
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates), { ok: false, error: "gate_held" });

  assert.equal(store.apply(REPOSITORY, "move", { id: "T-1", columnId: done.id, position: 0 }).ok, true);
  const partlyDone = read();
  assert.equal(taskOf(partlyDone, "T-1").state, "done");
  assert.equal(taskOf(partlyDone, "T-1").report.at, taskOf(before, "T-1").report.at);
  assert.deepEqual(partlyDone.queue.order, ["T-3"]);
  assert.deepEqual(partlyDone.queue.waits.find((wait) => wait.taskId === "T-2").reasons, [because("runs_after", ["T-4"])]);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [{ repositoryId: REPOSITORY, taskId: "T-3" }]);
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates), { ok: false, error: "gate_held" });

  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-4" }).ok, true);
  const freed = read();
  assert.deepEqual(freed.queue.order, ["T-2", "T-3"]);
  assert.deepEqual(freed.queue.waits.find((wait) => wait.taskId === "T-2"), { taskId: "T-2", place: 1, reasons: [] });
  assert.equal(freed.queue.gates.next.taskId, "T-2");
  assert.deepEqual(readyCards(freed), readyCards(before));
  assert.equal(freed.queue.status, "running");
  // Completion removes only the dependency hold; the other start gates still apply.
  const dirty = () => ({ ...GATE_FACTS, treeClean: false });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: dirty }).starts, []);
  assert.deepEqual(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, dirty), { ok: false, error: "tree_dirty" });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts, [{ repositoryId: REPOSITORY, taskId: "T-2" }]);
  assert.equal(store.planStart(REPOSITORY, { id: "T-2" }, () => FACTS, passingGates).ok, true);
});

test("a Not queued card explicitly moved to Done is completed, including an old unfinished card already in Done", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  const board = store.readBoard(REPOSITORY);
  const done = board.columns.find((column) => column.role === "done");
  // Reproduce the screenshot's old stored combination: Done column, Not queued state.
  updateTask(directory, 1, { column_id: done.id, position: 0 });
  queueTask(store, "T-2");
  assert.equal(after(store, "T-2", "T-1").ok, true);
  const before = store.readBoard(REPOSITORY);
  assert.equal(taskOf(before, "T-1").state, "not_queued");
  assert.deepEqual(before.queue.order, []);
  // Reading a column is no acceptance; only the owner's explicit move completes it.
  const accepted = store.apply(REPOSITORY, "move", { id: "T-1", columnId: done.id, position: 0 });
  assert.equal(accepted.ok, true);
  assert.equal(taskOf(accepted.board, "T-1").state, "done");
  assert.equal(taskOf(accepted.board, "T-1").report, null);
  assert.deepEqual(accepted.board.queue.order, ["T-2"]);
  // A new Not queued card also becomes Done when it first enters the column.
  const moved = store.apply(REPOSITORY, "move", { id: "T-3", columnId: done.id, position: 0 });
  assert.equal(moved.ok, true);
  assert.equal(taskOf(moved.board, "T-3").state, "done");
  assert.deepEqual(moved.board.tasks.filter((task) => task.columnId === done.id).map((task) => task.id), ["T-3", "T-1"]);
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-3", columnId: done.id, position: 0 }).board, moved.board);
});

test("deleting a task frees every task that ran after it, in the same write, and drops its own list", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  assert.equal(after(store, "T-2", "T-1").ok, true);
  assert.equal(after(store, "T-3", "T-1", "T-2").ok, true);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.deepEqual(metaAfterRows(directory), [{ key: `task_after:${REPOSITORY}:T-3`, value: JSON.stringify(["T-2"]) }]);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-3" }).ok, true);
  assert.deepEqual(metaAfterRows(directory), []);
});

test("a stored list outside the contract, or naming a task that is gone, holds nothing", async (context) => {
  const { store, directory } = await withTasks(context, 2);
  withDatabase(directory, (database) => {
    const insert = database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
    insert.run(`task_after:${REPOSITORY}:T-1`, "not json");
    insert.run(`task_after:${REPOSITORY}:T-2`, JSON.stringify(["T-9"]));
  });
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  const board = store.readBoard(REPOSITORY);
  assert.equal(board.readiness, "ready");
  assert.deepEqual(board.queue.order, ["T-1", "T-2"]);
  assert.equal(board.tasks.some((task) => Object.hasOwn(task, "after")), false);
});

test("the pure rule: a waiting task is no candidate and holds nothing, inside a group or not", () => {
  const tasks = [
    { id: "T-1", state: "queued", queuePosition: 0, waitsFor: ["T-9"], group: "grp-aaaaaaaaaaaa" },
    { id: "T-2", state: "queued", queuePosition: 1, group: "grp-aaaaaaaaaaaa" },
    { id: "T-3", state: "queued", queuePosition: 2 },
  ];
  assert.deepEqual(nextQueueStart({ status: "running", tasks }), { starts: ["T-2"] });
  const waits = explainQueueWaits({ status: "running", blockedBy: null, tasks });
  assert.deepEqual(waits[0], { taskId: "T-1", place: null, reasons: [because("runs_after", ["T-9"])] });
  const scheduled = explainQueueWaits({ status: "idle", blockedBy: null, tasks: [{ id: "T-1", state: "scheduled", due: false, waitsFor: ["T-2"] }] });
  assert.deepEqual(scheduled[0].reasons, [because("queue_off"), because("own_schedule"), because("runs_after", ["T-2"])]);
});

test("an existing store opens unchanged: no task runs after another, and no group, task, or queue place changes", async (context) => {
  const { store, directory } = await withTasks(context, 3);
  queueTask(store, "T-1");
  queueTask(store, "T-2");
  assert.equal(store.apply(REPOSITORY, "queue_group", { ids: ["T-1", "T-2"] }).ok, true);
  const before = store.readBoard(REPOSITORY);
  store.close();
  const { openTaskStore } = await import("../../../server/tasks/task-store.mjs");
  const reopened = openTaskStore({ directory, now: () => START_TIME });
  try {
    assert.deepEqual(reopened.readBoard(REPOSITORY), before);
    assert.deepEqual(metaAfterRows(directory), []);
  } finally { reopened.close(); }
});
