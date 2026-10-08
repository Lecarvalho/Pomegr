import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TASK_ACTIONS as ROUTE_ACTIONS } from "../../../server/serving/task-routes.mjs";
import { TASK_ACTIONS, TASK_BOUNDS, TASK_CHECKS } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const IMPLEMENTED = ["create", "update", "delete", "move", "column_create", "column_rename", "column_reorder", "column_delete", "feature_create", "queue_add", "queue_remove", "queue_reorder", "resolve_done", "resolve_requeue"];

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-actions-"));
  const closers = [];
  t.after(async () => {
    for (const closer of closers) {
      try { await closer(); } catch { /* best-effort cleanup */ }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { await rm(directory, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19 || (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });
  return { directory, databasePath: path.join(directory, "tasks.sqlite"), onClose: (closer) => closers.push(closer) };
}

function openStore(temp) {
  const store = openTaskStore({ directory: temp.directory });
  temp.onClose(() => store.close());
  return store;
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

function insertTask(database, repositoryId, columnId, overrides = {}) {
  const row = {
    repository_id: repositoryId, number: 1, text: "Raw task", column_id: columnId, position: 0,
    feature_id: null, step: null, run_provider: null, run_model: null, run_effort: null, checks: "[]",
    own_condition: null, state: "not_queued", scheduled_at: null, queue_position: null, session_id: null,
    dispatch_token: null, report_at: null, report_results: null, report_block_reason: null,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000, ...overrides,
  };
  const names = Object.keys(row);
  database.prepare(`INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name]));
}

const taskCount = (databasePath) => withRawDatabase(databasePath, (database) => database.prepare("SELECT COUNT(*) AS n FROM tasks").get().n);

test("the route's mirrored action list equals the record module's fixed list", () => {
  assert.deepEqual([...ROUTE_ACTIONS], [...TASK_ACTIONS]);
  assert.equal(TASK_ACTIONS.length, 15);
});

test("create lands as the last card of the first column with the next ID and every other field at its default", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const first = store.apply(REPOSITORY, "create", { text: "  Write the release notes  " });
  assert.equal(first.ok, true);
  const [backlog] = first.board.columns;
  assert.equal(first.board.readiness, "ready");
  assert.equal(first.board.tasks.length, 1);
  const [task] = first.board.tasks;
  assert.equal(task.id, "T-1");
  assert.equal(task.text, "Write the release notes");
  assert.equal(task.columnId, backlog.id);
  assert.equal(task.position, 0);
  assert.equal(task.state, "not_queued");
  assert.deepEqual([task.featureId, task.step, task.scheduledAt, task.session, task.report], [null, null, null, null, null]);
  assert.deepEqual(task.run, { provider: null, model: null, effort: null });
  assert.deepEqual(task.doneWhen, { checks: [], own: null });
  assert.equal(task.createdAt, task.updatedAt);

  const second = store.apply(REPOSITORY, "create", { text: "Second\nline two" });
  assert.deepEqual(second.board.tasks.map((item) => [item.id, item.position, item.columnId === backlog.id]), [["T-1", 0, true], ["T-2", 1, true]]);
  assert.equal(second.board.tasks[1].text, "Second\nline two");
  assert.deepEqual(store.readBoard(REPOSITORY), second.board);
});

test("create seeds a repository that was never read and lands in its first column", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const result = store.apply(OTHER_REPOSITORY, "create", { text: "Fresh repository" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board.columns.map((column) => column.name), ["Backlog", "Ready", "In progress", "Review", "Done"]);
  assert.equal(result.board.tasks[0].columnId, result.board.columns[0].id);
});

test("the first column is the one at the lowest position, wherever the columns were reordered", async (t) => {
  const temp = await temporaryDirectory(t);
  const first = openTaskStore({ directory: temp.directory });
  const columns = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(temp.databasePath, (database) => {
    database.prepare("UPDATE columns SET position = 9 WHERE id = ?").run(columns[0].id);
    database.prepare("UPDATE columns SET position = 0 WHERE id = ?").run(columns[3].id);
  });
  const store = openStore(temp);
  const result = store.apply(REPOSITORY, "create", { text: "Into the new first column" });
  assert.equal(result.board.tasks[0].columnId, columns[3].id);
});

test("create with no column to land in is a conflict and writes nothing", async (t) => {
  const temp = await temporaryDirectory(t);
  const first = openTaskStore({ directory: temp.directory });
  first.readBoard(REPOSITORY);
  first.close();
  withRawDatabase(temp.databasePath, (database) => database.exec("DELETE FROM columns"));
  const store = openStore(temp);
  assert.deepEqual(store.apply(REPOSITORY, "create", { text: "Nowhere to go" }), { ok: false, error: "conflict" });
  assert.equal(taskCount(temp.databasePath), 0);
});

test("create rejects invalid text and payload shapes, and a rejection writes nothing", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const invalid = [
    undefined, null, "text", 7, [], [{ text: "x" }], {}, { text: "" }, { text: "   \n\t " }, { text: 5 }, { text: null }, { text: ["x"] },
    { text: "x".repeat(TASK_BOUNDS.textLength + 1) }, { text: `${"x".repeat(100)}\u0000` }, { text: "bad \ud800 surrogate" },
    { text: "ok", id: "T-1" }, { text: "ok", state: "done" }, { text: "ok", run: "claude" }, { text: "ok", run: { provider: "gemini" } },
    { text: "ok", run: { provider: "claude", effort: "max" } }, { text: "ok", run: { provider: "claude", model: "C:\models\opus" } },
    { text: "ok", run: { provider: "claude", model: "x".repeat(TASK_BOUNDS.modelIdentifierLength + 1) } }, { text: "ok", run: { model: "opus" } },
    { text: "ok", run: { provider: "claude", command: "x" } }, { text: "ok", doneWhen: ["pr_open"] }, { text: "ok", doneWhen: { checks: ["tests_pass"] } },
    { text: "ok", doneWhen: { checks: ["pr_open", "pr_open"] } }, { text: "ok", doneWhen: { own: "x".repeat(TASK_BOUNDS.ownConditionLength + 1) } },
    { text: "ok", doneWhen: { checks: [], command: "x" } }, { text: "ok", __proto__: { x: 1 }, constructor: 1 },
  ];
  for (const payload of invalid) {
    assert.deepEqual(store.apply(REPOSITORY, "create", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  }
  assert.deepEqual(store.apply(REPOSITORY, "create", JSON.parse("{\"text\":\"ok\",\"__proto__\":{}}")), { ok: false, error: "invalid" });
  assert.equal(taskCount(temp.databasePath), 0);
  // The bound itself is valid.
  assert.equal(store.apply(REPOSITORY, "create", { text: "x".repeat(TASK_BOUNDS.textLength) }).ok, true);
});

test("the 501st task of a repository is a limit and another repository is unaffected", async (t) => {
  const temp = await temporaryDirectory(t);
  const first = openTaskStore({ directory: temp.directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(temp.databasePath, (database) => {
    database.exec("BEGIN");
    for (let number = 1; number < TASK_BOUNDS.tasksPerRepository; number += 1) insertTask(database, REPOSITORY, backlog.id, { number, position: number - 1 });
    database.exec("COMMIT");
  });
  const store = openStore(temp);
  const last = store.apply(REPOSITORY, "create", { text: "The 500th" });
  assert.equal(last.ok, true);
  assert.equal(last.board.tasks.length, TASK_BOUNDS.tasksPerRepository);
  assert.equal(last.board.tasks.at(-1).id, "T-500");
  assert.deepEqual(store.apply(REPOSITORY, "create", { text: "The 501st" }), { ok: false, error: "limit" });
  assert.equal(taskCount(temp.databasePath), TASK_BOUNDS.tasksPerRepository);
  assert.equal(store.apply(OTHER_REPOSITORY, "create", { text: "Elsewhere" }).ok, true);
  // Deleting one makes room again, and the freed number is not reused.
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-500" }).ok, true);
  const again = store.apply(REPOSITORY, "create", { text: "Room again" });
  assert.equal(again.ok, true);
  assert.equal(again.board.tasks.at(-1).id, "T-501");
});

test("IDs are monotonic per repository, independent across repositories, and never reused after a delete", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const ids = (repositoryId) => store.readBoard(repositoryId).tasks.map((task) => task.id);
  for (const text of ["one", "two", "three"]) store.apply(REPOSITORY, "create", { text });
  store.apply(OTHER_REPOSITORY, "create", { text: "other one" });
  assert.deepEqual(ids(REPOSITORY), ["T-1", "T-2", "T-3"]);
  assert.deepEqual(ids(OTHER_REPOSITORY), ["T-1"]);

  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-3" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "create", { text: "four" }).board.tasks.at(-1).id, "T-4");
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "create", { text: "five" }).board.tasks.at(-1).id, "T-5");
  assert.deepEqual(ids(REPOSITORY), ["T-2", "T-4", "T-5"]);
  assert.deepEqual(ids(OTHER_REPOSITORY), ["T-1"]);

  // Deleting every task still retires the numbers, and the counter survives a restart.
  for (const id of ids(REPOSITORY)) store.apply(REPOSITORY, "delete", { id });
  store.close();
  const reopened = openStore(temp);
  assert.deepEqual(reopened.readBoard(REPOSITORY).tasks, []);
  assert.equal(reopened.apply(REPOSITORY, "create", { text: "six" }).board.tasks[0].id, "T-6");
});

test("a deleted task number stays retired even when it was inserted outside the counter", async (t) => {
  const temp = await temporaryDirectory(t);
  const first = openTaskStore({ directory: temp.directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(temp.databasePath, (database) => insertTask(database, REPOSITORY, backlog.id, { number: 7 }));
  const store = openStore(temp);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-7" }).ok, true);
  assert.equal(store.apply(REPOSITORY, "create", { text: "after the raw one" }).board.tasks[0].id, "T-8");
});

test("create stores the planned run and the done-when conditions, and keeps absent parts null", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const created = store.apply(REPOSITORY, "create", {
    text: "Planned",
    run: { provider: "claude", model: "opus", effort: "high" },
    doneWhen: { checks: ["tree_clean", "pr_open"], own: "  The store rejects a malformed record.  " },
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.board.tasks[0].run, { provider: "claude", model: "opus", effort: "high" });
  // Checks come back in the contract order, and the own condition trimmed.
  assert.deepEqual(created.board.tasks[0].doneWhen, { checks: ["pr_open", "tree_clean"], own: "The store rejects a malformed record." });

  const partial = store.apply(REPOSITORY, "create", { text: "Default model", run: { provider: "codex" }, doneWhen: { own: "   " } }).board.tasks[1];
  assert.deepEqual(partial.run, { provider: "codex", model: null, effort: null });
  assert.deepEqual(partial.doneWhen, { checks: [], own: null });
  const effortOnly = store.apply(REPOSITORY, "create", { text: "Effort only", run: { effort: "xhigh" }, doneWhen: null }).board.tasks[2];
  assert.deepEqual(effortOnly.run, { provider: null, model: null, effort: "xhigh" });
  assert.deepEqual(effortOnly.doneWhen, { checks: [], own: null });
  // The bounds themselves are valid, and the stored values survive a restart.
  const bound = store.apply(REPOSITORY, "create", {
    text: "Bounds", run: { provider: "claude", model: "m".repeat(TASK_BOUNDS.modelIdentifierLength) }, doneWhen: { checks: [...TASK_CHECKS], own: "x".repeat(TASK_BOUNDS.ownConditionLength) },
  });
  assert.equal(bound.ok, true);
  store.close();
  assert.deepEqual(openStore(temp).readBoard(REPOSITORY), bound.board);
});

test("update replaces only the fields it carries and keeps the others, nulls included", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  store.apply(REPOSITORY, "create", { text: "Original", run: { provider: "claude", model: "opus", effort: "high" }, doneWhen: { checks: ["pr_open"], own: "Tests pass." } });
  const fields = (board) => { const { text, run, doneWhen } = board.tasks[0]; return { text, run, doneWhen }; };

  const run = store.apply(REPOSITORY, "update", { id: "T-1", run: { provider: "codex", effort: "low" } });
  assert.deepEqual(fields(run.board), { text: "Original", run: { provider: "codex", model: null, effort: "low" }, doneWhen: { checks: ["pr_open"], own: "Tests pass." } });
  const doneWhen = store.apply(REPOSITORY, "update", { id: "T-1", doneWhen: { checks: ["ci_passed", "tree_clean"] } });
  assert.deepEqual(fields(doneWhen.board), { text: "Original", run: { provider: "codex", model: null, effort: "low" }, doneWhen: { checks: ["tree_clean", "ci_passed"], own: null } });
  const text = store.apply(REPOSITORY, "update", { id: "T-1", text: "Edited" });
  assert.deepEqual(fields(text.board), { text: "Edited", run: { provider: "codex", model: null, effort: "low" }, doneWhen: { checks: ["tree_clean", "ci_passed"], own: null } });
  // A null field clears it; the text is untouched.
  const cleared = store.apply(REPOSITORY, "update", { id: "T-1", run: null, doneWhen: null });
  assert.deepEqual(fields(cleared.board), { text: "Edited", run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null } });
  const all = store.apply(REPOSITORY, "update", { id: "T-1", text: "All", run: { provider: "claude", model: "sonnet" }, doneWhen: { checks: [], own: "Judged" } });
  assert.deepEqual(fields(all.board), { text: "All", run: { provider: "claude", model: "sonnet", effort: null }, doneWhen: { checks: [], own: "Judged" } });

  const bad = [{ id: "T-1", run: { provider: "gemini" } }, { id: "T-1", run: { model: "opus" } }, { id: "T-1", run: { provider: "claude", model: "../opus" } },
    { id: "T-1", run: { effort: "max" } }, { id: "T-1", doneWhen: { checks: ["tests_pass"] } }, { id: "T-1", doneWhen: { own: "x".repeat(TASK_BOUNDS.ownConditionLength + 1) } },
    { id: "T-1", text: null, run: { provider: "claude" } }, { id: "T-1", text: "Fine", run: { provider: "nope" } }];
  for (const payload of bad) assert.deepEqual(store.apply(REPOSITORY, "update", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-9", run: { provider: "claude" } }), { ok: false, error: "not_found" });
  assert.deepEqual(fields(store.readBoard(REPOSITORY)), fields(all.board));
});

test("update changes the text only and answers not_found for an unknown or foreign task", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  store.apply(REPOSITORY, "create", { text: "Original" });
  store.apply(REPOSITORY, "create", { text: "Neighbour" });
  const before = store.readBoard(REPOSITORY);

  const updated = store.apply(REPOSITORY, "update", { id: "T-1", text: "  Edited\ntext  " });
  assert.equal(updated.ok, true);
  const [edited, neighbour] = updated.board.tasks;
  assert.equal(edited.text, "Edited\ntext");
  assert.deepEqual({ ...edited, text: before.tasks[0].text, updatedAt: before.tasks[0].updatedAt }, before.tasks[0]);
  assert.ok(edited.updatedAt >= before.tasks[0].updatedAt);
  assert.deepEqual(neighbour, before.tasks[1]);

  assert.deepEqual(store.apply(REPOSITORY, "update", { id: "T-99", text: "Nobody" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "update", { id: "T-1", text: "Wrong repository" }), { ok: false, error: "not_found" });
  assert.equal(store.readBoard(REPOSITORY).tasks[0].text, "Edited\ntext");
  // The failed updates changed nothing.
  assert.equal(taskCount(temp.databasePath), 2);
});

test("update and delete reject malformed payloads before touching the store", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  store.apply(REPOSITORY, "create", { text: "Keep me" });
  const board = store.readBoard(REPOSITORY);
  const badUpdates = [undefined, null, [], {}, { id: "T-1" }, { text: "no id" }, { id: "T-1", text: "" }, { id: "T-1", text: "x".repeat(4001) },
    { id: "T-0", text: "x" }, { id: "t-1", text: "x" }, { id: "T-01", text: "x" }, { id: "T-1; DROP TABLE tasks", text: "x" }, { id: 1, text: "x" },
    { id: "T-1", text: "x", state: "done" }, { id: "T-1", text: "x", columnId: "col-000000000000" }];
  for (const payload of badUpdates) assert.deepEqual(store.apply(REPOSITORY, "update", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  const badDeletes = [undefined, null, [], {}, { id: "" }, { id: "T-0" }, { id: "T-1x" }, { id: 1 }, { id: "T-1", text: "extra" }];
  for (const payload of badDeletes) assert.deepEqual(store.apply(REPOSITORY, "delete", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.readBoard(REPOSITORY), board);
});

test("delete removes one task, closes the gap in its column, and answers not_found for an unknown or foreign task", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  for (const text of ["a", "b", "c"]) store.apply(REPOSITORY, "create", { text });
  store.apply(OTHER_REPOSITORY, "create", { text: "other" });

  assert.deepEqual(store.apply(REPOSITORY, "delete", { id: "T-9" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "delete", { id: "T-2" }), { ok: false, error: "not_found" });
  assert.equal(store.readBoard(REPOSITORY).tasks.length, 3);

  const deleted = store.apply(REPOSITORY, "delete", { id: "T-2" });
  assert.equal(deleted.ok, true);
  assert.deepEqual(deleted.board.tasks.map((task) => [task.id, task.text, task.position]), [["T-1", "a", 0], ["T-3", "c", 1]]);
  assert.deepEqual(store.apply(REPOSITORY, "delete", { id: "T-2" }), { ok: false, error: "not_found" });
  assert.equal(store.apply(REPOSITORY, "create", { text: "d" }).board.tasks.at(-1).position, 2);
  assert.equal(store.readBoard(OTHER_REPOSITORY).tasks.length, 1);
});

test("a write that would leave an unreadable board is rolled back", async (t) => {
  const temp = await temporaryDirectory(t);
  const first = openTaskStore({ directory: temp.directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(temp.databasePath, (database) => {
    insertTask(database, REPOSITORY, backlog.id, { number: 1, text: "Fine text" });
    insertTask(database, REPOSITORY, backlog.id, { number: 2, text: "x".repeat(4001), position: 1 });
  });
  const store = openStore(temp);
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  for (const [action, payload] of [["create", { text: "Fine text" }], ["update", { id: "T-1", text: "Fine text" }], ["delete", { id: "T-1" }]]) {
    assert.deepEqual(store.apply(REPOSITORY, action, payload), { ok: false, error: "conflict" }, action);
  }
  assert.equal(taskCount(temp.databasePath), 2);
  assert.equal(withRawDatabase(temp.databasePath, (database) => database.prepare("SELECT text FROM tasks WHERE number = 1").get().text), "Fine text");
});

test("the implemented actions leave the remaining listed actions unsupported", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const before = store.readBoard(REPOSITORY);
  for (const action of TASK_ACTIONS.filter((name) => !IMPLEMENTED.includes(name))) {
    assert.deepEqual(store.apply(REPOSITORY, action, { id: "T-1", text: "x" }), { ok: false, error: "unsupported" }, action);
  }
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});
