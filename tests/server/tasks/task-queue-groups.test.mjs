import assert from "node:assert/strict";
import test from "node:test";
import {
  OTHER_REPOSITORY, REPOSITORY, SESSION, START_TIME, createTask, metaValue, openTemporaryStore, queueTask, startedTask, updateTask, withDatabase,
} from "./queue-test-support.mjs";

// The parallel groups of Ready: queue_group, queue_ungroup, and what the other actions do to a group.

const GROUP_ID = /^grp-[0-9a-f]{12}$/u;
const group = (store, ...ids) => store.apply(REPOSITORY, "queue_group", { ids });
const ungroup = (store, ...ids) => store.apply(REPOSITORY, "queue_ungroup", { ids });
const taskOf = (board, id) => board.tasks.find((task) => task.id === id);
const groupsOf = (board) => Object.fromEntries(board.tasks.map((task) => [task.id, task.group === null ? null : "G"]));
const readyColumn = (board) => board.columns.find((column) => column.name === "Ready");
const readyCards = (board) => board.tasks.filter((task) => task.columnId === readyColumn(board).id).toSorted((a, b) => a.position - b.position).map((task) => task.id);
const metaGroupRows = (directory) => withDatabase(directory, (database) => database.prepare("SELECT key, value FROM meta WHERE key LIKE 'task_group:%' ORDER BY key").all().map((row) => ({ ...row })));
const move = (store, id, position, extra = {}) => store.apply(REPOSITORY, "move", { id, columnId: readyColumn(store.readBoard(REPOSITORY)).id, position, ...extra });

/** A temporary store with `count` tasks, all queued in number order, so Ready reads T-1, T-2, ... */
async function queued(context, count) {
  const env = await openTemporaryStore(context, "pomegr-task-groups-");
  for (let index = 0; index < count; index += 1) createTask(env.store, REPOSITORY);
  for (let index = 1; index <= count; index += 1) queueTask(env.store, `T-${index}`);
  return env;
}

test("queue_group makes one group of the listed waiting cards and stands them together after the first", async (context) => {
  const { store, directory } = await queued(context, 4);
  const result = group(store, "T-1", "T-3");
  assert.equal(result.ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": "G", "T-2": null, "T-3": "G", "T-4": null });
  assert.equal(taskOf(board, "T-1").group, taskOf(board, "T-3").group);
  assert.match(taskOf(board, "T-1").group, GROUP_ID);
  assert.deepEqual(readyCards(board), ["T-1", "T-3", "T-2", "T-4"]);
  assert.deepEqual(board.queue.order, ["T-1", "T-3", "T-2", "T-4"]);
  // The group is kept in meta, not on the task row, and holds an opaque ID only.
  assert.deepEqual(metaGroupRows(directory).map((row) => row.key), [`task_group:${REPOSITORY}:T-1`, `task_group:${REPOSITORY}:T-3`]);
  assert.equal(JSON.stringify(board).includes("task_group"), false);
});

test("queue_group validates the payload: two to sixteen distinct task IDs and nothing else", async (context) => {
  const { store } = await queued(context, 3);
  const before = store.readBoard(REPOSITORY);
  const seventeen = Array.from({ length: 17 }, (_, index) => `T-${index + 1}`);
  const invalid = [
    undefined, null, "T-1", [], 7, {}, { ids: "T-1" }, { ids: [] }, { ids: ["T-1"] }, { ids: ["T-1", "T-1"] }, { ids: ["T-1", "T-0"] },
    { ids: ["T-1", "t-2"] }, { ids: ["T-1", 2] }, { ids: ["T-1", "T-2"], extra: true }, { id: "T-1" }, { ids: seventeen },
  ];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "queue_group", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("queue_group answers not_found for an unknown or foreign task and conflict for a card that does not wait", async (context) => {
  const { store, directory } = await queued(context, 3);
  createTask(store, REPOSITORY);
  createTask(store, OTHER_REPOSITORY);
  queueTask(store, "T-1", OTHER_REPOSITORY);
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(group(store, "T-1", "T-9"), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "queue_group", { ids: ["T-1", "T-2"] }), { ok: false, error: "not_found" });
  // T-4 is not queued.
  assert.deepEqual(group(store, "T-1", "T-4"), { ok: false, error: "conflict" });
  assert.deepEqual(group(store, "T-4", "T-1"), { ok: false, error: "conflict" });
  // A card with a linked session, a live dispatch, an outcome, or a stall is not waiting.
  startedTask(directory, 2, { session: SESSION });
  assert.deepEqual(group(store, "T-1", "T-2"), { ok: false, error: "conflict" });
  startedTask(directory, 2, { session: null, mintedAt: START_TIME });
  assert.deepEqual(group(store, "T-1", "T-2"), { ok: false, error: "conflict" });
  startedTask(directory, 2, { session: null });
  for (const state of ["needs_review", "stalled", "blocked", "done"]) {
    updateTask(directory, 2, { state });
    assert.deepEqual(group(store, "T-1", "T-2"), { ok: false, error: "conflict" }, state);
  }
  updateTask(directory, 2, { state: "queued" });
  assert.deepEqual(metaGroupRows(directory), []);
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("queue_group takes a scheduled card, and repeating it changes nothing", async (context) => {
  const { store, directory } = await queued(context, 3);
  assert.equal(store.apply(REPOSITORY, "queue_remove", { id: "T-3" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-3", at: new Date(START_TIME + 3_600_000).toISOString() }).ok, true);
  assert.equal(group(store, "T-1", "T-3").ok, true);
  const once = store.readBoard(REPOSITORY);
  assert.equal(taskOf(once, "T-3").state, "scheduled");
  assert.deepEqual(groupsOf(once), { "T-1": "G", "T-2": null, "T-3": "G" });
  const rows = metaGroupRows(directory);
  assert.equal(group(store, "T-1", "T-3").ok, true);
  assert.equal(group(store, "T-3", "T-1").ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY), once);
  assert.deepEqual(metaGroupRows(directory), rows);
});

test("queue_group joins the group of the first listed card and places the joiners after the group's last card", async (context) => {
  const { store } = await queued(context, 5);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  const first = taskOf(store.readBoard(REPOSITORY), "T-1").group;
  assert.equal(group(store, "T-2", "T-5").ok, true);
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-5", "T-3", "T-4"]);
  assert.deepEqual([taskOf(board, "T-1").group, taskOf(board, "T-2").group, taskOf(board, "T-5").group], [first, first, first]);
  assert.equal(taskOf(board, "T-3").group, null);
  // A first card with no group joins the group of the first listed card that has one: no member is split off.
  assert.equal(group(store, "T-4", "T-1").ok, true);
  board = store.readBoard(REPOSITORY);
  assert.deepEqual(["T-1", "T-2", "T-5", "T-4"].map((id) => taskOf(board, id).group), [first, first, first, first]);
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-5", "T-4", "T-3"]);
});

test("a card above a group whose member started joins that group, so the started member keeps its turn", async (context) => {
  const { store, directory } = await queued(context, 4);
  assert.equal(group(store, "T-2", "T-3", "T-4").ok, true);
  startedTask(directory, 2, { session: SESSION });
  const first = taskOf(store.readBoard(REPOSITORY), "T-2").group;
  assert.equal(group(store, "T-1", "T-3", "T-4").ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(["T-1", "T-2", "T-3", "T-4"].map((id) => taskOf(board, id).group), [first, first, first, first]);
});

test("a group that gives every waiting card to another takes its started members along", async (context) => {
  const { store, directory } = await queued(context, 5);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  assert.equal(group(store, "T-3", "T-4", "T-5").ok, true);
  startedTask(directory, 3, { session: SESSION });
  const first = taskOf(store.readBoard(REPOSITORY), "T-1").group;
  // T-4 and T-5 are every waiting card of the second group; T-3 runs and cannot be listed.
  assert.equal(group(store, "T-1", "T-2", "T-4", "T-5").ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(["T-1", "T-2", "T-3", "T-4", "T-5"].map((id) => taskOf(board, id).group), [first, first, first, first, first]);
});

test("a block move of a group with one waiting card left keeps that card in its group", async (context) => {
  const { store, directory } = await queued(context, 3);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  startedTask(directory, 1, { session: SESSION });
  const first = taskOf(store.readBoard(REPOSITORY), "T-2").group;
  assert.match(first, GROUP_ID);
  assert.equal(move(store, "T-2", 5, { group: "block" }).ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.equal(taskOf(board, "T-2").group, first);
  assert.equal(taskOf(board, "T-1").group, first);
  assert.deepEqual(readyCards(board).filter((id) => id !== "T-1"), ["T-3", "T-2"]);
});

test("queue_group merges two groups when every member is listed", async (context) => {
  const { store } = await queued(context, 5);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  assert.equal(group(store, "T-3", "T-4").ok, true);
  const first = taskOf(store.readBoard(REPOSITORY), "T-1").group;
  assert.equal(group(store, "T-1", "T-2", "T-3", "T-4").ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(["T-1", "T-2", "T-3", "T-4"].map((id) => taskOf(board, id).group), [first, first, first, first]);
  assert.equal(taskOf(board, "T-5").group, null);
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-3", "T-4", "T-5"]);
});

test("queue_group answers limit past sixteen members and changes nothing", async (context) => {
  const { store, directory } = await queued(context, 18);
  const ids = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `T-${from + index}`);
  assert.equal(group(store, ...ids(1, 16)).ok, true);
  const before = store.readBoard(REPOSITORY);
  const rows = metaGroupRows(directory);
  assert.equal(rows.length, 16);
  assert.deepEqual(group(store, "T-1", "T-17"), { ok: false, error: "limit" });
  assert.deepEqual(group(store, "T-17", "T-18").ok, true, "a new group of two is another group");
  assert.deepEqual(group(store, "T-1", "T-18"), { ok: false, error: "limit" });
  assert.deepEqual(store.readBoard(REPOSITORY).tasks.filter((task) => task.group === taskOf(before, "T-1").group).length, 16);
});

test("queue_ungroup lets a card leave its group and keep its place; a group left with one member is no group", async (context) => {
  const { store, directory } = await queued(context, 5);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  const orderBefore = store.readBoard(REPOSITORY).queue.order;
  assert.equal(ungroup(store, "T-3").ok, true);
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": "G", "T-2": "G", "T-3": null, "T-4": null, "T-5": null });
  assert.deepEqual(board.queue.order, orderBefore, "the card keeps its place");
  assert.deepEqual(metaGroupRows(directory).map((row) => row.key), [`task_group:${REPOSITORY}:T-1`, `task_group:${REPOSITORY}:T-2`]);
  // One member left: the group goes with it, in the board and in the file.
  assert.equal(ungroup(store, "T-1").ok, true);
  board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": null, "T-2": null, "T-3": null, "T-4": null, "T-5": null });
  assert.deepEqual(metaGroupRows(directory), []);
});

test("queue_ungroup takes several cards at once, ignores a card in no group, and repeating it changes nothing", async (context) => {
  const { store } = await queued(context, 4);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  const grouped = store.readBoard(REPOSITORY);
  assert.equal(ungroup(store, "T-4").ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY), grouped);
  assert.equal(ungroup(store, "T-1", "T-4", "T-2").ok, true);
  const after = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(after), { "T-1": null, "T-2": null, "T-3": null, "T-4": null });
  assert.equal(ungroup(store, "T-1", "T-2").ok, true);
  assert.deepEqual(store.readBoard(REPOSITORY), after);
});

test("queue_ungroup validates the payload, and answers not_found, and conflict for a member that started", async (context) => {
  const { store, directory } = await queued(context, 3);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  const seventeen = Array.from({ length: 17 }, (_, index) => `T-${index + 1}`);
  for (const payload of [undefined, null, "T-1", [], {}, { ids: [] }, { ids: ["T-1", "T-1"] }, { ids: ["x"] }, { ids: ["T-1"], extra: 1 }, { id: "T-1" }, { ids: seventeen }]) {
    assert.deepEqual(store.apply(REPOSITORY, "queue_ungroup", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  assert.deepEqual(ungroup(store, "T-9"), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "queue_ungroup", { ids: ["T-1"] }), { ok: false, error: "not_found" });
  startedTask(directory, 1, { session: SESSION });
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(ungroup(store, "T-1"), { ok: false, error: "conflict" });
  assert.deepEqual(ungroup(store, "T-2", "T-1"), { ok: false, error: "conflict" }, "nothing is written when one card refuses");
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  // The member that waits can still leave; the one that started is then alone and no group.
  assert.equal(ungroup(store, "T-2").ok, true);
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": null, "T-2": null, "T-3": null });
});

test("move with group block takes the whole group of waiting cards to the position", async (context) => {
  const { store } = await queued(context, 4);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  const { group: id } = taskOf(store.readBoard(REPOSITORY), "T-1");
  // The position counts after the group has left: [T-3, T-4] has room for the block at 1.
  assert.equal(move(store, "T-1", 1, { group: "block" }).ok, true);
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(readyCards(board), ["T-3", "T-1", "T-2", "T-4"]);
  assert.deepEqual([taskOf(board, "T-1").group, taskOf(board, "T-2").group], [id, id]);
  assert.equal(move(store, "T-2", 99, { group: "block" }).ok, true);
  board = store.readBoard(REPOSITORY);
  assert.deepEqual(readyCards(board), ["T-3", "T-4", "T-1", "T-2"]);
  assert.equal(move(store, "T-4", 0, { group: "block" }).ok, true, "a card in no group moves alone");
  assert.deepEqual(readyCards(store.readBoard(REPOSITORY)), ["T-4", "T-3", "T-1", "T-2"]);
});

test("move with group leave takes the card out of its group and lands it at the position", async (context) => {
  const { store } = await queued(context, 4);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  assert.equal(move(store, "T-1", 0, { group: "leave" }).ok, true, "even beside a sibling");
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": null, "T-2": "G", "T-3": "G", "T-4": null });
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-3", "T-4"]);
  // Leaving a group of two dissolves it.
  assert.equal(move(store, "T-2", 3, { group: "leave" }).ok, true);
  board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": null, "T-2": null, "T-3": null, "T-4": null });
  assert.deepEqual(readyCards(board), ["T-1", "T-3", "T-4", "T-2"]);
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-1", columnId: readyColumn(board).id, position: 0, group: "all" }), { ok: false, error: "invalid" });
});

test("a plain move away from the siblings leaves the group; one beside a sibling stays", async (context) => {
  const { store } = await queued(context, 5);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  // Beside a sibling, inside the group.
  assert.equal(move(store, "T-3", 0).ok, true);
  let board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": "G", "T-2": "G", "T-3": "G", "T-4": null, "T-5": null });
  assert.deepEqual(readyCards(board), ["T-3", "T-1", "T-2", "T-4", "T-5"]);
  // Away from every sibling: below the other cards.
  assert.equal(move(store, "T-3", 4).ok, true);
  board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": "G", "T-2": "G", "T-3": null, "T-4": null, "T-5": null });
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-4", "T-5", "T-3"]);
});

test("the waiting cards of a group stand together: a card dropped inside the group lands after it", async (context) => {
  const { store } = await queued(context, 4);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  assert.equal(move(store, "T-4", 1).ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(readyCards(board), ["T-1", "T-2", "T-3", "T-4"]);
  assert.deepEqual(board.queue.order, ["T-1", "T-2", "T-3", "T-4"]);
  assert.equal(taskOf(board, "T-4").group, null);
  // A card queued later joins the end of Ready, not the group.
  createTask(store, REPOSITORY);
  queueTask(store, "T-5");
  assert.deepEqual(readyCards(store.readBoard(REPOSITORY)), ["T-1", "T-2", "T-3", "T-4", "T-5"]);
});

test("queue_remove, delete, and resolve_requeue take the task out of its group", async (context) => {
  const { store, directory } = await queued(context, 6);
  assert.equal(group(store, "T-1", "T-2", "T-3", "T-4").ok, true);
  assert.equal(store.apply(REPOSITORY, "queue_remove", { id: "T-1" }).ok, true);
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": null, "T-2": "G", "T-3": "G", "T-4": "G", "T-5": null, "T-6": null });
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-2" }).ok, true);
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": null, "T-3": "G", "T-4": "G", "T-5": null, "T-6": null });
  assert.deepEqual(metaGroupRows(directory).map((row) => row.key), [`task_group:${REPOSITORY}:T-3`, `task_group:${REPOSITORY}:T-4`]);
  // A started task that stalls and is requeued is an ordinary card, not a member again.
  const stored = taskOf(store.readBoard(REPOSITORY), "T-3").group;
  assert.match(stored, GROUP_ID);
  updateTask(directory, 3, { state: "stalled", session_id: SESSION });
  assert.equal(store.apply(REPOSITORY, "resolve_requeue", { id: "T-3" }).ok, true);
  const board = store.readBoard(REPOSITORY);
  assert.equal(taskOf(board, "T-3").state, "queued");
  assert.deepEqual(groupsOf(board), { "T-1": null, "T-3": null, "T-4": null, "T-5": null, "T-6": null });
  assert.deepEqual(metaGroupRows(directory), []);
});

test("a task that reaches review, a stall, a block, or done is no member, and a group of one is no group", async (context) => {
  const { store, directory } = await queued(context, 4);
  assert.equal(group(store, "T-1", "T-2", "T-3").ok, true);
  updateTask(directory, 1, { state: "needs_review", session_id: SESSION });
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": null, "T-2": "G", "T-3": "G", "T-4": null });
  updateTask(directory, 2, { state: "done" });
  // The board shows the one remaining member as no group before any action prunes the file.
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": null, "T-2": null, "T-3": null, "T-4": null });
  // The next action prunes what no longer counts.
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-4", text: "touch" }).ok, true);
  assert.deepEqual(metaGroupRows(directory), []);
});

test("a started member stays in its group while a sibling is in the queue", async (context) => {
  const { store, directory } = await queued(context, 3);
  assert.equal(group(store, "T-1", "T-2").ok, true);
  startedTask(directory, 1, { session: SESSION });
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(groupsOf(board), { "T-1": "G", "T-2": "G", "T-3": null });
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-3", text: "touch" }).ok, true);
  assert.deepEqual(groupsOf(store.readBoard(REPOSITORY)), { "T-1": "G", "T-2": "G", "T-3": null });
  // A card that waits cannot join a group by listing the one that started first.
  assert.deepEqual(group(store, "T-1", "T-3"), { ok: false, error: "conflict" });
  assert.equal(group(store, "T-2", "T-3").ok, true);
  assert.equal(taskOf(store.readBoard(REPOSITORY), "T-3").group, taskOf(store.readBoard(REPOSITORY), "T-1").group);
});
