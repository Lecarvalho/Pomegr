import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { FACTS, passingGates, REPOSITORY, SESSION } from "./queue-test-support.mjs";

const ASSIGNED = "codex:019a0000-2222-7333-8444-555566667777";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-events-"));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  });
  return { directory, stores, clock: 1_000_000 };
}

function openStore(temp) {
  const store = openTaskStore({ directory: temp.directory, now: () => temp.clock });
  temp.stores.push(store);
  return store;
}

function withDatabase(temp, work) {
  const database = new DatabaseSync(path.join(temp.directory, "tasks.sqlite"));
  try { return work(database); } finally { database.close(); }
}

async function events(temp, number = 1) {
  const { readTaskEvents } = await import("../../../server/tasks/task-events.mjs");
  return withDatabase(temp, (database) => readTaskEvents(database, REPOSITORY, number));
}

function apply(store, action, payload) {
  const result = store.apply(REPOSITORY, action, payload);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function bind(store, id = "T-1", sessionId = SESSION) {
  const planned = store.planStart(REPOSITORY, { id }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
}

test("a fresh store has task_events and keeps schema version 1", async (t) => {
  const temp = await temporaryDirectory(t);
  openStore(temp);
  withDatabase(temp, (database) => {
    assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_events'").get());
    assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'task_events_task'").get());
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_events").get().count, 0);
  });
});

test("a version 1 store without task_events reopens and gains an empty table", async (t) => {
  const temp = await temporaryDirectory(t);
  const original = openStore(temp);
  apply(original, "create", { text: "Existing task" });
  original.close();
  withDatabase(temp, (database) => database.exec("DROP TABLE IF EXISTS task_events"));
  const reopened = openStore(temp);
  assert.equal(reopened.readBoard(REPOSITORY).readiness, "ready");
  assert.deepEqual(await events(temp), []);
  withDatabase(temp, (database) => assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1"));
});

test("transitions append kind, time and session in order through both Done actions", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "First task" });
  bind(store);
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  temp.clock += 10;
  assert.equal(store.completeTask({ sessionId: ASSIGNED }).ok, true);
  temp.clock += 10;
  assert.equal(store.blockTask({ sessionId: SESSION, reason: "Decision needed" }).ok, true);
  apply(store, "resolve_requeue", { id: "T-1" });
  assert.equal(store.readBoard(REPOSITORY).tasks[0].session, null);
  bind(store, "T-1", ASSIGNED);
  apply(store, "resolve_done", { id: "T-1" });
  const first = await events(temp);
  assert.deepEqual(first.map(({ kind, sessionId }) => ({ kind, sessionId })), [
    { kind: "started", sessionId: SESSION }, { kind: "assigned", sessionId: ASSIGNED },
    { kind: "review", sessionId: SESSION }, { kind: "blocked", sessionId: SESSION },
    { kind: "requeued", sessionId: SESSION }, { kind: "started", sessionId: ASSIGNED },
    { kind: "done", sessionId: ASSIGNED },
  ]);
  assert.ok(first.every(({ at }) => Number.isInteger(at) && at > 0));
  assert.equal(first[0].at, 1_000_000);
  assert.equal(first[2].at, 1_000_010);
  assert.equal(first[3].at, 1_000_020);
  assert.equal(first[5].at, 1_000_020);
  assert.equal(first[6].at, Date.parse(store.readBoard(REPOSITORY).tasks[0].updatedAt));
  apply(store, "create", { text: "Second task" });
  bind(store, "T-2");
  const done = store.readBoard(REPOSITORY).columns.find((column) => column.role === "done");
  apply(store, "move", { id: "T-2", columnId: done.id, position: 0 });
  assert.deepEqual((await events(temp, 2)).map(({ kind, sessionId }) => ({ kind, sessionId })), [
    { kind: "started", sessionId: SESSION }, { kind: "done", sessionId: SESSION },
  ]);
  apply(store, "create", { text: "Unstarted task" });
  apply(store, "move", { id: "T-3", columnId: done.id, position: 0 });
  assert.deepEqual((await events(temp, 3)).map(({ kind, sessionId }) => ({ kind, sessionId })), [{ kind: "done", sessionId: null }]);
});

test("an identical repeated completion writes no second review", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Retry task" });
  bind(store);
  assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
  const before = await events(temp);
  temp.clock += 10;
  assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
  assert.deepEqual(await events(temp), before);
  assert.deepEqual(before.map(({ kind }) => kind), ["started", "review"]);
});

test("deleting a task deletes only its events", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  for (const id of ["T-1", "T-2"]) {
    apply(store, "create", { text: "Assigned task" });
    apply(store, "session_assign", { id, sessionId: ASSIGNED });
  }
  assert.equal((await events(temp)).length, 1);
  apply(store, "delete", { id: "T-1" });
  assert.deepEqual(await events(temp), []);
  assert.equal((await events(temp, 2)).length, 1);
});

test("immediate queue_add refuses a linked task without changing state or session", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Started task" });
  bind(store);
  const before = store.readBoard(REPOSITORY).tasks[0];
  assert.equal(before.state, "not_queued");
  assert.equal(before.session.id, SESSION);
  assert.deepEqual(store.apply(REPOSITORY, "queue_add", { id: "T-1" }), { ok: false, error: "conflict" });
  assert.deepEqual(store.readBoard(REPOSITORY).tasks[0], before);
  assert.deepEqual((await events(temp)).map(({ kind }) => kind), ["started"]);
});
