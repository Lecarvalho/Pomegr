import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { readTaskEvents } from "../../../server/tasks/task-events.mjs";
import { readTaskOutcome, taskOutcome, writeTaskOutcome } from "../../../server/tasks/task-outcomes.mjs";
import { FACTS, passingGates, REPOSITORY, SESSION } from "./queue-test-support.mjs";

const ASSIGNED = "codex:019a0000-2222-7333-8444-555566667777";
const OUTCOME_FACTS = { owner_turns: 0, commits_after_review: 2, pull_request: 42, pull_request_state: "merged" };
const UNKNOWN = { owner_turns: null, commits_after_review: null, pull_request: null, pull_request_state: null };

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-outcomes-"));
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

const outcome = (temp, number = 1) => withDatabase(temp, (database) => readTaskOutcome(database, REPOSITORY, number));

function apply(store, action, payload, resolvers) {
  const result = store.apply(REPOSITORY, action, payload, resolvers);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function bind(store, sessionId = SESSION) {
  const planned = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
}

test("two requeues retain the first review and count distinct started and assigned sessions", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Outcome task" });
  bind(store);
  apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
    apply(store, "resolve_requeue", { id: "T-1" });
    temp.clock += 10;
    bind(store);
  }
  apply(store, "resolve_done", { id: "T-1" });
  const events = withDatabase(temp, (database) => readTaskEvents(database, REPOSITORY, 1));
  assert.deepEqual(outcome(temp), {
    repository_id: REPOSITORY, number: 1, review_at: 1_000_000, done_at: events.at(-1).at,
    requeues: 2, sessions: 2, reviews: 0, first_review_passed: null, ...UNKNOWN,
  });
});

test("pure outcomes exclude other event sessions and keep facts unknown without review", () => {
  const events = [{ kind: "started", at: 1, sessionId: null }, { kind: "blocked", at: 2, sessionId: "ignored" }];
  assert.deepEqual(taskOutcome(events, OUTCOME_FACTS, 3), { review_at: null, done_at: 3, requeues: 0, sessions: 0, ...UNKNOWN });
  events.push({ kind: "review", at: 2, sessionId: null });
  assert.deepEqual(taskOutcome(events, null, 3), { review_at: 2, done_at: 3, requeues: 0, sessions: 0, ...UNKNOWN });
  for (const invalid of [-1, 1.5, "2", NaN, Infinity]) {
    assert.deepEqual(taskOutcome(events, { owner_turns: invalid, commits_after_review: invalid, pull_request: invalid, pull_request_state: "unknown" }, 3),
      { review_at: 2, done_at: 3, requeues: 0, sessions: 0, ...UNKNOWN });
  }
  assert.equal(taskOutcome(events, { pull_request: 0 }, 3).pull_request, null);
});

for (const action of ["resolve_done", "move"]) {
  test(`${action} resolves facts through apply and keeps them private`, async (t) => {
    const temp = await temporaryDirectory(t);
    const store = openStore(temp);
    apply(store, "create", { text: "Outcome task" });
    bind(store);
    apply(store, "session_assign", { id: "T-1", sessionId: ASSIGNED });
    assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
    const done = store.readBoard(REPOSITORY).columns.find((column) => column.role === "done");
    const payload = action === "move" ? { id: "T-1", columnId: done.id, position: 0 } : { id: "T-1" };
    const calls = [];
    const result = apply(store, action, payload, { resolveOutcomeFacts: (...args) => { calls.push(args); return OUTCOME_FACTS; } });
    assert.deepEqual(calls, [[[SESSION, ASSIGNED], temp.clock, "T-1"]]);
    assert.equal(result.board.tasks[0].state, "done");
    for (const [key, value] of Object.entries(OUTCOME_FACTS)) {
      assert.equal(outcome(temp)[key], value);
      assert.equal(JSON.stringify(result.board).includes(key), false);
    }
    apply(store, "move", { id: "T-1", columnId: done.id, position: 0 }, { resolveOutcomeFacts: () => { calls.push("already Done"); return null; } });
    assert.equal(calls.length, 1);
    assert.equal(outcome(temp).pull_request, 42);
  });
}

for (const [name, resolveOutcomeFacts, expected] of [
  ["unknown PR state", () => ({ ...OUTCOME_FACTS, pull_request_state: "unknown" }), { ...OUTCOME_FACTS, pull_request_state: null }],
  ["throwing resolver", () => { throw new Error("unavailable"); }, UNKNOWN],
]) {
  test(`${name} leaves Done standing`, async (t) => {
    const temp = await temporaryDirectory(t);
    const store = openStore(temp);
    apply(store, "create", { text: "Outcome task" });
    bind(store);
    assert.equal(store.completeTask({ sessionId: SESSION }).ok, true);
    assert.equal(apply(store, "resolve_done", { id: "T-1" }, { resolveOutcomeFacts }).board.tasks[0].state, "done");
    for (const [key, value] of Object.entries(expected)) assert.equal(outcome(temp)[key], value);
  });
}

test("no review skips the resolver; deleting the task deletes its outcome", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Outcome task" });
  bind(store);
  let calls = 0;
  apply(store, "resolve_done", { id: "T-1" }, { resolveOutcomeFacts: () => { calls += 1; return OUTCOME_FACTS; } });
  assert.equal(calls, 0);
  for (const [key, value] of Object.entries(UNKNOWN)) assert.equal(outcome(temp)[key], value);
  apply(store, "delete", { id: "T-1" });
  assert.equal(outcome(temp), null);
});

test("version 1 gains an empty outcome table without backfill; writes replace one row", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Existing task" });
  const done = store.readBoard(REPOSITORY).columns.find((column) => column.role === "done");
  apply(store, "move", { id: "T-1", columnId: done.id, position: 0 });
  store.close();
  withDatabase(temp, (database) => database.exec("DROP TABLE task_outcomes"));
  assert.equal(openStore(temp).readBoard(REPOSITORY).readiness, "ready");
  assert.equal(outcome(temp), null);
  withDatabase(temp, (database) => {
    assert.equal(database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, "1");
    writeTaskOutcome(database, REPOSITORY, 1, taskOutcome([], null, 10));
    writeTaskOutcome(database, REPOSITORY, 1, taskOutcome([], null, 20));
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_outcomes").get().count, 1);
    assert.equal(readTaskOutcome(database, REPOSITORY, 1).done_at, 20);
  });
});

test("an outcome write failure never fails Done", async (t) => {
  const temp = await temporaryDirectory(t);
  const store = openStore(temp);
  apply(store, "create", { text: "Outcome task" });
  bind(store);
  withDatabase(temp, (database) => database.exec("CREATE TRIGGER reject_outcome BEFORE INSERT ON task_outcomes BEGIN SELECT RAISE(FAIL, 'unavailable'); END"));
  assert.equal(apply(store, "resolve_done", { id: "T-1" }).board.tasks[0].state, "done");
  assert.equal(outcome(temp), null);
});
