import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { removeDirectory } from "./queue-test-support.mjs";

// A store written while columns were the user's is brought to the five fixed columns on first touch
// (docs/internal/architecture/tasks.md, "Columns and card moves"). Old shapes are built directly with SQL.

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const FIVE = ["Backlog", "Ready", "In progress", "Review", "Done"];
const ROLE_SLOTS = { in_progress: 2, review: 3, done: 4 };
const id = (n) => `col-${n.toString(16).padStart(12, "0")}`;

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-migration-"));
  const databasePath = path.join(directory, "tasks.sqlite");
  const opened = [];
  context.after(async () => { for (const store of opened) store.close(); await removeDirectory(directory); });
  const open = () => { const store = openTaskStore({ directory }); opened.push(store); return store; };
  return { directory, databasePath, open };
}

function rawDatabase(databasePath, work) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return work(database);
  } finally {
    database.close();
  }
}

function insertTask(database, columnId, number, position) {
  const row = {
    repository_id: REPOSITORY, number, text: `task ${number}`, column_id: columnId, position,
    feature_id: null, step: null, run_provider: null, run_model: null, run_effort: null, checks: "[]",
    own_condition: null, state: "not_queued", scheduled_at: null, queue_position: null, session_id: null,
    dispatch_token: null, report_at: null, report_results: null, report_block_reason: null,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_000_000 + number,
  };
  const names = Object.keys(row);
  database.prepare(`INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name]));
}

/**
 * Replaces the seeded board with `columns` (`[id, name, position, role?]`) and `tasks` (`[number, columnId, position]`),
 * the shape an older build could have left behind. The store is created and closed first so the tables exist.
 */
async function oldStore(context, columns, tasks) {
  const env = await setup(context);
  const seeding = env.open();
  seeding.readBoard(REPOSITORY);
  seeding.close();
  rawDatabase(env.databasePath, (database) => {
    database.exec("DELETE FROM tasks; DELETE FROM columns; DELETE FROM meta WHERE key LIKE 'column_role:%'");
    for (const [columnId, name, position, role] of columns) {
      database.prepare("INSERT INTO columns (id, repository_id, name, position) VALUES (?, ?, ?, ?)").run(columnId, REPOSITORY, name, position);
      if (role) database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`column_role:${REPOSITORY}:${role}`, columnId);
    }
    for (const [number, columnId, position] of tasks) insertTask(database, columnId, number, position);
  });
  return env;
}

/** The standard five with these IDs: 1..5 (Backlog..Done), roles on 3..5. */
const standard = () => FIVE.map((name, index) => [id(index + 1), name, index, ["in_progress", "review", "done"][index - 2]]);

const taskRows = (databasePath) => rawDatabase(databasePath, (database) =>
  database.prepare("SELECT number, column_id, position, text, state, updated_at, session_id, feature_id FROM tasks ORDER BY number").all().map((row) => ({ ...row })));
const columnRows = (databasePath) => rawDatabase(databasePath, (database) =>
  database.prepare("SELECT id, name, position FROM columns ORDER BY id").all().map((row) => ({ ...row })));

/** Every task survives and sits in an existing column; the five columns are fixed, dense, and carry their roles. */
function assertSound(board, expectedCount) {
  assert.equal(board.readiness, "ready");
  assert.equal(board.tasks.length, expectedCount);
  const columnIds = new Set(board.columns.map((column) => column.id));
  assert.equal(board.tasks.every((task) => columnIds.has(task.columnId)), true);
  assert.deepEqual(board.columns.map((column) => column.name), FIVE);
  assert.deepEqual(board.columns.map((column) => column.position), [0, 1, 2, 3, 4]);
  assert.deepEqual(board.columns.map((column) => column.role), [null, null, "in_progress", "review", "done"]);
  for (const column of board.columns) {
    const positions = board.tasks.filter((task) => task.columnId === column.id).map((task) => task.position);
    assert.deepEqual(positions, positions.map((_, index) => index), `${column.name} positions are dense`);
  }
}
const idsIn = (board, name) => board.tasks.filter((task) => task.columnId === board.columns.find((column) => column.name === name).id).map((task) => task.id);

test("a custom column empties into Backlog after Backlog's own tasks, order kept, and its row goes", async (context) => {
  const env = await oldStore(context, [...standard(), [id(6), "Ideas", 5], [id(7), "Parked", 6]],
    [[1, id(1), 0], [2, id(6), 1], [3, id(6), 0], [4, id(7), 0], [5, id(4), 0], [6, id(1), 1]]);
  const before = taskRows(env.databasePath);
  const board = env.open().readBoard(REPOSITORY);
  assertSound(board, 6);
  assert.deepEqual(idsIn(board, "Backlog"), ["T-1", "T-6", "T-3", "T-2", "T-4"]);
  assert.deepEqual(idsIn(board, "Review"), ["T-5"]);
  assert.deepEqual(board.columns.map((column) => column.id), [1, 2, 3, 4, 5].map(id));
  // Nothing but column and position changed, and no update time.
  const after = taskRows(env.databasePath);
  assert.deepEqual(after.map(({ column_id, position, ...rest }) => rest), before.map(({ column_id, position, ...rest }) => rest));
  assert.equal(columnRows(env.databasePath).length, 5);
});

test("a renamed column that held a role is kept by role and renamed back", async (context) => {
  const columns = standard();
  columns[4] = [id(5), "Shipped", 4, "done"];
  columns[3] = [id(4), "QA", 3, "review"];
  const env = await oldStore(context, columns, [[1, id(5), 0], [2, id(4), 0], [3, id(2), 0]]);
  const board = env.open().readBoard(REPOSITORY);
  assertSound(board, 3);
  assert.deepEqual(board.columns.map((column) => column.id), [1, 2, 3, 4, 5].map(id));
  assert.deepEqual([idsIn(board, "Done"), idsIn(board, "Review"), idsIn(board, "Ready")], [["T-1"], ["T-2"], ["T-3"]]);
});

test("reordered columns return to the fixed order and tasks stay in their columns", async (context) => {
  const columns = standard();
  const shuffled = [columns[4], columns[0], columns[3], columns[1], columns[2]].map(([columnId, name, , role], position) => [columnId, name, position, role]);
  const env = await oldStore(context, shuffled, [[1, id(5), 0], [2, id(1), 0], [3, id(3), 0], [4, id(1), 1]]);
  const board = env.open().readBoard(REPOSITORY);
  assertSound(board, 4);
  assert.deepEqual(board.columns.map((column) => column.id), [1, 2, 3, 4, 5].map(id));
  assert.deepEqual([idsIn(board, "Done"), idsIn(board, "Backlog"), idsIn(board, "In progress")], [["T-1"], ["T-2", "T-4"], ["T-3"]]);
});

test("two columns that resolve to the same slot merge into the first, in stored order", async (context) => {
  const columns = [...standard(), [id(6), " ready ", 5], [id(7), "Done", 6]];
  const env = await oldStore(context, columns, [[1, id(2), 0], [2, id(6), 0], [3, id(6), 1], [4, id(7), 0], [5, id(5), 0]]);
  const board = env.open().readBoard(REPOSITORY);
  assertSound(board, 5);
  // The role holder stays Done and the unroled column named Done is merged after it; the second Ready follows the first.
  assert.deepEqual(idsIn(board, "Ready"), ["T-1", "T-2", "T-3"]);
  assert.deepEqual(idsIn(board, "Done"), ["T-5", "T-4"]);
  assert.equal(board.columns[1].id, id(2));
  assert.equal(board.columns[4].id, id(5));
});

test("a missing slot gets a new column, and a column with a role under another name keeps its tasks", async (context) => {
  const env = await oldStore(context, [[id(1), "Todo", 0], [id(2), "Doing", 1, "in_progress"]], [[1, id(1), 0], [2, id(2), 0]]);
  const board = env.open().readBoard(REPOSITORY);
  assertSound(board, 2);
  assert.equal(board.columns[2].id, id(2));
  assert.deepEqual(idsIn(board, "In progress"), ["T-2"]);
  assert.deepEqual(idsIn(board, "Backlog"), ["T-1"]);
  assert.equal(new Set(board.columns.map((column) => column.id)).size, 5);
  assert.equal(board.columns.filter((column) => [1, 2].map(id).includes(column.id)).length, 1);
});

test("a board that already matches is not written", async (context) => {
  const env = await oldStore(context, standard(), [[1, id(1), 0], [2, id(3), 0]]);
  const store = env.open();
  assertSound(store.readBoard(REPOSITORY), 2);
  const observer = new DatabaseSync(env.databasePath);
  try {
    const version = () => observer.prepare("PRAGMA data_version").get().data_version;
    const before = [version(), JSON.stringify(columnRows(env.databasePath)), JSON.stringify(taskRows(env.databasePath))];
    for (let read = 0; read < 3; read += 1) assertSound(store.readBoard(REPOSITORY), 2);
    assert.deepEqual([version(), JSON.stringify(columnRows(env.databasePath)), JSON.stringify(taskRows(env.databasePath))], before);
  } finally {
    observer.close();
  }
});

test("a write action as the first call on an unmigrated repository finds the board already at the five", async (context) => {
  const env = await oldStore(context, [...standard(), [id(6), "Ideas", 5]], [[1, id(6), 0], [2, id(1), 0]]);
  const result = env.open().apply(REPOSITORY, "create", { text: "fresh" });
  assert.equal(result.ok, true);
  assertSound(result.board, 3);
  assert.deepEqual(idsIn(result.board, "Backlog"), ["T-2", "T-1", "T-3"]);

  // The store migrates when it opens, so a rejected write leaves the migrated board as it was.
  const second = await oldStore(context, [...standard(), [id(6), "Ideas", 5]], [[1, id(6), 0]]);
  const store = second.open();
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-9", text: "nope" }), { ok: false, error: "not_found" });
  assert.equal(columnRows(second.databasePath).length, 5);
  assertSound(store.readBoard(REPOSITORY), 1);
});

test("a store that cannot be used, or is over the old read bounds, is never written", async (context) => {
  const garbageEnv = await setup(context);
  const garbage = Buffer.from("not a sqlite database\n".repeat(40));
  await writeFile(garbageEnv.databasePath, garbage);
  const garbageStore = garbageEnv.open();
  assert.equal(garbageStore.readBoard(REPOSITORY).readiness, "unavailable");
  assert.equal(garbageStore.apply(REPOSITORY, "create", { text: "x" }).ok, false);
  garbageStore.close();
  assert.deepEqual(await readFile(garbageEnv.databasePath), garbage);

  const newer = await oldStore(context, [...standard(), [id(6), "Ideas", 5]], [[1, id(6), 0]]);
  rawDatabase(newer.databasePath, (database) => database.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'"));
  const newerBytes = await readFile(newer.databasePath);
  const newerStore = newer.open();
  assert.equal(newerStore.readBoard(REPOSITORY).readiness, "unavailable");
  assert.deepEqual(newerStore.apply(REPOSITORY, "create", { text: "x" }), { ok: false, error: "conflict" });
  newerStore.close();
  assert.deepEqual(await readFile(newer.databasePath), newerBytes);

  const wide = Array.from({ length: 8 }, (_, index) => [id(10 + index), `Extra ${index}`, 5 + index]);
  const many = await oldStore(context, [...standard(), ...wide], [[1, id(10), 0]]);
  const tooLong = await oldStore(context, [...standard(), [id(6), "x".repeat(41), 5]], [[1, id(6), 0]]);
  for (const env of [many, tooLong]) {
    const store = env.open();
    const before = [taskRows(env.databasePath), columnRows(env.databasePath)];
    assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
    assert.equal(store.apply(REPOSITORY, "create", { text: "x" }).ok, false);
    assert.deepEqual([taskRows(env.databasePath), columnRows(env.databasePath)], before);
  }
});

test("the migrated board keeps links and states and survives a restart", async (context) => {
  const env = await oldStore(context, [...standard(), [id(6), "Ideas", 5]], [[1, id(6), 0], [2, id(1), 0]]);
  rawDatabase(env.databasePath, (database) => database.exec("UPDATE tasks SET session_id = 'claude:abc', state = 'needs_review' WHERE number = 1"));
  const first = env.open();
  const board = first.readBoard(REPOSITORY);
  assertSound(board, 2);
  first.close();
  const second = env.open();
  assert.deepEqual(second.readBoard(REPOSITORY).tasks.map((task) => [task.id, task.columnId, task.position]), board.tasks.map((task) => [task.id, task.columnId, task.position]));
  assert.deepEqual(taskRows(env.databasePath).map((row) => [row.number, row.state, row.session_id]), [[1, "needs_review", "claude:abc"], [2, "not_queued", null]]);
});

test("only the three roles are stored and each points at its fixed column", async (context) => {
  const env = await oldStore(context, [[id(1), "Todo", 0]], []);
  const board = env.open().readBoard(REPOSITORY);
  const roles = rawDatabase(env.databasePath, (database) => database.prepare("SELECT key, value FROM meta WHERE key LIKE 'column_role:%' ORDER BY key").all().map((row) => ({ ...row })));
  assert.deepEqual(roles.map((row) => row.key), ["done", "in_progress", "review"].map((role) => `column_role:${REPOSITORY}:${role}`));
  for (const row of roles) assert.equal(row.value, board.columns[ROLE_SLOTS[row.key.split(":").at(-1)]].id);
});

test("opening the store brings a board to the five before any board read, so a role move finds its column", async (context) => {
  // A board from before column roles: the five names, no stored role.
  const env = await oldStore(context, standard().map(([columnId, name, position]) => [columnId, name, position]), [[1, id(2), 0]]);
  env.open();
  const roles = rawDatabase(env.databasePath, (database) =>
    database.prepare("SELECT key, value FROM meta WHERE key LIKE 'column_role:%' ORDER BY key").all().map((row) => ({ ...row })));
  assert.deepEqual(roles, Object.entries(ROLE_SLOTS).map(([role, slot]) => ({ key: `column_role:${REPOSITORY}:${role}`, value: id(slot + 1) }))
    .toSorted((a, b) => a.key.localeCompare(b.key)));
  assert.equal(taskRows(env.databasePath).length, 1);
});

test("a column row outside the stored contract is not repaired: the board stays unavailable and unwritten", async (context) => {
  const env = await oldStore(context, [...standard(), [id(6), "", 5]], [[1, id(6), 0], [2, id(1), 0]]);
  const before = { tasks: taskRows(env.databasePath), columns: columnRows(env.databasePath) };
  const store = env.open();
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.equal(store.apply(REPOSITORY, "create", { text: "new" }).ok, false);
  assert.deepEqual({ tasks: taskRows(env.databasePath), columns: columnRows(env.databasePath) }, before);
});
