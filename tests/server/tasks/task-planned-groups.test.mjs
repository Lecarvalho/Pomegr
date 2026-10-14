import assert from "node:assert/strict";
import test from "node:test";
import { REPOSITORY, SESSION, createTask, openTemporaryStore, passingGates, queueSettings, queueTask, startedTask } from "./queue-test-support.mjs";

// Planning before Ready: parallel groups of cards that are not queued yet, in Backlog or Ready, and how the plan
// becomes the Ready order and groups.

const group = (store, ...ids) => store.apply(REPOSITORY, "queue_group", { ids });
const taskOf = (board, id) => board.tasks.find((task) => task.id === id);
const column = (board, name) => board.columns.find((entry) => entry.name === name);
const cardsIn = (board, name) => board.tasks.filter((task) => task.columnId === column(board, name).id).toSorted((a, b) => a.position - b.position).map((task) => task.id);
const groupsOf = (board) => Object.fromEntries(board.tasks.map((task) => [task.id, task.group === null ? null : task.group.slice(-4)]));
const sameGroup = (board, ...ids) => ids.every((id) => taskOf(board, id).group !== null && taskOf(board, id).group === taskOf(board, ids[0]).group);
const move = (store, id, name, position, extra = {}) => store.apply(REPOSITORY, "move", { id, columnId: column(store.readBoard(REPOSITORY), name).id, position, ...extra });

async function backlog(context, count) {
  const env = await openTemporaryStore(context, "pomegr-task-plan-");
  for (let index = 0; index < count; index += 1) createTask(env.store, REPOSITORY);
  return env;
}

test("cards in Backlog that are not queued make a group, and the group stands together in Backlog", async (context) => {
  const { store } = await backlog(context, 4);
  assert.equal(group(store, "T-1", "T-3").ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.ok(sameGroup(board, "T-1", "T-3"));
  assert.deepEqual(cardsIn(board, "Backlog"), ["T-1", "T-3", "T-2", "T-4"]);
  assert.deepEqual(cardsIn(board, "Ready"), []);
  assert.equal(taskOf(board, "T-1").state, "not_queued");
  assert.deepEqual(board.queue.order, []);
});

test("cards that only sit next to each other make no group", async (context) => {
  const { store } = await backlog(context, 3);
  assert.deepEqual(Object.values(groupsOf(store.readBoard(REPOSITORY))), [null, null, null]);
});

test("Queue group queues every card of the group and keeps the Backlog order as the Ready order", async (context) => {
  const { store } = await backlog(context, 4);
  queueTask(store, "T-4");
  assert.equal(group(store, "T-3", "T-1").ok, true);
  assert.deepEqual(cardsIn(store.readBoard(REPOSITORY), "Backlog"), ["T-2", "T-3", "T-1"]);
  const result = store.apply(REPOSITORY, "queue_add", { id: "T-1", group: "block" });
  assert.equal(result.ok, true);
  assert.deepEqual(cardsIn(result.board, "Ready"), ["T-4", "T-3", "T-1"]);
  assert.deepEqual(cardsIn(result.board, "Backlog"), ["T-2"]);
  assert.ok(sameGroup(result.board, "T-3", "T-1"));
  assert.deepEqual(result.board.queue.order, ["T-4", "T-3", "T-1"]);
  queueSettings(store, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts.map((start) => start.taskId), ["T-4"]);
  assert.deepEqual(store.apply(REPOSITORY, "queue_add", { id: "T-2", group: "block" }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "queue_add", { id: "T-2", group: "block", at: null }), { ok: false, error: "invalid" });
});

test("queueing one member of a plan queues only it and brings the group's cards to Ready beside it", async (context) => {
  const { store } = await backlog(context, 3);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  queueTask(store, "T-2");
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(cardsIn(board, "Ready"), ["T-2", "T-1"]);
  assert.equal(taskOf(board, "T-1").state, "not_queued");
  assert.equal(taskOf(board, "T-2").state, "queued");
  assert.ok(sameGroup(board, "T-1", "T-2"));
  // The queue starts only the queued member: the planned one is no candidate until it is queued.
  queueSettings(store, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }).starts.map((start) => start.taskId), ["T-2"]);
});

test("dragging a planned group's frame to Ready moves the whole group, which stays planned", async (context) => {
  const { store } = await backlog(context, 3);
  assert.equal(group(store, "T-2", "T-3").ok, true);
  const result = move(store, "T-2", "Ready", 0, { group: "block" });
  assert.equal(result.ok, true);
  assert.deepEqual(cardsIn(result.board, "Ready"), ["T-2", "T-3"]);
  assert.deepEqual(cardsIn(result.board, "Backlog"), ["T-1"]);
  assert.ok(sameGroup(result.board, "T-2", "T-3"));
  assert.deepEqual(result.board.queue.order, []);
});

test("a group with a queued member cannot be dragged out of Ready", async (context) => {
  const { store } = await backlog(context, 2);
  queueTask(store, "T-1");
  assert.equal(group(store, "T-1", "T-2").ok, true);
  assert.deepEqual(move(store, "T-2", "Backlog", 0, { group: "block" }), { ok: false, error: "conflict" });
});

test("a planned card dragged out of its frame, or to a column with a role, leaves the group", async (context) => {
  const { store } = await backlog(context, 4);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  const out = move(store, "T-3", "Backlog", 3);
  assert.deepEqual(cardsIn(out.board, "Backlog"), ["T-1", "T-2", "T-4", "T-3"]);
  assert.equal(taskOf(out.board, "T-3").group, null);
  assert.ok(sameGroup(out.board, "T-1", "T-2"));
  const done = move(store, "T-2", "Done", 0);
  assert.equal(taskOf(done.board, "T-2").group, null);
  // A group left with one member is no group.
  assert.equal(taskOf(done.board, "T-1").group, null);
});

test("the plan is editable until a member starts: a started member cannot be taken out", async (context) => {
  const { store, directory } = await backlog(context, 3);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  assert.equal(store.apply(REPOSITORY, "queue_ungroup", { ids: ["T-3"] }).ok, true);
  assert.equal(taskOf(store.readBoard(REPOSITORY), "T-3").group, null);
  queueTask(store, "T-1");
  startedTask(directory, 1, { session: SESSION });
  assert.deepEqual(store.apply(REPOSITORY, "queue_ungroup", { ids: ["T-1"] }), { ok: false, error: "conflict" });
  assert.equal(store.apply(REPOSITORY, "queue_ungroup", { ids: ["T-2"] }).ok, true);
});

test("a planned card started by hand leaves its plan", async (context) => {
  const { store, directory } = await backlog(context, 3);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  startedTask(directory, 1, { session: SESSION });
  const board = store.readBoard(REPOSITORY);
  // The read projects the stored membership only while it counts; the next action prunes it.
  assert.equal(taskOf(board, "T-1").group, null);
  assert.ok(sameGroup(board, "T-2", "T-3"));
});
