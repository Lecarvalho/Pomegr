import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";

const REPOSITORY = `repo-${"a1".repeat(12)}`;
const OTHER_REPOSITORY = `repo-${"b2".repeat(12)}`;
const FEATURE = `feat-${"0".repeat(11)}1`;

// One cleanup hook closes every registered store before it removes the directory, because
// `t.after` hooks run in registration order. Windows can briefly hold a WAL handle after close().
async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-store-"));
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

/** Opens a store that the temporary directory's cleanup closes before it removes the files. */
function openStore(temp, directory = temp.directory) {
  const store = openTaskStore({ directory });
  temp.onClose(() => store.close());
  return store;
}

/** Inserts rows the way a later part's actions will: straight into the documented schema. */
function withRawDatabase(databasePath, work) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    return work(database);
  } finally {
    database.close();
  }
}

function insertRow(database, table, row) {
  const names = Object.keys(row);
  database.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => row[name]));
}

function insertTask(database, repositoryId, columnId, overrides = {}) {
  insertRow(database, "tasks", {
    repository_id: repositoryId, number: 1, text: "Write the release notes", column_id: columnId, position: 0,
    feature_id: null, step: null, run_provider: null, run_model: null, run_effort: null, checks: "[]",
    own_condition: null, state: "not_queued", scheduled_at: null, queue_position: null, session_id: null,
    dispatch_token: null, report_at: null, report_results: null, report_block_reason: null,
    created_at: 1_700_000_000_000, updated_at: 1_700_000_001_000, ...overrides,
  });
}

const BOARD_KEYS = ["columns", "features", "queue", "readiness", "repositoryId", "tasks", "version"];
const COLUMN_KEYS = ["id", "name", "position", "role"];
const FEATURE_KEYS = ["done", "id", "name"];
const TASK_KEYS = ["columnId", "createdAt", "doneWhen", "featureId", "id", "position", "report", "run", "scheduledAt", "session", "state", "step", "text", "updatedAt"];

function keysOf(value) {
  return Object.keys(value).toSorted();
}

const ACTIONS = ["create", "update", "delete", "move", "feature_create",
  "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue"];

test("the first read seeds the five default columns in order and a ready, idle board", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const board = store.readBoard(REPOSITORY);
  assert.equal(board.version, 1);
  assert.equal(board.readiness, "ready");
  assert.equal(board.repositoryId, REPOSITORY);
  assert.deepEqual(board.columns.map((column) => column.name), ["Backlog", "Ready", "In progress", "Review", "Done"]);
  assert.deepEqual(board.columns.map((column) => column.position), [0, 1, 2, 3, 4]);
  assert.equal(new Set(board.columns.map((column) => column.id)).size, 5);
  assert.deepEqual(board.features, []);
  assert.deepEqual(board.tasks, []);
  assert.deepEqual(board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: [] });
});

test("columns are seeded once per repository and keep their IDs across reads and restarts", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const initial = first.readBoard(REPOSITORY);
  assert.deepEqual(first.readBoard(REPOSITORY), initial);
  const other = first.readBoard(OTHER_REPOSITORY);
  assert.equal(other.columns.length, 5);
  assert.equal(other.columns.some((column) => initial.columns.some((known) => known.id === column.id)), false);
  first.close();

  const second = openStore(temp);
  assert.deepEqual(second.readBoard(REPOSITORY), initial);
  second.close();
  const counts = withRawDatabase(databasePath, (database) => ({
    repositories: database.prepare("SELECT COUNT(*) AS n FROM repositories").get().n,
    columns: database.prepare("SELECT COUNT(*) AS n FROM columns").get().n,
  }));
  assert.deepEqual(counts, { repositories: 2, columns: 10 });
});

test("a repository whose columns were all removed gets the five again, with new IDs", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  first.readBoard(REPOSITORY);
  first.close();
  withRawDatabase(databasePath, (database) => database.exec("DELETE FROM columns"));
  const second = openStore(temp);
  const columns = second.readBoard(REPOSITORY).columns;
  assert.deepEqual(columns.map((column) => [column.name, column.position, column.role]),
    [["Backlog", 0, null], ["Ready", 1, null], ["In progress", 2, "in_progress"], ["Review", 3, "review"], ["Done", 4, "done"]]);
});

test("stored tasks, features, and queue state survive close and reopen", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const [backlog, , , , done] = first.readBoard(REPOSITORY).columns;
  first.close();

  withRawDatabase(databasePath, (database) => {
    insertRow(database, "features", { id: FEATURE, repository_id: REPOSITORY, name: "Billing rewrite", created_at: 1_700_000_000_000 });
    insertTask(database, REPOSITORY, backlog.id, {
      number: 1, text: "Add the invoice export\nwith totals", position: 0, feature_id: FEATURE, step: 1,
      run_provider: "codex", run_model: "gpt-5.2-codex", run_effort: "xhigh",
      checks: JSON.stringify(["tree_clean", "pr_open"]), own_condition: "the export is documented",
      state: "needs_review", scheduled_at: 1_700_000_002_000, queue_position: 4, session_id: "session-abc",
      dispatch_token: "secret-dispatch-token",
      report_at: 1_700_000_003_000, report_results: JSON.stringify([{ check: "pr_open", passed: true }, { check: "tree_clean", passed: false }]),
      report_block_reason: null,
    });
    insertTask(database, REPOSITORY, done.id, { number: 2, text: "Archive the old exports", feature_id: FEATURE, step: 2, state: "done" });
    insertTask(database, REPOSITORY, backlog.id, { number: 3, text: "Unrelated chore", position: 1 });
    database.prepare("UPDATE repositories SET queue_status = 'blocked', queue_blocked_by = 'T-1' WHERE repository_id = ?").run(REPOSITORY);
  });

  const second = openStore(temp);
  const board = second.readBoard(REPOSITORY);
  assert.equal(board.readiness, "ready");
  assert.deepEqual(board.queue, { status: "blocked", blockedBy: "T-1", pauseReason: null, order: [] });
  assert.deepEqual(board.features, [{ id: FEATURE, name: "Billing rewrite", done: false }]);
  assert.deepEqual(board.tasks.map((task) => task.id), ["T-1", "T-3", "T-2"]);
  assert.deepEqual(board.tasks[0], {
    id: "T-1", text: "Add the invoice export\nwith totals", columnId: backlog.id, position: 0, featureId: FEATURE, step: 1,
    run: { provider: "codex", model: "gpt-5.2-codex", effort: "xhigh" },
    doneWhen: { checks: ["pr_open", "tree_clean"], own: "the export is documented" },
    state: "needs_review",
    scheduledAt: "2023-11-14T22:13:22.000Z",
    session: { id: "session-abc", title: null, state: "unknown", observedModel: null },
    report: {
      at: "2023-11-14T22:13:23.000Z",
      results: [{ check: "pr_open", passed: true }, { check: "tree_clean", passed: false }],
      blockReason: null,
    },
    createdAt: "2023-11-14T22:13:20.000Z", updatedAt: "2023-11-14T22:13:21.000Z",
  });
  // Another repository sees none of it.
  assert.deepEqual(second.readBoard(OTHER_REPOSITORY).tasks, []);
  second.close();

  const third = openStore(temp);
  assert.deepEqual(third.readBoard(REPOSITORY), board);
});

test("the served board holds only the contract keys and never private store fields", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(databasePath, (database) => {
    insertRow(database, "features", { id: FEATURE, repository_id: REPOSITORY, name: "Billing rewrite", created_at: 1_700_000_000_000 });
    insertTask(database, REPOSITORY, backlog.id, {
      feature_id: FEATURE, step: 1, run_provider: "claude", run_model: "claude-sonnet-4-5", run_effort: "low", queue_position: 7,
      session_id: "session-abc", dispatch_token: "secret-dispatch-token", state: "blocked",
      report_at: 1_700_000_003_000, report_results: "[]", report_block_reason: "needs a decision",
    });
  });
  const store = openStore(temp);
  const wire = JSON.parse(JSON.stringify(store.readBoard(REPOSITORY)));
  assert.deepEqual(keysOf(wire), BOARD_KEYS);
  assert.deepEqual(keysOf(wire.queue), ["blockedBy", "order", "pauseReason", "status"]);
  for (const column of wire.columns) assert.deepEqual(keysOf(column), COLUMN_KEYS);
  for (const feature of wire.features) assert.deepEqual(keysOf(feature), FEATURE_KEYS);
  assert.equal(wire.tasks.length, 1);
  const [task] = wire.tasks;
  assert.deepEqual(keysOf(task), TASK_KEYS);
  assert.deepEqual(keysOf(task.run), ["effort", "model", "provider"]);
  assert.deepEqual(keysOf(task.doneWhen), ["checks", "own"]);
  assert.deepEqual(keysOf(task.session), ["id", "observedModel", "state", "title"]);
  assert.deepEqual(keysOf(task.report), ["at", "blockReason", "results"]);
  assert.equal(JSON.stringify(wire).includes("secret-dispatch-token"), false);
  assert.equal(JSON.stringify(wire).includes("queue_position"), false);

  // The same key sets hold for a board with no tasks and for an unavailable one.
  const empty = JSON.parse(JSON.stringify(store.readBoard(OTHER_REPOSITORY)));
  assert.deepEqual(keysOf(empty), BOARD_KEYS);
  assert.deepEqual(keysOf(JSON.parse(JSON.stringify(store.readBoard("nope")))), BOARD_KEYS);
});

test("a stored board's features are done only when every attached task is done", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  const empty = `feat-${"0".repeat(11)}2`;
  withRawDatabase(databasePath, (database) => {
    insertRow(database, "features", { id: FEATURE, repository_id: REPOSITORY, name: "Finished", created_at: 1 });
    insertRow(database, "features", { id: empty, repository_id: REPOSITORY, name: "Nothing yet", created_at: 2 });
    insertTask(database, REPOSITORY, backlog.id, { number: 1, feature_id: FEATURE, step: 1, state: "done" });
    insertTask(database, REPOSITORY, backlog.id, { number: 2, feature_id: FEATURE, step: 2, state: "done", position: 1 });
  });
  const store = openStore(temp);
  assert.deepEqual(store.readBoard(REPOSITORY).features, [
    { id: FEATURE, name: "Finished", done: true },
    { id: empty, name: "Nothing yet", done: false },
  ]);
});

test("a row outside the contract makes the board unavailable instead of partly served", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(databasePath, (database) => insertTask(database, REPOSITORY, backlog.id, { text: "x".repeat(4001) }));
  const store = openStore(temp);
  const board = store.readBoard(REPOSITORY);
  assert.equal(board.readiness, "unavailable");
  assert.deepEqual([board.columns, board.features, board.tasks], [[], [], []]);
  assert.equal(store.readBoard(OTHER_REPOSITORY).readiness, "ready");
});

test("an invalid repository ID yields an unavailable board with no content and writes nothing", async (t) => {
  const temp = await temporaryDirectory(t);
  const { databasePath } = temp;
  const store = openStore(temp);
  for (const value of ["", "repo-", `repo-${"A".repeat(24)}`, `repo-${"a".repeat(23)}`, `${REPOSITORY}x`, "../tasks", null, undefined, 12, {}]) {
    const board = store.readBoard(value);
    assert.equal(board.readiness, "unavailable", String(value));
    assert.equal(board.repositoryId, "");
    assert.deepEqual([board.columns, board.features, board.tasks], [[], [], []]);
    assert.deepEqual(board.queue, { status: "idle", blockedBy: null, pauseReason: null, order: [] });
    assert.deepEqual(store.apply(value, "create", { text: "x" }), { ok: false, error: "invalid" });
  }
  store.close();
  assert.equal(withRawDatabase(databasePath, (database) => database.prepare("SELECT COUNT(*) AS n FROM repositories").get().n), 0);
});

test("unknown action names answer unsupported and change nothing", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  const before = store.readBoard(REPOSITORY);
  const implemented = ["create", "update", "delete", "move", "feature_create", "queue_add", "queue_remove", "queue_reorder", "queue_settings", "resolve_done", "resolve_requeue"];
  assert.deepEqual(ACTIONS.filter((name) => !implemented.includes(name)), [], "every listed action has a handler");
  for (const action of ["unknown_action", "column_create", "column_rename", "column_reorder", "column_delete", "column_role", "__proto__", "constructor", "", null, 7]) {
    assert.deepEqual(store.apply(REPOSITORY, action, { text: "Ship it" }), { ok: false, error: "unsupported" }, String(action));
  }
  assert.deepEqual(store.readBoard(REPOSITORY), before);
});

test("a malformed store file is never overwritten", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const garbage = Buffer.from("this is not a sqlite database, and the user's tasks might be in here\n".repeat(40));
  await writeFile(databasePath, garbage);
  const store = openTaskStore({ directory });
  for (const repositoryId of [REPOSITORY, OTHER_REPOSITORY]) {
    const board = store.readBoard(repositoryId);
    assert.equal(board.readiness, "unavailable");
    assert.equal(board.repositoryId, repositoryId);
    assert.deepEqual([board.columns, board.features, board.tasks], [[], [], []]);
  }
  for (const action of ACTIONS) assert.equal(store.apply(REPOSITORY, action, { text: "x" }).ok, false);
  store.close();
  assert.deepEqual(await readFile(databasePath), garbage);
  assert.deepEqual((await readdir(directory)).toSorted(), ["tasks.sqlite"]);
});

test("a truncated store is never overwritten", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  first.readBoard(REPOSITORY);
  first.close();
  const intact = await readFile(databasePath);
  await truncate(databasePath, Math.floor(intact.length / 2));
  const damaged = await readFile(databasePath);
  const store = openTaskStore({ directory });
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.equal(store.apply(REPOSITORY, "create", { text: "x" }).ok, false);
  store.close();
  assert.deepEqual(await readFile(databasePath), damaged);
});

test("a store written by a newer version is never overwritten", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  const first = openTaskStore({ directory });
  const [backlog] = first.readBoard(REPOSITORY).columns;
  first.close();
  withRawDatabase(databasePath, (database) => {
    insertTask(database, REPOSITORY, backlog.id, { text: "written by a future build" });
    database.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
  });
  const newer = await readFile(databasePath);
  const store = openTaskStore({ directory });
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.deepEqual(store.readBoard(REPOSITORY).tasks, []);
  assert.equal(store.readBoard(OTHER_REPOSITORY).readiness, "unavailable");
  for (const action of ACTIONS) assert.equal(store.apply(REPOSITORY, action, { text: "x" }).ok, false);
  store.close();
  assert.deepEqual(await readFile(databasePath), newer);
  assert.deepEqual((await readdir(directory)).toSorted(), ["tasks.sqlite"]);
});

test("a database that is not a task store is never overwritten", async (t) => {
  const temp = await temporaryDirectory(t);
  const { directory, databasePath } = temp;
  withRawDatabase(databasePath, (database) => database.exec("CREATE TABLE other (id INTEGER PRIMARY KEY, note TEXT); INSERT INTO other (note) VALUES ('keep me');"));
  const foreign = await readFile(databasePath);
  const store = openTaskStore({ directory });
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.equal(store.apply(REPOSITORY, "create", { text: "x" }).ok, false);
  store.close();
  assert.deepEqual(await readFile(databasePath), foreign);
});

test("an empty file is treated as a store that was never created", async (t) => {
  const temp = await temporaryDirectory(t);
  await writeFile(temp.databasePath, "");
  const store = openStore(temp);
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
});

test("the store creates its directory and keeps its own file apart from the observation cache", async (t) => {
  const temp = await temporaryDirectory(t);
  const nested = path.join(temp.directory, "private", "tasks");
  const store = openStore(temp, nested);
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
  store.close();
  const names = await readdir(nested);
  assert.equal(names.includes("tasks.sqlite"), true);
  assert.equal(names.includes("monitor.sqlite"), false);
});

test("a store that cannot be opened degrades instead of throwing", async (t) => {
  const temp = await temporaryDirectory(t);
  const { databasePath } = temp;
  for (const options of [undefined, {}, { directory: "" }, { directory: 42 }]) {
    const store = openTaskStore(options);
    assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
    assert.equal(store.apply(REPOSITORY, "create", { text: "x" }).ok, false);
    store.close();
  }
  // A path occupied by a file cannot become a directory.
  await writeFile(databasePath, "");
  const blocked = openTaskStore({ directory: path.join(databasePath, "nested") });
  assert.equal(blocked.readBoard(REPOSITORY).readiness, "unavailable");
  blocked.close();
});

test("closing is idempotent and an unusable store serves nothing", async (t) => {
  const { directory } = await temporaryDirectory(t);
  const store = openTaskStore({ directory });
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
  store.close();
  store.close();
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.equal(store.apply(REPOSITORY, "create", { text: "x" }).ok, false);
  assert.deepEqual(Object.keys(store).toSorted(), ["abortStart", "apply", "bindSession", "blockTask", "close", "completeTask", "featureSessionGroups", "featureSessions", "nextQueueStarts", "pauseQueue", "planStart", "readBoard", "sessionTasks", "stallEndedTasks"]);
});

test("the task layer imports neither the runtime nor the serving layer", async () => {
  for (const file of ["task-store.mjs", "task-record.mjs", "task-dispatch.mjs", "task-board.mjs", "task-report.mjs", "task-checks.mjs", "task-stall.mjs", "task-queue.mjs", "task-queue-advance.mjs"]) {
    const source = await readFile(new URL(`../../../server/tasks/${file}`, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    assert.equal(specifiers.some((specifier) => /(?:^|\/)(?:runtime|serving)\//u.test(specifier)), false, file);
  }
});
