import assert from "node:assert/strict";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { createTask, openTemporaryStore, OTHER_REPOSITORY, REPOSITORY, withDatabase } from "./queue-test-support.mjs";

const declare = (store, reworks = "T-2", cause = "wrong_behavior", fix = "T-1") => store.apply(REPOSITORY, "rework_declare", { fix, reworks, cause });
const seed = (store) => { createTask(store); createTask(store); };
const edges = (directory) => withDatabase(directory, (db) => db.prepare("SELECT * FROM task_rework ORDER BY reworks").all().map((row) => ({ ...row })));

test("rework first declaration stands, projects both directions, and changes no task state", async (t) => {
  const { store, directory, clock } = await openTemporaryStore(t);
  seed(store);
  const before = store.readBoard(REPOSITORY);
  assert.equal(declare(store).status, "recorded");
  clock.now += 20;
  assert.equal(declare(store, "T-2", "latent").status, "exists");
  const board = store.readBoard(REPOSITORY);
  assert.deepEqual(board.tasks[0].reworks, [{ ref: "T-2", cause: "wrong_behavior", declaredBy: "owner" }]);
  assert.deepEqual(board.tasks[1].reworkedBy, [{ ref: "T-1", cause: "wrong_behavior", declaredBy: "owner" }]);
  assert.deepEqual(board.tasks.map(({ reworks, reworkedBy, ...task }) => task), before.tasks);
  assert.deepEqual(board.queue, before.queue);
  assert.equal(edges(directory).length, 1);
  assert.equal(edges(directory)[0].at, clock.now - 20);
  assert.deepEqual(store.readLog(REPOSITORY, { limit: 20 }).entries.map(({ task, kind }) => ({ task, kind })), [{ task: "T-1", kind: "rework" }]);
  assert.ok(store.readAgentTasks(REPOSITORY).every((task) => !("reworks" in task) && !("reworkedBy" in task)));
  assert.equal(store.apply(REPOSITORY, "rework_remove", { fix: "T-1", reworks: "T-2" }).ok, true);
  assert.equal(edges(directory).length, 0);
  assert.equal(store.readLog(REPOSITORY, { limit: 20 }).entries.length, 1);
});

test("rework bounds, canonical references, fixed enums and same-board task existence", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  seed(store); createTask(store, OTHER_REPOSITORY);
  for (const reworks of ["T-1", "T-0", "T-02", "T-3", "#0", "#01", "#1.5", "#9007199254740992", "https://x/1", " #1"]) assert.equal(declare(store, reworks).ok, false, reworks);
  for (const cause of ["unknown", null, "Wrong_behavior"]) assert.equal(declare(store, "#1", cause).error, "invalid");
  assert.equal(declare(store, "#1", "other", "#2").error, "invalid");
  for (const declaredBy of ["session", "aril", "owner"]) assert.equal(store.apply(REPOSITORY, "rework_declare", { fix: "T-1", reworks: "#1", cause: "other", declaredBy }).error, "invalid");
  for (let n = 1; n <= 5; n++) assert.equal(declare(store, `#${n}`, "other").status, "recorded");
  assert.equal(declare(store, "#6", "other").error, "limit");
  assert.equal(declare(store, "#1", "latent").status, "exists");
  assert.equal(edges(directory).length, 5);
  assert.equal(store.apply(OTHER_REPOSITORY, "rework_declare", { fix: "T-1", reworks: "T-2", cause: "other" }).error, "not_found");
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-2" }).ok, true);
  assert.equal(declare(store, "T-2").error, "not_found");
  assert.equal(store.apply(REPOSITORY, "rework_remove", { fix: "#01", reworks: "T-1" }).error, "invalid");
  assert.equal(store.apply(REPOSITORY, "rework_remove", { fix: "T-1", reworks: "#9" }).error, "not_found");
});

test("internal records allow PR fixes, all causes and declarers, with no owner PR-fix action", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  seed(store);
  const { recordTaskRework } = await import("../../../server/tasks/task-rework.mjs");
  withDatabase(directory, (database) => {
    database.exec("BEGIN");
    for (const [i, cause] of ["missed_wiring", "spec_gap", "wrong_behavior", "stale_instructions", "latent", "other"].entries()) {
      const payload = { fix: `#${i + 1}`, reworks: "T-1", cause, declaredBy: ["session", "aril", "owner"][i % 3] };
      assert.equal(recordTaskRework({ database, repositoryId: REPOSITORY, now: () => 10 }, payload).status, "recorded");
    }
    for (const payload of [{ fix: "#1", reworks: "#1", cause: "other", declaredBy: "session" }, { fix: "#7", reworks: "#8", cause: "other", declaredBy: "agent" }]) assert.equal(recordTaskRework({ database, repositoryId: REPOSITORY, now: () => 10 }, payload).error, "invalid");
    assert.equal(recordTaskRework({ database, repositoryId: REPOSITORY, now: () => 10 }, { fix: "#9007199254740991", reworks: "#8", cause: "other", declaredBy: "session" }).ok, true);
    database.exec("COMMIT");
  });
  assert.equal(store.readLog(REPOSITORY, { limit: 20 }).entries[0].task, "#1");
  assert.equal(store.readLog(REPOSITORY, { limit: 20 }).entries[0].pullRequest, null);
  assert.equal(store.apply(REPOSITORY, "rework_remove", { fix: "#1", reworks: "T-1" }).ok, true);
  assert.equal(store.readLog(REPOSITORY, { limit: 20 }).entries.length, 7);
});

test("rework insertion and log append roll back together", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  seed(store);
  withDatabase(directory, (db) => db.exec("CREATE TRIGGER refuse_rework_log AFTER INSERT ON task_log BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  assert.equal(declare(store).ok, false);
  assert.deepEqual(edges(directory), []);
});

test("Aril records safe board evidence including PR-only links, without task changes", async (t) => {
  const { store, directory, clock } = await openTemporaryStore(t);
  seed(store);
  const before = withDatabase(directory, (db) => db.prepare("SELECT * FROM tasks ORDER BY number").all());
  const payload = { fix: "T-1", reworks: "T-2", cause: "missed_wiring" };
  assert.deepEqual(store.declareArilRework(REPOSITORY, payload), { ok: true, status: "recorded" });
  assert.deepEqual(store.declareArilRework(REPOSITORY, { ...payload, cause: "other" }), { ok: true, status: "exists" });
  assert.deepEqual(store.declareArilRework(REPOSITORY, { fix: "#342", reworks: "#336", cause: "spec_gap" }), { ok: true, status: "recorded" });
  assert.deepEqual(store.readBoard(REPOSITORY).rework, [
    { fix: "#342", reworks: "#336", cause: "spec_gap", at: clock.now },
    { ...payload, at: clock.now },
  ]);
  assert.ok(edges(directory).every((edge) => edge.declared_by === "aril"));
  assert.deepEqual(withDatabase(directory, (db) => db.prepare("SELECT * FROM tasks ORDER BY number").all()), before);
  assert.deepEqual(store.readLog(REPOSITORY, { limit: 20 }).entries.map(({ task, kind }) => ({ task, kind })), [{ task: "T-1", kind: "rework" }, { task: "#342", kind: "rework" }]);
  withDatabase(directory, (db) => db.exec("CREATE TRIGGER refuse_aril_rework_log AFTER INSERT ON task_log BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  assert.equal(store.declareArilRework(REPOSITORY, { fix: "#343", reworks: "#336", cause: "other" }).ok, false);
  assert.equal(edges(directory).length, 2);
});

test("opening an existing v1 store adds rework table and retains tasks and version", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  seed(store); store.close();
  withDatabase(directory, (db) => db.exec("DROP TABLE IF EXISTS task_rework"));
  const reopened = openTaskStore({ directory });
  try {
    assert.equal(reopened.readBoard(REPOSITORY).tasks.length, 2);
    assert.equal(declare(reopened).ok, true);
    withDatabase(directory, (db) => assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1"));
  } finally { reopened.close(); }
});
