import assert from "node:assert/strict";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { createTask, FACTS, openTemporaryStore, OTHER_REPOSITORY, passingGates, REPOSITORY, SESSION, withDatabase } from "./queue-test-support.mjs";

const ASSIGNED = "codex:019a0000-2222-7333-8444-555566667777";
const read = (store, options = { limit: 200 }, repositoryId = REPOSITORY) => store.readLog(repositoryId, options);
const apply = (store, action, payload) => assert.equal(store.apply(REPOSITORY, action, payload).ok, true);
function bind(store, sessionId = SESSION) {
  const planned = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
}

test("task transitions append only the fixed log fields in order", async (t) => {
  const { store, clock } = await openTemporaryStore(t);
  createTask(store);
  bind(store);
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  clock.now += 10;
  assert.equal(store.completeTask({ sessionId: ASSIGNED }).ok, true);
  assert.equal(store.completeTask({ sessionId: ASSIGNED }).ok, true);
  clock.now += 10;
  assert.equal(store.blockTask({ sessionId: SESSION, reason: "Private reason" }).ok, true);
  apply(store, "resolve_requeue", { id: "T-1" });
  bind(store, ASSIGNED);
  apply(store, "resolve_done", { id: "T-1" });
  const log = read(store);
  assert.deepEqual(log.entries.map(({ kind }) => kind), ["started", "assigned", "review", "blocked", "requeued", "started", "done"]);
  assert.deepEqual(log.entries.map(({ id }) => id), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(log.entries.every((entry) => entry.task === "T-1" && Number.isInteger(entry.at)));
  assert.deepEqual(log.entries.map((entry) => Object.keys(entry).sort()), Array(7).fill(["at", "id", "kind", "pullRequest", "task"]));
  assert.ok(log.entries.every((entry) => entry.pullRequest === null));
  assert.equal(log.entries[2].at, 1_000_010);
  assert.equal(log.entries[3].at, clock.now);
  assert.deepEqual({ more: log.more, latestId: log.latestId, cursors: log.cursors }, { more: false, latestId: 7, cursors: { aril: 0 } });
});

test("stall and recovery append once, with the update's time", async (t) => {
  const { store, directory, clock } = await openTemporaryStore(t);
  createTask(store);
  bind(store);
  store.close();
  const ticking = openTaskStore({ directory, now: () => ++clock.now });
  t.after(() => ticking.close());
  for (const [state, kind, count] of [["closed", "stalled", "stalled"], ["working", "recovered", "recovered"]]) {
    assert.equal(ticking.stallEndedTasks(() => ({ state }))[count], 1);
    const last = read(ticking).entries.at(-1);
    assert.equal(last.kind, kind);
    withDatabase(directory, (db) => assert.equal(last.at, db.prepare("SELECT updated_at FROM tasks").get().updated_at));
    assert.equal(ticking.stallEndedTasks(() => ({ state }))[count], 0);
  }
  assert.deepEqual(read(ticking).entries.map(({ kind }) => kind), ["started", "stalled", "recovered"]);
  ticking.close();
});

test("readLog pages newest and following entries in ascending order", async (t) => {
  const { store } = await openTemporaryStore(t);
  assert.deepEqual(read(store), { entries: [], more: false, latestId: 0, cursors: { aril: 0 } });
  createTask(store);
  bind(store);
  assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
  apply(store, "resolve_done", { id: "T-1" });
  assert.deepEqual(read(store, { limit: 2 }).entries.map(({ id }) => id), [2, 3]);
  assert.equal(read(store, { limit: 2 }).more, true);
  assert.deepEqual(read(store, { limit: 2, after: 0 }).entries.map(({ id }) => id), [1, 2]);
  assert.equal(read(store, { limit: 2, after: 0 }).more, true);
  assert.deepEqual(read(store, { limit: 2, after: 2 }).entries.map(({ id }) => id), [3]);
  assert.equal(read(store, { limit: 2, after: 2 }).more, false);
  assert.deepEqual(read(store, { limit: 2, after: 3 }).entries, []);
});

test("pruning keeps 1000 per repository and IDs never repeat after deletion", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  const { appendTaskLog, TASK_LOG_KEEP, TASK_LOG_KINDS, TASK_LOG_CONSUMERS } = await import("../../../server/tasks/task-log.mjs");
  assert.equal(TASK_LOG_KEEP, 1000);
  assert.deepEqual(TASK_LOG_KINDS, ["started", "assigned", "review", "blocked", "requeued", "done", "stalled", "recovered", "checks_passed", "checks_failed", "merged", "review_started", "review_passed", "review_failed", "grant_start", "grant_review", "sent_back", "grant_merge", "grant_merge_refused", "grant_merge_auto", "grant_branch_deleted", "grant_branch_delete_refused", "grant_task_written", "grant_usage_hold", "grant_usage_resume"]);
  assert.deepEqual(TASK_LOG_CONSUMERS, ["aril"]);
  assert.ok(Object.isFrozen(TASK_LOG_KINDS) && Object.isFrozen(TASK_LOG_CONSUMERS));
  withDatabase(directory, (db) => {
    db.exec("BEGIN");
    appendTaskLog(db, OTHER_REPOSITORY, 2, "assigned", 1);
    for (let i = 0; i < 1005; i += 1) appendTaskLog(db, REPOSITORY, 1, "started", i);
    db.exec("COMMIT");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_log WHERE repository_id = ?").get(REPOSITORY).n, 1000);
    assert.throws(() => appendTaskLog(db, REPOSITORY, 1, "unknown", 1));
  });
  assert.equal(read(store, { limit: 1, after: 0 }).entries[0].id, 7);
  assert.equal(read(store, { limit: 1 }, OTHER_REPOSITORY).latestId, 1);
  const latest = read(store).latestId;
  withDatabase(directory, (db) => {
    db.prepare("DELETE FROM task_log WHERE repository_id = ?").run(REPOSITORY);
    appendTaskLog(db, REPOSITORY, 1, "started", 9999);
  });
  assert.equal(read(store).latestId, latest + 1);
});

test("grant usage entries expose no task and only a fixed provider reason", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  const { appendTaskLog } = await import("../../../server/tasks/task-log.mjs");
  withDatabase(directory, (db) => {
    db.exec("BEGIN");
    appendTaskLog(db, REPOSITORY, 0, "grant_usage_hold", 10, null, "claude");
    appendTaskLog(db, REPOSITORY, 0, "grant_usage_resume", 20, null, "codex");
    db.exec("COMMIT");
    assert.throws(() => appendTaskLog(db, REPOSITORY, 0, "grant_usage_hold", 30, null, "private provider error"));
    assert.throws(() => appendTaskLog(db, REPOSITORY, 1, "grant_usage_hold", 30));
  });
  assert.deepEqual(read(store).entries, [
    { id: 1, task: null, kind: "grant_usage_hold", at: 10, pullRequest: null, reason: "claude" },
    { id: 2, task: null, kind: "grant_usage_resume", at: 20, pullRequest: null, reason: "codex" },
  ]);
});

test("task deletion keeps the log and durable forward-only repository cursors", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  createTask(store);
  bind(store);
  assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
  assert.equal(store.ackLog(REPOSITORY, "aril", 1), 1);
  assert.equal(store.ackLog(REPOSITORY, "aril", 0), 1);
  assert.equal(store.ackLog(REPOSITORY, "aril", 999), 2);
  assert.equal(store.ackLog(OTHER_REPOSITORY, "aril", 999), 0);
  const before = read(store);
  apply(store, "delete", { id: "T-1" });
  assert.deepEqual(read(store), before);
  store.close();
  const reopened = openTaskStore({ directory });
  try { assert.deepEqual(read(reopened), before); } finally { reopened.close(); }
});

test("log helpers reject invalid paging and consumers", async (t) => {
  const { directory } = await openTemporaryStore(t);
  const { readTaskLog, ackTaskLog } = await import("../../../server/tasks/task-log.mjs");
  withDatabase(directory, (db) => {
    for (const limit of [undefined, 0, 201, -1, 1.5, "1", NaN]) assert.throws(() => readTaskLog(db, REPOSITORY, { limit }));
    for (const after of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => readTaskLog(db, REPOSITORY, { limit: 1, after }));
    assert.throws(() => ackTaskLog(db, REPOSITORY, "other", 0));
    for (const through of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => ackTaskLog(db, REPOSITORY, "aril", through));
  });
});

test("a failed transition rolls back the task, task event, and log append", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  createTask(store);
  withDatabase(directory, (db) => db.exec("CREATE TRIGGER refuse_log AFTER INSERT ON task_log BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  assert.equal(store.apply(REPOSITORY, "session_assign", { id: "T-1", sessionId: ASSIGNED }).ok, false);
  assert.deepEqual(read(store).entries, []);
  withDatabase(directory, (db) => assert.equal(db.prepare("SELECT COUNT(*) AS n FROM task_events").get().n, 0));
  withDatabase(directory, (db) => db.exec("DROP TRIGGER refuse_log"));
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  assert.equal(read(store).entries.length, 1);
});

test("opening an existing v1 store creates missing additive log tables", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  createTask(store);
  store.close();
  withDatabase(directory, (db) => db.exec("DROP TABLE IF EXISTS task_log; DROP TABLE IF EXISTS task_log_cursors"));
  const reopened = openTaskStore({ directory });
  try {
    assert.deepEqual(read(reopened), { entries: [], more: false, latestId: 0, cursors: { aril: 0 } });
    withDatabase(directory, (db) => {
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
      assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_log'").get().sql, /AUTOINCREMENT/u);
      assert.doesNotMatch(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_log'").get().sql, /CHECK/u);
    });
  } finally { reopened.close(); }
});
