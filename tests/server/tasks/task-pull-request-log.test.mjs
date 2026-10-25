import assert from "node:assert/strict";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { createTaskStallWatcher } from "../../../server/tasks/task-stall.mjs";
import { createTask, metaValue, openTemporaryStore, REPOSITORY, SESSION, startedTask, withDatabase } from "./queue-test-support.mjs";

const SECOND = "codex:019a0000-2222-7333-8444-555566667777";
const HEAD = "a".repeat(40);
const facts = (changes = {}) => ({ number: 42, state: "open", headOid: HEAD, checks: "passed", ...changes });
const key = `task_pull_request_seen:${REPOSITORY}:T-1`;
const entries = (store) => store.readLog(REPOSITORY, { limit: 200 }).entries;
async function setup(t) {
  const context = await openTemporaryStore(t);
  createTask(context.store);
  startedTask(context.directory, 1, { session: SESSION });
  return context;
}

test("CI changes and merge append once, survive reopening, and carry only fixed fields", async (t) => {
  const { store, directory, clock } = await setup(t);
  const calls = [];
  const passed = (...args) => { calls.push(args); return facts(); };
  store.logPullRequests(passed);
  store.logPullRequests(passed);
  assert.deepEqual(calls, [[SESSION, "T-1"], [SESSION, "T-1"]]);
  assert.deepEqual(entries(store), [{ id: 1, task: "T-1", kind: "checks_passed", at: clock.now, pullRequest: 42 }]);
  const failed = facts({ headOid: "b".repeat(40), checks: "failed" });
  store.logPullRequests(() => failed);
  store.logPullRequests(() => ({ ...failed, state: "merged" }));
  store.logPullRequests(() => ({ ...failed, state: "merged" }));
  assert.deepEqual(JSON.parse(metaValue(directory, key)), { number: 42, headOid: failed.headOid, checks: "failed", merged: true });
  store.close();
  const reopened = openTaskStore({ directory });
  try {
    reopened.logPullRequests(() => ({ ...failed, state: "merged" }));
    assert.deepEqual(entries(reopened).map(({ kind }) => kind), ["checks_passed", "checks_failed", "merged"]);
    reopened.logPullRequests(() => facts({ number: 43, state: "merged" }));
    assert.deepEqual(entries(reopened).slice(-2).map(({ kind, pullRequest }) => ({ kind, pullRequest })), [
      { kind: "checks_passed", pullRequest: 43 }, { kind: "merged", pullRequest: 43 },
    ]);
  } finally { reopened.close(); }
});

test("unknown checks append nothing; missing PR preserves seen; deletion removes seen", async (t) => {
  const { store, directory } = await setup(t);
  store.logPullRequests(() => facts({ checks: null }));
  assert.deepEqual(entries(store), []);
  store.logPullRequests(() => facts());
  const seen = metaValue(directory, key);
  store.logPullRequests(() => ({ number: null, state: null, headOid: null, checks: null }));
  assert.equal(metaValue(directory, key), seen);
  store.logPullRequests(() => facts());
  assert.equal(entries(store).length, 1);
  assert.equal(store.apply(REPOSITORY, "delete", { id: "T-1" }).ok, true);
  assert.equal(metaValue(directory, key), null);
});

test("a head whose checks read as unknown again is not logged twice, and a quiet sweep writes nothing", async (t) => {
  const { store, directory } = await setup(t);
  store.logPullRequests(() => facts());
  const seen = metaValue(directory, key);
  store.logPullRequests(() => facts({ checks: null }));
  assert.equal(metaValue(directory, key), seen);
  store.logPullRequests(() => facts());
  assert.deepEqual(entries(store).map(({ kind }) => kind), ["checks_passed"]);
});

test("done, unlinked, and non-task sessions are not resolved", async (t) => {
  const { store, directory } = await setup(t);
  startedTask(directory, 1, { session: SESSION, state: "done" });
  createTask(store);
  createTask(store);
  startedTask(directory, 3, { session: "invalid/session" });
  const calls = [];
  store.logPullRequests((...args) => { calls.push(args); return facts(); });
  assert.deepEqual(calls, []);
});

test("throwing or malformed resolver skips only its task", async (t) => {
  const { store, directory } = await setup(t);
  createTask(store);
  startedTask(directory, 2, { session: SECOND, state: "needs_review" });
  const invalid = [() => { throw new Error("private"); }, () => null,
    () => facts({ number: "42" }), () => facts({ state: "private" }),
    () => facts({ headOid: "private" }), () => facts({ checks: "pending" })];
  for (const [index, resolve] of invalid.entries()) {
    store.logPullRequests((session) => session === SESSION ? resolve() : facts({ number: index + 1 }));
  }
  assert.equal(entries(store).length, invalid.length);
  assert.ok(entries(store).every((entry) => entry.task === "T-2"));
  assert.equal(metaValue(directory, key), null);
});

test("all sweep writes roll back together", async (t) => {
  const { store, directory } = await setup(t);
  createTask(store);
  startedTask(directory, 2, { session: SECOND });
  withDatabase(directory, (db) => db.exec("CREATE TRIGGER refuse_second AFTER INSERT ON task_log WHEN NEW.number = 2 BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  assert.equal(store.logPullRequests(() => facts()).ok, false);
  assert.deepEqual(entries(store), []);
  assert.equal(metaValue(directory, key), null);
});

test("opening a phase 1a log adds the nullable column and preserves its rows", async (t) => {
  const { store, directory } = await openTemporaryStore(t);
  store.close();
  withDatabase(directory, (db) => {
    db.exec(`DROP TABLE task_log;
      CREATE TABLE task_log (id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL,
        number INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL);`);
    db.prepare("INSERT INTO task_log (repository_id, number, kind, at) VALUES (?, 1, 'started', 123)").run(REPOSITORY);
  });
  const reopened = openTaskStore({ directory });
  try {
    assert.deepEqual(entries(reopened), [{ id: 1, task: "T-1", kind: "started", at: 123, pullRequest: null }]);
    withDatabase(directory, (db) => {
      const column = db.prepare("PRAGMA table_info(task_log)").all().find(({ name }) => name === "pull_request");
      assert.equal(column.type, "INTEGER");
      assert.equal(column.notnull, 0);
    });
  } finally { reopened.close(); }
});

test("revision sweeps log PRs even when stall resolution throws", () => {
  let revision;
  let timer;
  const calls = [];
  const resolver = () => facts();
  const watcher = createTaskStallWatcher({
    taskStore: { stallEndedTasks() { throw new Error("unavailable"); }, logPullRequests(resolve) { calls.push(resolve); throw new Error("unavailable"); } },
    subscribe(fn) { revision = fn; }, resolvePullRequestFacts: resolver,
    setTimer(fn) { timer = fn; return 1; }, clearTimer() {},
  });
  timer();
  revision();
  timer();
  watcher.stop();
  assert.deepEqual(calls, [resolver, resolver]);
});
