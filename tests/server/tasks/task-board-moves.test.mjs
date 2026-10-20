import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const UNKNOWN_COLUMN = `col-${"0".repeat(12)}`;

async function temporaryStore(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-moves-"));
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
  return { store, directory, databasePath: path.join(directory, "tasks.sqlite") };
}

// A board with tasks T-1..T-3 in the first column and T-4 in the second, each created through the store.
function seededBoard(store) {
  for (const text of ["a", "b", "c"]) store.apply(REPOSITORY, "create", { text });
  const [first, second] = store.readBoard(REPOSITORY).columns;
  store.apply(REPOSITORY, "move", { id: "T-3", columnId: second.id, position: 0 });
  store.apply(REPOSITORY, "create", { text: "d" });
  store.apply(REPOSITORY, "move", { id: "T-4", columnId: first.id, position: 0 });
  return store.readBoard(REPOSITORY);
}

const ids = (board, columnId) => board.tasks.filter((task) => task.columnId === columnId).map((task) => task.id);
const positions = (board, columnId) => board.tasks.filter((task) => task.columnId === columnId).map((task) => task.position);
const names = (board) => board.columns.map((column) => column.name);

function assertDense(board) {
  assert.deepEqual(board.columns.map((column) => column.position), board.columns.map((_, index) => index));
  for (const column of board.columns) assert.deepEqual(positions(board, column.id), positions(board, column.id).map((_, index) => index), column.name);
}

function withRawDatabase(databasePath, work) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return work(database);
  } finally {
    database.close();
  }
}

test("move reorders within a column, up and down, and clamps a position past the end to an append", async (t) => {
  const { store } = await temporaryStore(t);
  for (const text of ["a", "b", "c", "d"]) store.apply(REPOSITORY, "create", { text });
  const [backlog] = store.readBoard(REPOSITORY).columns;
  const move = (id, position) => {
    const result = store.apply(REPOSITORY, "move", { id, columnId: backlog.id, position });
    assert.equal(result.ok, true);
    assertDense(result.board);
    return ids(result.board, backlog.id);
  };
  assert.deepEqual(move("T-4", 0), ["T-4", "T-1", "T-2", "T-3"]);
  assert.deepEqual(move("T-4", 2), ["T-1", "T-2", "T-4", "T-3"]);
  // The position counts after the card leaves its place: moving T-1 to 1 puts it behind T-2.
  assert.deepEqual(move("T-1", 1), ["T-2", "T-1", "T-4", "T-3"]);
  assert.deepEqual(move("T-2", 3), ["T-1", "T-4", "T-3", "T-2"]);
  assert.deepEqual(move("T-1", 1_000_000), ["T-4", "T-3", "T-2", "T-1"]);
  assert.deepEqual(move("T-2", Number.MAX_SAFE_INTEGER), ["T-4", "T-3", "T-1", "T-2"]);
  assert.deepEqual(move("T-2", 0), ["T-2", "T-4", "T-3", "T-1"]);
});

test("move across columns inserts at the position, clamps, and closes the gap in the source column", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, second, third] = board.columns;
  assert.deepEqual([ids(board, first.id), ids(board, second.id)], [["T-4", "T-1", "T-2"], ["T-3"]]);

  const inserted = store.apply(REPOSITORY, "move", { id: "T-1", columnId: second.id, position: 0 });
  assert.equal(inserted.ok, true);
  assert.deepEqual([ids(inserted.board, first.id), ids(inserted.board, second.id)], [["T-4", "T-2"], ["T-1", "T-3"]]);
  assert.deepEqual(positions(inserted.board, first.id), [0, 1]);
  assert.deepEqual(positions(inserted.board, second.id), [0, 1]);

  const middle = store.apply(REPOSITORY, "move", { id: "T-4", columnId: second.id, position: 1 });
  assert.deepEqual([ids(middle.board, first.id), ids(middle.board, second.id)], [["T-2"], ["T-1", "T-4", "T-3"]]);

  const appended = store.apply(REPOSITORY, "move", { id: "T-2", columnId: second.id, position: 99 });
  assert.deepEqual([ids(appended.board, first.id), ids(appended.board, second.id)], [[], ["T-1", "T-4", "T-3", "T-2"]]);

  // An empty destination accepts only an append, wherever the position points.
  const empty = store.apply(REPOSITORY, "move", { id: "T-3", columnId: third.id, position: 5 });
  assert.deepEqual([ids(empty.board, second.id), ids(empty.board, third.id)], [["T-1", "T-4", "T-2"], ["T-3"]]);
  assertDense(empty.board);
  assert.deepEqual(store.readBoard(REPOSITORY), empty.board);
});

test("move leaves state and every other field untouched except column, position, and update time", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  store.apply(REPOSITORY, "create", { text: "Moves", run: { provider: "claude", model: "opus", effort: "high" }, completeWhen: { checks: ["pr_open"], own: "Judged" } });
  store.apply(REPOSITORY, "create", { text: "Neighbour" });
  const before = store.readBoard(REPOSITORY);
  const [, , , review] = before.columns;
  // A task with a state, a schedule, and a report, written raw because no action reaches them yet.
  withRawDatabase(databasePath, (database) => {
    database.prepare("UPDATE tasks SET state = 'needs_review', scheduled_at = 1700000002000, report_at = 1700000003000, report_results = ?, report_block_reason = 'Waiting' WHERE number = 1")
      .run(JSON.stringify([{ check: "pr_open", passed: false }]));
  });
  const stateful = store.readBoard(REPOSITORY).tasks[0];
  assert.equal(stateful.state, "needs_review");

  const moved = store.apply(REPOSITORY, "move", { id: "T-1", columnId: review.id, position: 0 });
  assert.equal(moved.ok, true);
  const after = moved.board.tasks.find((task) => task.id === "T-1");
  assert.equal(after.columnId, review.id);
  assert.equal(after.position, 0);
  assert.ok(after.updatedAt >= stateful.updatedAt);
  assert.deepEqual({ ...after, columnId: stateful.columnId, position: stateful.position, updatedAt: stateful.updatedAt }, stateful);
  // The card left behind only changed position, because the gap closed.
  const neighbour = moved.board.tasks.find((task) => task.id === "T-2");
  const neighbourBefore = before.tasks.find((task) => task.id === "T-2");
  assert.equal(neighbour.position, 0);
  assert.deepEqual({ ...neighbour, position: neighbourBefore.position }, neighbourBefore);
  assert.deepEqual([moved.board.columns, moved.board.features, moved.board.queue], [before.columns, before.features, before.queue]);
});

test("moving a blocked task to Done retains its report and link, releases its queue hold, and keeps the drop position", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (const text of ["Blocked", "Accepted first", "Accepted last"]) store.apply(REPOSITORY, "create", { text });
  const done = store.readBoard(REPOSITORY).columns.find((column) => column.role === "done");
  for (const id of ["T-2", "T-3"]) assert.equal(store.apply(REPOSITORY, "move", { id, columnId: done.id, position: 99 }).ok, true);
  withRawDatabase(databasePath, (database) => {
    database.prepare("UPDATE tasks SET session_id = ? WHERE number = 1").run("claude:blocked");
  });
  assert.equal(store.blockTask({ sessionId: "claude:blocked", reason: "Needs owner" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "queue_settings", { on: true }).ok, true);
  const before = store.readBoard(REPOSITORY);
  assert.equal(before.queue.status, "blocked");
  const blocked = before.tasks.find((task) => task.id === "T-1");
  const moved = store.apply(REPOSITORY, "move", { id: "T-1", columnId: done.id, position: 1 });
  assert.equal(moved.ok, true);
  const accepted = moved.board.tasks.find((task) => task.id === "T-1");
  assert.equal(accepted.state, "done");
  assert.deepEqual(accepted.report, blocked.report);
  assert.deepEqual(accepted.session, blocked.session);
  assert.deepEqual(ids(moved.board, done.id), ["T-2", "T-1", "T-3"]);
  assertDense(moved.board);
  assert.equal(moved.board.queue.status, "running");
  assert.equal(moved.board.queue.blockedBy, null);
  assert.ok(store.worktreeCleanups().cleanups.some((entry) => entry.taskId === "T-1"));
  assert.deepEqual(store.completeTask({ sessionId: "claude:blocked" }, () => null), { ok: false, error: "already_reported" });
});

test("a group move to Done accepts every moved card in order, while queued cards still cannot leave Ready", async (t) => {
  const { store } = await temporaryStore(t);
  for (const text of ["First", "Second", "Waiting"]) store.apply(REPOSITORY, "create", { text });
  assert.equal(store.apply(REPOSITORY, "queue_group", { ids: ["T-1", "T-2"] }).ok, true);
  const done = store.readBoard(REPOSITORY).columns.find((column) => column.role === "done");
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-3" }).ok, true);
  const before = store.readBoard(REPOSITORY);
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-3", columnId: done.id, position: 0 }), { ok: false, error: "conflict" });
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  const moved = store.apply(REPOSITORY, "move", { id: "T-1", columnId: done.id, position: 0, group: "block" });
  assert.equal(moved.ok, true);
  assert.deepEqual(ids(moved.board, done.id), ["T-1", "T-2"]);
  for (const task of moved.board.tasks.filter((task) => task.columnId === done.id)) {
    assert.equal(task.state, "done");
    assert.equal(task.group, null);
  }
  assert.deepEqual(moved.board.queue.order, ["T-3"]);
  assertDense(moved.board);
});

test("dropping a card where it already is changes nothing, update time included", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first] = board.columns;
  const result = store.apply(REPOSITORY, "move", { id: "T-1", columnId: first.id, position: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board, board);
  // A clamped drop on the last card is also in place.
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-2", columnId: first.id, position: 50 }).board, board);
});

test("move closes a gap left in a column by earlier writes", async (t) => {
  const { store, databasePath } = await temporaryStore(t);
  for (const text of ["a", "b", "c"]) store.apply(REPOSITORY, "create", { text });
  const [first, second] = store.readBoard(REPOSITORY).columns;
  withRawDatabase(databasePath, (database) => {
    database.exec("UPDATE tasks SET position = number * 10");
    database.prepare("UPDATE columns SET position = position * 7").run();
  });
  const moved = store.apply(REPOSITORY, "move", { id: "T-3", columnId: first.id, position: 0 });
  assert.deepEqual(positions(moved.board, first.id), [0, 1, 2]);
  assert.deepEqual(ids(moved.board, first.id), ["T-3", "T-1", "T-2"]);
  // The stray column positions were closed by the fixed five (task-columns.mjs); no task left its column.
  assertDense(moved.board);
  assert.deepEqual(names(moved.board), ["Backlog", "Ready", "In progress", "Review", "Done"]);
  assert.equal(second.id, moved.board.columns[1].id);
});

test("move refuses unknown and foreign tasks and columns with not_found and malformed payloads with invalid, writing nothing", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, second] = board.columns;
  store.apply(OTHER_REPOSITORY, "create", { text: "foreign" });
  const foreign = store.readBoard(OTHER_REPOSITORY);
  const snapshot = store.readBoard(REPOSITORY);

  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-99", columnId: first.id, position: 0 }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-1", columnId: UNKNOWN_COLUMN, position: 0 }), { ok: false, error: "not_found" });
  // A column or task of another repository does not exist here.
  assert.deepEqual(store.apply(REPOSITORY, "move", { id: "T-1", columnId: foreign.columns[0].id, position: 0 }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "move", { id: "T-1", columnId: second.id, position: 0 }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "move", { id: "T-2", columnId: foreign.columns[1].id, position: 0 }), { ok: false, error: "not_found" });

  const valid = { id: "T-1", columnId: second.id, position: 0 };
  const invalid = [undefined, null, "T-1", 7, [], [valid], {}, { ...valid, id: undefined }, { ...valid, columnId: undefined }, { ...valid, position: undefined },
    { ...valid, id: "T-0" }, { ...valid, id: "t-1" }, { ...valid, id: 1 }, { ...valid, id: "T-1; DROP TABLE tasks" },
    { ...valid, columnId: "col-nope" }, { ...valid, columnId: "col-ABCDEF012345" }, { ...valid, columnId: `${second.id}0` }, { ...valid, columnId: 5 },
    { ...valid, position: -1 }, { ...valid, position: 1.5 }, { ...valid, position: "0" }, { ...valid, position: null }, { ...valid, position: Number.NaN },
    { ...valid, position: Number.POSITIVE_INFINITY }, { ...valid, position: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, state: "done" }, { ...valid, step: 1 }, { ...valid, text: "x" }];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "move", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.apply(REPOSITORY, "move", JSON.parse(`{"id":"T-1","columnId":"${second.id}","position":0,"__proto__":{}}`)), { ok: false, error: "invalid" });
  assert.deepEqual(store.readBoard(REPOSITORY), snapshot);
  assert.deepEqual(store.readBoard(OTHER_REPOSITORY), foreign);
});

test("a long run of moves keeps every position dense and survives a restart", async (t) => {
  const { store, directory } = await temporaryStore(t);
  for (let index = 0; index < 12; index += 1) store.apply(REPOSITORY, "create", { text: `task ${index}` });
  let board = store.readBoard(REPOSITORY);
  // A deterministic walk of moves across the five columns.
  for (let step = 1; step <= 60; step += 1) {
    const column = board.columns[(step * 5) % board.columns.length];
    const task = board.tasks[(step * 7) % board.tasks.length];
    const result = store.apply(REPOSITORY, "move", { id: task.id, columnId: column.id, position: step % 5 });
    assert.equal(result.ok, true, `step ${step}`);
    board = result.board;
    assertDense(board);
    assert.equal(board.tasks.length, 12);
  }
  store.close();
  const reopened = openTaskStore({ directory });
  try {
    assert.deepEqual(reopened.readBoard(REPOSITORY), board);
  } finally {
    reopened.close();
  }
});

test("the column actions are gone: each answers unsupported, writes nothing, and the five columns stay fixed", async (t) => {
  const { store } = await temporaryStore(t);
  const before = store.readBoard(REPOSITORY);
  const [backlog] = before.columns;
  for (const action of ["column_create", "column_rename", "column_reorder", "column_delete", "column_role"]) {
    assert.deepEqual(store.apply(REPOSITORY, action, { id: backlog.id, name: "Other", position: 1, role: "done" }), { ok: false, error: "unsupported" }, action);
  }
  assert.deepEqual(store.readBoard(REPOSITORY), before);
  assert.deepEqual(names(before), ["Backlog", "Ready", "In progress", "Review", "Done"]);
});
