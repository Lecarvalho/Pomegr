import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const TASK_KEYS = ["columnId", "createdAt", "doneWhen", "featureId", "id", "images", "position", "report", "run", "scheduledAt", "session", "source", "state", "step", "text", "updatedAt"];
const INVALID_PAYLOADS = [{}, { id: "" }, { id: "T-0" }, { id: "t-1" }, { id: "T-01" }, { id: 1 }, { id: null }, { id: "T-1", extra: true }, null, "T-1", [], 7, undefined];

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-queue-"));
  const store = openTaskStore({ directory });
  t.after(async () => {
    store.close();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { store, databasePath: path.join(directory, "tasks.sqlite") };
}

// No action sets a task's state beyond the queue yet, so a test writes it straight into the file.
function withRawDatabase(databasePath, work) {
  const database = new DatabaseSync(databasePath);
  try { return work(database); } finally { database.close(); }
}
const setState = (databasePath, number, state, repository = REPOSITORY) =>
  withRawDatabase(databasePath, (database) => database.prepare("UPDATE tasks SET state = ? WHERE repository_id = ? AND number = ?").run(state, repository, number));
const storedPositions = (databasePath, repository = REPOSITORY) =>
  withRawDatabase(databasePath, (database) => database.prepare("SELECT number, queue_position FROM tasks WHERE repository_id = ? ORDER BY number").all(repository)
    .map((row) => [Number(row.number), row.queue_position]));
const storedUpdatedAt = (databasePath) =>
  withRawDatabase(databasePath, (database) => Object.fromEntries(database.prepare("SELECT number, updated_at FROM tasks WHERE repository_id = ?").all(REPOSITORY)
    .map((row) => [Number(row.number), Number(row.updated_at)])));
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

function addFeature(store, name, repository = REPOSITORY) {
  const before = new Set(store.readBoard(repository).features.map((feature) => feature.id));
  const result = store.apply(repository, "feature_create", { name });
  assert.equal(result.ok, true, name);
  return result.board.features.find((feature) => !before.has(feature.id)).id;
}
function addTask(store, payload = {}, repository = REPOSITORY) {
  const result = store.apply(repository, "create", { text: "task", ...payload });
  assert.equal(result.ok, true);
  return result.board;
}
const queue = (store, id, repository = REPOSITORY) => store.apply(repository, "queue_add", { id });
const unqueue = (store, id, repository = REPOSITORY) => store.apply(repository, "queue_remove", { id });
const reorder = (store, id, step, repository = REPOSITORY) => store.apply(repository, "queue_reorder", { id, step });
const taskOf = (board, id) => board.tasks.find((task) => task.id === id);
const numberOf = (task) => Number(task.id.slice(2));
const placement = (board, featureId) => board.tasks.filter((task) => task.featureId === featureId).toSorted((a, b) => numberOf(a) - numberOf(b)).map((task) => [task.id, task.step]);
const cardsIn = (board, name) => {
  const column = board.columns.find((candidate) => candidate.name === name);
  return board.tasks.filter((task) => task.columnId === column.id).toSorted((a, b) => a.position - b.position).map((task) => task.id);
};
const move = (store, id, name, position) => store.apply(REPOSITORY, "move", { id, columnId: store.readBoard(REPOSITORY).columns.find((column) => column.name === name).id, position });

/** A feature of four tasks over two steps: T-1 and T-2 in step 1, T-3 in step 2, T-4 in step 3. All queued. */
function queuedFeature(store) {
  const feature = addFeature(store, "Search");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature, step: 1 });
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  for (const id of ["T-4", "T-2", "T-1", "T-3"]) assert.equal(queue(store, id).ok, true);
  return feature;
}

test("queue_add queues a task at the end and lists it in the order", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (let count = 0; count < 3; count += 1) addTask(store);
  const before = storedUpdatedAt(databasePath);
  await pause();
  const first = queue(store, "T-3");
  assert.equal(first.ok, true);
  assert.equal(taskOf(first.board, "T-3").state, "queued");
  assert.deepEqual(first.board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: ["T-3"] });
  const second = queue(store, "T-1");
  assert.deepEqual(second.board.queue.order, ["T-3", "T-1"]);
  // The cards went to Ready as they were queued; no private position is stored.
  assert.deepEqual(cardsIn(second.board, "Ready"), ["T-3", "T-1"]);
  assert.deepEqual(cardsIn(second.board, "Backlog"), ["T-2"]);
  assert.deepEqual(storedPositions(databasePath), [[1, null], [2, null], [3, null]]);
  const after = storedUpdatedAt(databasePath);
  assert.notEqual(after[3], before[3]);
  assert.notEqual(after[1], before[1]);
  assert.equal(after[2], before[2]);
  assert.equal(taskOf(second.board, "T-2").state, "not_queued");
  assert.deepEqual(store.readBoard(REPOSITORY), second.board);
});

test("queue_remove returns a queued task to not queued and lists the rest; its card keeps its place in Ready", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (let count = 0; count < 3; count += 1) addTask(store);
  for (const id of ["T-1", "T-2", "T-3"]) queue(store, id);
  const before = storedUpdatedAt(databasePath);
  await pause();
  const removed = unqueue(store, "T-2");
  assert.equal(removed.ok, true);
  assert.equal(taskOf(removed.board, "T-2").state, "not_queued");
  assert.deepEqual(removed.board.queue.order, ["T-1", "T-3"]);
  assert.deepEqual(cardsIn(removed.board, "Ready"), ["T-1", "T-2", "T-3"]);
  assert.notEqual(storedUpdatedAt(databasePath)[2], before[2]);
  // Queued again, the task runs where its card is.
  assert.deepEqual(queue(store, "T-2").board.queue.order, ["T-1", "T-2", "T-3"]);
  assert.deepEqual(storedPositions(databasePath), [[1, null], [2, null], [3, null]]);
});

test("the order is kept per repository", async (t) => {
  const { store } = await temporaryStore(t);
  addTask(store);
  addTask(store);
  addTask(store, {}, OTHER_REPOSITORY);
  queue(store, "T-2");
  queue(store, "T-1");
  const other = queue(store, "T-1", OTHER_REPOSITORY);
  assert.deepEqual(other.board.queue.order, ["T-1"]);
  assert.deepEqual(cardsIn(other.board, "Ready"), ["T-1"]);
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-2", "T-1"]);
});

test("single queued tasks run in the order they were queued, whatever their numbers", async (t) => {
  const { store } = await temporaryStore(t);
  for (let count = 0; count < 4; count += 1) addTask(store);
  for (const id of ["T-3", "T-1", "T-4"]) queue(store, id);
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-3", "T-1", "T-4"]);
});

test("a task that joins the queue has its card in Ready: last from another column, in place when already there", async (t) => {
  const { store } = await temporaryStore(t);
  for (let count = 0; count < 4; count += 1) addTask(store);
  // T-4 and T-2 wait in Ready by hand, not queued; T-1 is queued from Backlog and lands after them.
  move(store, "T-4", "Ready", 0);
  move(store, "T-2", "Ready", 1);
  let board = queue(store, "T-1").board;
  assert.deepEqual(cardsIn(board, "Ready"), ["T-4", "T-2", "T-1"]);
  assert.deepEqual(cardsIn(board, "Backlog"), ["T-3"]);
  assert.deepEqual(board.tasks.filter((task) => task.columnId === board.columns[0].id).map((task) => task.position), [0]);
  // T-4 is queued where it is: its card is above T-1, so it starts first.
  board = queue(store, "T-4").board;
  assert.deepEqual(cardsIn(board, "Ready"), ["T-4", "T-2", "T-1"]);
  assert.deepEqual(board.queue.order, ["T-4", "T-1"]);
  // A scheduled task is in the queue too.
  board = store.apply(REPOSITORY, "queue_add", { id: "T-3", at: new Date(Date.now() + 3_600_000).toISOString() }).board;
  assert.deepEqual(cardsIn(board, "Ready"), ["T-4", "T-2", "T-1", "T-3"]);
});

test("moving a single queued card inside Ready reorders the queue", async (t) => {
  const { store } = await temporaryStore(t);
  for (let count = 0; count < 3; count += 1) addTask(store);
  for (const id of ["T-1", "T-2", "T-3"]) queue(store, id);
  const moved = move(store, "T-3", "Ready", 0);
  assert.equal(moved.ok, true);
  assert.deepEqual(cardsIn(moved.board, "Ready"), ["T-3", "T-1", "T-2"]);
  assert.deepEqual(moved.board.queue.order, ["T-3", "T-1", "T-2"]);
  assert.deepEqual(store.readBoard(REPOSITORY), moved.board);
});

test("a card that waits in the queue cannot leave Ready; one that left the queue or started can", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (let count = 0; count < 3; count += 1) addTask(store);
  queue(store, "T-1");
  store.apply(REPOSITORY, "queue_add", { id: "T-2", at: new Date(Date.now() + 3_600_000).toISOString() });
  const before = store.readBoard(REPOSITORY);
  for (const name of ["Backlog", "In progress", "Review", "Done"]) {
    assert.deepEqual(move(store, "T-1", name, 0), { ok: false, error: "conflict" }, name);
    assert.deepEqual(move(store, "T-2", name, 0), { ok: false, error: "conflict" }, name);
  }
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  unqueue(store, "T-1");
  assert.deepEqual(cardsIn(move(store, "T-1", "Backlog", 0).board, "Backlog"), ["T-1", "T-3"]);
  // A started task keeps the state `queued` with its session; its card is free.
  withRawDatabase(databasePath, (database) => database.prepare("UPDATE tasks SET state = 'queued', session_id = 'claude:s' WHERE repository_id = ? AND number = 3").run(REPOSITORY));
  assert.equal(move(store, "T-3", "Review", 0).ok, true);
  assert.deepEqual(cardsIn(store.readBoard(REPOSITORY), "Review"), ["T-3"]);
});

test("Ready lists the waiting cards in start order: feature steps first, then single tasks, other cards in place", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  addTask(store);                                  // T-1 single
  addTask(store, { featureId: feature });          // T-2 step 1
  addTask(store, { featureId: feature });          // T-3 step 2
  addTask(store);                                  // T-4 not queued, in Ready by hand
  addTask(store);                                  // T-5 single
  move(store, "T-4", "Ready", 0);
  for (const id of ["T-1", "T-3", "T-5", "T-2"]) queue(store, id);
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.queue.order, ["T-2", "T-3", "T-1", "T-5"]);
  assert.deepEqual(cardsIn(board, "Ready"), ["T-4", "T-2", "T-3", "T-1", "T-5"]);
  // A drop that would put a later step, or a single task, ahead lands in start order instead.
  board = move(store, "T-5", "Ready", 0).board;
  assert.deepEqual(cardsIn(board, "Ready"), ["T-2", "T-4", "T-3", "T-5", "T-1"]);
  assert.deepEqual(board.queue.order, ["T-2", "T-3", "T-5", "T-1"]);
  board = move(store, "T-3", "Ready", 0).board;
  assert.deepEqual(cardsIn(board, "Ready"), ["T-2", "T-3", "T-4", "T-5", "T-1"]);
  // A step change in the Queue view moves the cards with it.
  board = reorder(store, "T-2", 3).board;
  assert.deepEqual(board.queue.order, ["T-3", "T-2", "T-5", "T-1"]);
  assert.deepEqual(cardsIn(board, "Ready"), ["T-3", "T-2", "T-4", "T-5", "T-1"]);
  const waiting = cardsIn(board, "Ready").filter((id) => board.queue.order.includes(id));
  assert.deepEqual(waiting, board.queue.order);
});

test("a store from before the rule keeps its queue order once, with every queued card brought into Ready", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-queue-"));
  let store = openTaskStore({ directory });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }); });
  for (let count = 0; count < 4; count += 1) addTask(store);
  move(store, "T-2", "Ready", 0);
  move(store, "T-4", "Review", 0);
  store.close();
  // What the older build left: queued cards wherever they were, ordered by a stored queue position.
  withRawDatabase(path.join(directory, "tasks.sqlite"), (database) => {
    const write = database.prepare("UPDATE tasks SET state = 'queued', queue_position = ? WHERE repository_id = ? AND number = ?");
    [[4, 0], [1, 1], [2, 2]].forEach(([number, position]) => write.run(position, REPOSITORY, number));
  });
  store = openTaskStore({ directory });
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.queue.order, ["T-4", "T-1", "T-2"]);
  assert.deepEqual(cardsIn(board, "Ready"), ["T-4", "T-1", "T-2"]);
  assert.deepEqual([cardsIn(board, "Backlog"), cardsIn(board, "Review")], [["T-3"], []]);
  assert.deepEqual(storedPositions(path.join(directory, "tasks.sqlite")), [[1, null], [2, null], [3, null], [4, null]]);
  // From then on the card order rules.
  assert.deepEqual(move(store, "T-2", "Ready", 0).board.queue.order, ["T-2", "T-4", "T-1"]);
});

test("feature tasks run by feature, step, and number before single tasks, whenever they were queued", async (t) => {
  const { store } = await temporaryStore(t);
  const first = addFeature(store, "First");
  const second = addFeature(store, "Second");
  addTask(store, { featureId: second });
  addTask(store, {});
  addTask(store, { featureId: first });
  addTask(store, { featureId: first, step: 1 });
  addTask(store, { featureId: second });
  for (const id of ["T-2", "T-5", "T-4", "T-1", "T-3"]) queue(store, id);
  // First: T-3, T-4 (step 1). Second: T-1 (step 1), T-5 (step 2). Then the single T-2.
  assert.deepEqual(store.readBoard(REPOSITORY).queue.order, ["T-3", "T-4", "T-1", "T-5", "T-2"]);
});

test("queue_add and queue_remove answer fixed errors for invalid, unknown, and foreign tasks", async (t) => {
  const { store } = await temporaryStore(t);
  addTask(store);
  queue(store, "T-1");
  addTask(store);
  const before = store.readBoard(REPOSITORY);
  for (const action of ["queue_add", "queue_remove"]) {
    for (const payload of INVALID_PAYLOADS) assert.deepEqual(store.apply(REPOSITORY, action, payload), { ok: false, error: "invalid" }, `${action} ${JSON.stringify(payload)}`);
    assert.deepEqual(store.apply(REPOSITORY, action, { id: "T-1", step: 1 }), { ok: false, error: "invalid" }, action);
    assert.deepEqual(store.apply(REPOSITORY, action, { id: "T-9" }), { ok: false, error: "not_found" }, action);
    assert.deepEqual(store.apply(OTHER_REPOSITORY, action, { id: "T-1" }), { ok: false, error: "not_found" }, action);
  }
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("queue_add refuses a task past the queue or already queued, and queue_remove one that is not waiting in it", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const states = ["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"];
  states.forEach(() => addTask(store));
  states.forEach((state, index) => setState(databasePath, index + 1, state));
  const before = store.readBoard(REPOSITORY);
  states.forEach((state, index) => {
    const id = `T-${index + 1}`;
    if (state !== "not_queued" && state !== "scheduled") assert.deepEqual(queue(store, id), { ok: false, error: "conflict" }, `add ${state}`);
    if (state !== "queued" && state !== "scheduled") assert.deepEqual(unqueue(store, id), { ok: false, error: "conflict" }, `remove ${state}`);
  });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  // The scheduled task has no time of its own here, so it waits for nothing and is in the order.
  assert.deepEqual(before.queue.order, ["T-2", "T-3"]);
});

test("the queue actions leave the stored queue status and its blocker as they are and start nothing", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  addTask(store);
  addTask(store);
  withRawDatabase(databasePath, (database) => database.prepare("UPDATE repositories SET queue_status = 'blocked', queue_blocked_by = 'T-2' WHERE repository_id = ?").run(REPOSITORY));
  assert.deepEqual(queue(store, "T-1").board.queue, { status: "blocked", blockedBy: "T-2", pauseReason: null, order: ["T-1"] });
  assert.deepEqual(unqueue(store, "T-1").board.queue, { status: "blocked", blockedBy: "T-2", pauseReason: null, order: [] });
  for (const task of store.readBoard(REPOSITORY).tasks) assert.deepEqual([task.session, task.report, task.scheduledAt], [null, null, null]);
});

test("queue_reorder moves a queued task to another step and closes the step it leaves", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = queuedFeature(store);
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 1], ["T-3", 2], ["T-4", 3]]);
  const before = storedUpdatedAt(databasePath);
  await pause();
  // T-3 alone in step 2 joins step 1: step 2 empties and the old step 3 becomes step 2.
  const moved = reorder(store, "T-3", 1);
  assert.equal(moved.ok, true);
  assert.deepEqual(placement(moved.board, feature), [["T-1", 1], ["T-2", 1], ["T-3", 1], ["T-4", 2]]);
  assert.deepEqual(moved.board.queue.order, ["T-1", "T-2", "T-3", "T-4"]);
  assert.equal(taskOf(moved.board, "T-3").state, "queued");
  const after = storedUpdatedAt(databasePath);
  assert.notEqual(after[3], before[3]);
  for (const number of [1, 2, 4]) assert.equal(after[number], before[number], `T-${number}`);
});

test("queue_reorder to the highest step plus one makes a new last step", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = queuedFeature(store);
  // T-1 leaves step 1 for a new step 4; T-2 stays alone in step 1, and the steps stay dense.
  const moved = reorder(store, "T-1", 4);
  assert.deepEqual(placement(moved.board, feature), [["T-1", 4], ["T-2", 1], ["T-3", 2], ["T-4", 3]]);
  assert.deepEqual(moved.board.queue.order, ["T-2", "T-3", "T-4", "T-1"]);
  // T-2 is alone in step 1: it leaves for a new step 5, its step disappears, and the others close up.
  const lone = reorder(store, "T-2", 5);
  assert.deepEqual(placement(lone.board, feature), [["T-1", 3], ["T-2", 4], ["T-3", 1], ["T-4", 2]]);
  assert.deepEqual(lone.board.queue.order, ["T-3", "T-4", "T-1", "T-2"]);
  assert.deepEqual(reorder(store, "T-2", 6), { ok: false, error: "invalid" });
});

test("the lone task of the last step moved to a new last step stays where it is and keeps its update time", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = queuedFeature(store);
  const before = store.readBoard(REPOSITORY);
  const updated = storedUpdatedAt(databasePath);
  await pause();
  // T-4 is alone in the last step (3). A new last step (4) would be that same step once the gap closes.
  const same = reorder(store, "T-4", 4);
  assert.equal(same.ok, true);
  assert.deepEqual(same.board, before);
  assert.deepEqual(storedUpdatedAt(databasePath), updated);
  assert.equal(placement(same.board, feature).at(-1)[1], 3);
  // Two tasks in the last step: one leaves for a new last step and it is a real move.
  reorder(store, "T-3", 3);
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 1], ["T-3", 2], ["T-4", 2]]);
  assert.deepEqual(placement(reorder(store, "T-4", 3).board, feature), [["T-1", 1], ["T-2", 1], ["T-3", 2], ["T-4", 3]]);
});

test("a reorder that empties a step renumbers every step densely", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = addFeature(store, "Long");
  for (let count = 0; count < 5; count += 1) addTask(store, { featureId: feature });
  for (let number = 1; number <= 5; number += 1) queue(store, `T-${number}`);
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 2], ["T-3", 3], ["T-4", 4], ["T-5", 5]]);
  // T-2 joins step 4: step 2 empties, so 3, 4, 5 become 2, 3, 4.
  assert.deepEqual(placement(reorder(store, "T-2", 4).board, feature), [["T-1", 1], ["T-2", 3], ["T-3", 2], ["T-4", 3], ["T-5", 4]]);
  // T-4 joins step 1: step 3 still holds T-2, so nothing empties.
  assert.deepEqual(placement(reorder(store, "T-4", 1).board, feature), [["T-1", 1], ["T-2", 3], ["T-3", 2], ["T-4", 1], ["T-5", 4]]);
  // T-5 alone in step 4 goes to step 1: step 4 empties.
  assert.deepEqual(placement(reorder(store, "T-5", 1).board, feature), [["T-1", 1], ["T-2", 3], ["T-3", 2], ["T-4", 1], ["T-5", 1]]);
});

test("moving a queued task to its own step succeeds and changes nothing", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  queuedFeature(store);
  const before = store.readBoard(REPOSITORY);
  const updated = storedUpdatedAt(databasePath);
  await pause();
  const same = reorder(store, "T-1", 1);
  assert.equal(same.ok, true);
  assert.deepEqual(same.board, before);
  assert.deepEqual(storedUpdatedAt(databasePath), updated);
});

test("queue_reorder validates the payload and the step range", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = queuedFeature(store);
  const before = store.readBoard(REPOSITORY);
  for (const payload of [...INVALID_PAYLOADS.filter((candidate) => candidate !== undefined), { id: "T-1" }, { step: 1 }, { id: "T-1", step: 1, extra: 1 }]) {
    assert.deepEqual(store.apply(REPOSITORY, "queue_reorder", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  for (const step of [0, -1, 1.5, "2", null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, undefined]) {
    assert.deepEqual(reorder(store, "T-1", step), { ok: false, error: "invalid" }, String(step));
  }
  // The feature has three steps, so 4 is the new last step and 5 is out of range.
  assert.deepEqual(reorder(store, "T-1", 5), { ok: false, error: "invalid" });
  assert.deepEqual(reorder(store, "T-1", 99), { ok: false, error: "invalid" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  assert.equal(placement(before, feature).length, 4);
});

test("queue_reorder answers not_found for an unknown or foreign task", async (t) => {
  const { store } = await temporaryStore(t);
  queuedFeature(store);
  addTask(store, {}, OTHER_REPOSITORY);
  assert.deepEqual(reorder(store, "T-9", 1), { ok: false, error: "not_found" });
  // T-2 is a queued task of the first repository; the other repository has only T-1.
  assert.deepEqual(reorder(store, "T-2", 1, OTHER_REPOSITORY), { ok: false, error: "not_found" });
  assert.equal(taskOf(store.readBoard(REPOSITORY), "T-2").step, 1);
});

test("queue_reorder refuses a task that is not queued or has no feature", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Search");
  for (let count = 0; count < 3; count += 1) addTask(store, { featureId: feature });
  addTask(store);
  queue(store, "T-1");
  queue(store, "T-4");
  const before = store.readBoard(REPOSITORY);
  // Not queued, and a single task: it runs in the order it was queued and has no step.
  assert.deepEqual(reorder(store, "T-2", 1), { ok: false, error: "conflict" });
  assert.deepEqual(reorder(store, "T-4", 1), { ok: false, error: "conflict" });
  for (const state of ["scheduled", "needs_review", "stalled", "blocked", "done"]) {
    setState(databasePath, 1, state);
    assert.deepEqual(reorder(store, "T-1", 2), { ok: false, error: "conflict" }, state);
  }
  setState(databasePath, 1, "queued");
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("queue_reorder refuses a step whose tasks are all done and accepts one that is only partly done", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = queuedFeature(store);
  // Step 1 holds T-1 and T-2; step 2 holds T-3; step 3 holds T-4.
  setState(databasePath, 3, "done");
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(reorder(store, "T-4", 2), { ok: false, error: "conflict" });
  assert.deepEqual(reorder(store, "T-1", 2), { ok: false, error: "conflict" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  // A step with one task not yet done is open, and a new last step is never done.
  setState(databasePath, 1, "done");
  assert.equal(reorder(store, "T-4", 1).ok, true);
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 1], ["T-3", 2], ["T-4", 1]]);
  assert.equal(reorder(store, "T-4", 3).ok, true);
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 1], ["T-3", 2], ["T-4", 3]]);
});

test("a step that is done refuses a queued task from a later step", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  const feature = addFeature(store, "Two");
  addTask(store, { featureId: feature });
  addTask(store, { featureId: feature });
  queue(store, "T-2");
  setState(databasePath, 1, "done");
  assert.deepEqual(reorder(store, "T-2", 1), { ok: false, error: "conflict" });
  assert.deepEqual(reorder(store, "T-2", 4), { ok: false, error: "invalid" });
  assert.deepEqual(placement(store.readBoard(REPOSITORY), feature), [["T-1", 1], ["T-2", 2]]);
});

test("a deleted task leaves the order, and no action stores a queue position", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (let count = 0; count < 3; count += 1) addTask(store);
  for (const id of ["T-1", "T-2", "T-3"]) queue(store, id);
  unqueue(store, "T-1");
  const deleted = store.apply(REPOSITORY, "delete", { id: "T-2" });
  assert.deepEqual(deleted.board.queue.order, ["T-3"]);
  assert.deepEqual(storedPositions(databasePath), [[1, null], [3, null]]);
});

test("existing actions keep working on queued tasks and never queue or unqueue one", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = queuedFeature(store);
  const [, second] = store.readBoard(REPOSITORY).columns;
  let board = store.apply(REPOSITORY, "update", { id: "T-3", text: "edited" }).board;
  assert.deepEqual([taskOf(board, "T-3").text, taskOf(board, "T-3").state], ["edited", "queued"]);
  board = store.apply(REPOSITORY, "move", { id: "T-3", columnId: second.id, position: 0 }).board;
  assert.deepEqual([taskOf(board, "T-3").columnId, taskOf(board, "T-3").state], [second.id, "queued"]);
  assert.equal(board.queue.order.length, 4);
  // Detaching a queued task makes it a single task, which runs after the feature tasks.
  board = store.apply(REPOSITORY, "update", { id: "T-1", featureId: null }).board;
  assert.deepEqual(board.queue.order, ["T-2", "T-3", "T-4", "T-1"]);
  // Attaching it again at a step puts it back among the feature tasks, by step and number.
  board = store.apply(REPOSITORY, "update", { id: "T-1", featureId: feature, step: 2 }).board;
  assert.deepEqual(board.queue.order, ["T-2", "T-1", "T-3", "T-4"]);
});

test("the served board carries the order as task IDs and no private queue field", async (t) => {
  const { store } = await temporaryStore(t);
  const feature = queuedFeature(store);
  addTask(store);
  queue(store, "T-5");
  unqueue(store, "T-1");
  queue(store, "T-1");
  for (const board of [store.readBoard(REPOSITORY), reorder(store, "T-4", 1).board]) {
    const wire = JSON.parse(JSON.stringify(board));
    assert.deepEqual(Object.keys(wire.queue).toSorted(), ["blockedBy", "order", "pauseReason", "status"]);
    assert.ok(wire.queue.order.every((id) => /^T-[1-9][0-9]*$/u.test(id)));
    assert.equal(new Set(wire.queue.order).size, wire.queue.order.length);
    for (const task of wire.tasks) assert.deepEqual(Object.keys(task).toSorted(), TASK_KEYS);
    const text = JSON.stringify(wire);
    assert.equal(text.includes("queuePosition"), false);
    assert.equal(text.includes("queue_position"), false);
  }
  assert.equal(placement(store.readBoard(REPOSITORY), feature).length, 4);
});
