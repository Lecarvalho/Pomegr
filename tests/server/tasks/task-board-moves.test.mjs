import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TASK_BOUNDS } from "../../../server/tasks/task-record.mjs";
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
  store.apply(REPOSITORY, "create", { text: "Moves", run: { provider: "claude", model: "opus", effort: "high" }, doneWhen: { checks: ["pr_open"], own: "Judged" } });
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
  const reordered = store.apply(REPOSITORY, "column_reorder", { id: second.id, position: 0 });
  assertDense(reordered.board);
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

test("column_create appends a column, allows duplicate names, trims, and stops at the bound with limit", async (t) => {
  const { store } = await temporaryStore(t);
  const created = store.apply(REPOSITORY, "column_create", { name: "  Blocked  " });
  assert.equal(created.ok, true);
  assert.deepEqual(names(created.board), ["Backlog", "Ready", "In progress", "Review", "Done", "Blocked"]);
  assertDense(created.board);
  assert.match(created.board.columns[5].id, /^col-[0-9a-f]{12}$/u);

  const duplicate = store.apply(REPOSITORY, "column_create", { name: "Blocked" });
  assert.equal(duplicate.ok, true);
  assert.deepEqual(names(duplicate.board).slice(-2), ["Blocked", "Blocked"]);
  assert.equal(new Set(duplicate.board.columns.map((column) => column.id)).size, 7);

  let board = duplicate.board;
  while (board.columns.length < TASK_BOUNDS.columnsPerRepository) {
    const result = store.apply(REPOSITORY, "column_create", { name: `Extra ${board.columns.length}` });
    assert.equal(result.ok, true);
    board = result.board;
  }
  assert.equal(board.columns.length, 12);
  assertDense(board);
  assert.deepEqual(store.apply(REPOSITORY, "column_create", { name: "One too many" }), { ok: false, error: "limit" });
  assert.deepEqual(store.readBoard(REPOSITORY), board);
  // The bound is per repository, and the longest name is valid.
  const other = store.apply(OTHER_REPOSITORY, "column_create", { name: "n".repeat(TASK_BOUNDS.columnNameLength) });
  assert.equal(other.ok, true);
  assert.equal(other.board.columns.length, 6);
  // Deleting a column makes room again.
  assert.equal(store.apply(REPOSITORY, "column_delete", { id: board.columns.at(-1).id }).ok, true);
  assert.equal(store.apply(REPOSITORY, "column_create", { name: "Room again" }).ok, true);
});

test("column_create seeds a repository that was never read, and rejects malformed names", async (t) => {
  const { store } = await temporaryStore(t);
  const invalid = [undefined, null, "Blocked", [], {}, { name: "" }, { name: "   " }, { name: 5 }, { name: null }, { name: ["x"] }, { name: "n".repeat(TASK_BOUNDS.columnNameLength + 1) },
    { name: "two\nlines" }, { name: "tab\there" }, { name: "bad \ud800 surrogate" }, { name: "Ok", position: 0 }, { name: "Ok", id: `col-${"a".repeat(12)}` }];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "column_create", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  // The rejections seeded nothing, so the first valid create still builds the default board plus one.
  const created = store.apply(REPOSITORY, "column_create", { name: "Blocked" });
  assert.deepEqual(names(created.board), ["Backlog", "Ready", "In progress", "Review", "Done", "Blocked"]);
});

test("column_rename changes one name and nothing else, and refuses unknown, foreign, and malformed input", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, second] = board.columns;
  const renamed = store.apply(REPOSITORY, "column_rename", { id: second.id, name: "  Doing  " });
  assert.equal(renamed.ok, true);
  assert.deepEqual(names(renamed.board), ["Backlog", "Doing", "In progress", "Review", "Done"]);
  assert.deepEqual({ ...renamed.board, columns: board.columns }, board);
  // A name that another column already has is allowed.
  assert.equal(store.apply(REPOSITORY, "column_rename", { id: first.id, name: "Doing" }).ok, true);

  assert.deepEqual(store.apply(REPOSITORY, "column_rename", { id: UNKNOWN_COLUMN, name: "x" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "column_rename", { id: second.id, name: "Foreign" }), { ok: false, error: "not_found" });
  const invalid = [undefined, null, [], {}, { id: second.id }, { name: "x" }, { id: second.id, name: "" }, { id: second.id, name: "n".repeat(TASK_BOUNDS.columnNameLength + 1) },
    { id: second.id, name: "a\nb" }, { id: second.id, name: 7 }, { id: "col-nope", name: "x" }, { id: 7, name: "x" }, { id: second.id, name: "x", position: 0 }];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "column_rename", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(names(store.readBoard(REPOSITORY)).slice(0, 2), ["Doing", "Doing"]);
  assert.equal(store.readBoard(OTHER_REPOSITORY).columns.some((column) => column.name === "Foreign"), false);
});

test("column_reorder moves one column to a 0-based index, clamps to last, keeps positions dense, and leaves tasks alone", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [backlog, ready, progress, review, done] = board.columns;
  const reorder = (id, position) => {
    const result = store.apply(REPOSITORY, "column_reorder", { id, position });
    assert.equal(result.ok, true);
    assertDense(result.board);
    // Tasks keep their column and position; the list is ordered by column, so compare by ID.
    assert.deepEqual(result.board.tasks.toSorted((a, b) => a.id.localeCompare(b.id)), board.tasks.toSorted((a, b) => a.id.localeCompare(b.id)));
    return names(result.board);
  };
  assert.deepEqual(reorder(done.id, 0), ["Done", "Backlog", "Ready", "In progress", "Review"]);
  assert.deepEqual(reorder(done.id, 4), ["Backlog", "Ready", "In progress", "Review", "Done"]);
  assert.deepEqual(reorder(backlog.id, 2), ["Ready", "In progress", "Backlog", "Review", "Done"]);
  assert.deepEqual(reorder(review.id, 1), ["Ready", "Review", "In progress", "Backlog", "Done"]);
  assert.deepEqual(reorder(ready.id, 99), ["Review", "In progress", "Backlog", "Done", "Ready"]);
  assert.deepEqual(reorder(progress.id, Number.MAX_SAFE_INTEGER), ["Review", "Backlog", "Done", "Ready", "In progress"]);
  // Dropping a column where it is changes nothing.
  assert.deepEqual(reorder(progress.id, 4), ["Review", "Backlog", "Done", "Ready", "In progress"]);

  // The first column is whichever sits at position 0, so new tasks follow a reorder.
  const created = store.apply(REPOSITORY, "create", { text: "lands in the new first column" });
  assert.equal(created.board.tasks.find((task) => task.id === "T-5").columnId, review.id);
  // The order survives a restart.
  assert.deepEqual(names(store.readBoard(REPOSITORY)), ["Review", "Backlog", "Done", "Ready", "In progress"]);
});

test("column_reorder refuses unknown, foreign, and malformed input and writes nothing", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, second] = board.columns;
  assert.deepEqual(store.apply(REPOSITORY, "column_reorder", { id: UNKNOWN_COLUMN, position: 0 }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "column_reorder", { id: first.id, position: 0 }), { ok: false, error: "not_found" });
  const invalid = [undefined, null, [], {}, { id: first.id }, { position: 0 }, { id: first.id, position: -1 }, { id: first.id, position: 0.5 }, { id: first.id, position: "1" },
    { id: first.id, position: null }, { id: first.id, position: Number.NaN }, { id: "col-nope", position: 0 }, { id: 4, position: 0 }, { id: second.id, position: 0, name: "x" }];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "column_reorder", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.readBoard(REPOSITORY), board);
});

test("column_delete removes an empty column, closes the gap, and refuses a column with tasks or the last column", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, second, third, fourth, fifth] = board.columns;
  assert.deepEqual([ids(board, first.id).length, ids(board, second.id).length], [3, 1]);

  // Tasks keep a column in place, wherever it sits.
  assert.deepEqual(store.apply(REPOSITORY, "column_delete", { id: first.id }), { ok: false, error: "conflict" });
  assert.deepEqual(store.apply(REPOSITORY, "column_delete", { id: second.id }), { ok: false, error: "conflict" });
  assert.deepEqual(store.readBoard(REPOSITORY), board);

  const removed = store.apply(REPOSITORY, "column_delete", { id: third.id });
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.board.columns.map((column) => [column.name, column.position]), [["Backlog", 0], ["Ready", 1], ["Review", 2], ["Done", 3]]);
  assert.deepEqual(removed.board.tasks, board.tasks);
  assert.equal(store.apply(REPOSITORY, "column_delete", { id: third.id }).error, "not_found");

  // Emptying a column by moving its cards out lets it go.
  for (const id of ids(removed.board, first.id)) assert.equal(store.apply(REPOSITORY, "move", { id, columnId: second.id, position: 0 }).ok, true);
  assert.equal(store.apply(REPOSITORY, "column_delete", { id: first.id }).ok, true);
  assert.equal(store.apply(REPOSITORY, "column_delete", { id: fourth.id }).ok, true);
  assert.equal(store.apply(REPOSITORY, "column_delete", { id: fifth.id }).ok, true);
  const last = store.readBoard(REPOSITORY);
  assert.deepEqual(names(last), ["Ready"]);
  assertDense(last);

  // The last column stays, even though it holds tasks and even once it is empty.
  assert.deepEqual(store.apply(REPOSITORY, "column_delete", { id: second.id }), { ok: false, error: "conflict" });
  for (const task of last.tasks) store.apply(REPOSITORY, "delete", { id: task.id });
  assert.deepEqual(store.apply(REPOSITORY, "column_delete", { id: second.id }), { ok: false, error: "conflict" });
  assert.equal(store.readBoard(REPOSITORY).columns.length, 1);
  // A new task still lands in it, and a repository with a single column is not seeded again.
  assert.equal(store.apply(REPOSITORY, "create", { text: "still has a home" }).board.tasks[0].columnId, second.id);
});

test("column_delete refuses unknown, foreign, and malformed input and writes nothing", async (t) => {
  const { store } = await temporaryStore(t);
  const board = seededBoard(store);
  const [first, , , , fifth] = board.columns;
  store.apply(OTHER_REPOSITORY, "create", { text: "foreign" });
  assert.deepEqual(store.apply(REPOSITORY, "column_delete", { id: UNKNOWN_COLUMN }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "column_delete", { id: fifth.id }), { ok: false, error: "not_found" });
  const invalid = [undefined, null, [], {}, { id: "" }, { id: "col-nope" }, { id: 5 }, { id: fifth.id, name: "x" }, { id: first.id, position: 0 }, { column: fifth.id }];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "column_delete", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.readBoard(REPOSITORY), board);
  assert.equal(store.readBoard(OTHER_REPOSITORY).columns.length, 5);
});

test("a long run of mixed moves and column changes keeps every position dense and survives a restart", async (t) => {
  const { store, directory } = await temporaryStore(t);
  for (let index = 0; index < 12; index += 1) store.apply(REPOSITORY, "create", { text: `task ${index}` });
  store.apply(REPOSITORY, "column_create", { name: "Extra" });
  let board = store.readBoard(REPOSITORY);
  // A deterministic walk: every step is a move or a column reorder.
  for (let step = 1; step <= 60; step += 1) {
    const column = board.columns[(step * 5) % board.columns.length];
    const task = board.tasks[(step * 7) % board.tasks.length];
    const result = step % 6 === 0
      ? store.apply(REPOSITORY, "column_reorder", { id: column.id, position: step % 8 })
      : store.apply(REPOSITORY, "move", { id: task.id, columnId: column.id, position: step % 5 });
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
