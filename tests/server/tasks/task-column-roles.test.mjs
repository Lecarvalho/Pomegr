import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_TASK_COLUMN_ROLES as CONTRACT_DEFAULT_ROLES, TASK_COLUMN_ROLES as CONTRACT_ROLES } from "../../../shared/task-contract.ts";
import { DEFAULT_TASK_COLUMN_ROLES, TASK_COLUMN_ROLES, normalizeStoredColumn } from "../../../server/tasks/task-record.mjs";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import { FACTS, REPOSITORY, passingGates, removeDirectory } from "./queue-test-support.mjs";

// Column roles and the card move that follows a task's state (docs/internal/architecture/tasks.md, "Columns and card moves").

const SESSION = "claude:0b8f2c1e-1111-4222-8333-444455556666";
const OTHER_SESSION = "claude:0b8f2c1e-1111-4222-8333-444455557777";
const CLOSED = { state: "closed", writerReleased: false };

async function setup(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-roles-"));
  const store = openTaskStore({ directory, now: () => 1_000_000 });
  context.after(async () => { store.close(); await removeDirectory(directory); });
  return { directory, store };
}

const board = (env) => env.store.readBoard(REPOSITORY);
const apply = (env, action, payload) => env.store.apply(REPOSITORY, action, payload);
const columnNamed = (env, name) => board(env).columns.find((column) => column.name === name);
const taskOf = (env, id) => board(env).tasks.find((task) => task.id === id);
/** Task IDs of one column in drawn order, with their positions checked dense. */
function cardsIn(env, name) {
  const column = columnNamed(env, name);
  const tasks = board(env).tasks.filter((task) => task.columnId === column.id);
  assert.deepEqual(tasks.map((task) => task.position), tasks.map((_, index) => index), `${name} positions are dense`);
  return tasks.map((task) => task.id);
}
function create(env, input = {}) {
  assert.equal(apply(env, "create", { text: "Fix the flaky test", ...input }).ok, true);
  return board(env).tasks.map((task) => task.id).toSorted((a, b) => Number(a.slice(2)) - Number(b.slice(2))).at(-1);
}
function link(env, id, sessionId = SESSION) {
  const planned = env.store.planStart(REPOSITORY, { id }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(env.store.bindSession({ token: planned.plan.token, sessionId }), { ok: true });
}
function metaKeys(env) {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const database = new DatabaseSync(path.join(env.directory, "tasks.sqlite"), { readOnly: true });
  try { return database.prepare("SELECT key FROM meta WHERE key LIKE 'column_role:%' ORDER BY key").all().map((row) => row.key); } finally { database.close(); }
}

test("the role constants match the contract and a stored column carries a fixed role or null", () => {
  assert.deepEqual([...TASK_COLUMN_ROLES], [...CONTRACT_ROLES]);
  assert.deepEqual([...DEFAULT_TASK_COLUMN_ROLES], [...CONTRACT_DEFAULT_ROLES]);
  const row = { id: "col-000000000001", name: "Review", position: 0 };
  assert.equal(normalizeStoredColumn({ ...row, role: "review" }).role, "review");
  assert.equal(normalizeStoredColumn(row).role, null);
  assert.equal(normalizeStoredColumn({ ...row, role: "Review" }), undefined);
});

test("a new board has the roles on its In progress, Review, and Done columns", async (context) => {
  const env = await setup(context);
  assert.deepEqual(board(env).columns.map((column) => [column.name, column.role]),
    [["Backlog", null], ["Ready", null], ["In progress", "in_progress"], ["Review", "review"], ["Done", "done"]]);
  assert.deepEqual(metaKeys(env), ["done", "in_progress", "review"].map((role) => `column_role:${REPOSITORY}:${role}`));
});

test("the session link moves the card last into the In progress column and closes the gap it left", async (context) => {
  const env = await setup(context);
  const [first, second, third] = [create(env), create(env), create(env)];
  link(env, first, OTHER_SESSION);
  link(env, second);
  assert.deepEqual(cardsIn(env, "Backlog"), [third]);
  assert.deepEqual(cardsIn(env, "In progress"), [first, second]);
  assert.equal(taskOf(env, second).state, "not_queued");
});

test("a start alone moves nothing: the card moves only when the session links", async (context) => {
  const env = await setup(context);
  const id = create(env);
  assert.equal(env.store.planStart(REPOSITORY, { id }, () => FACTS, passingGates).ok, true);
  assert.deepEqual(cardsIn(env, "Backlog"), [id]);
});

test("a report moves the card to Done or Review, and a block leaves it where it is", async (context) => {
  const env = await setup(context);
  const done = create(env);
  const review = create(env, { doneWhen: { checks: ["tree_clean"], own: null } });
  const blocked = create(env);
  link(env, done, "claude:done-session");
  link(env, review, "claude:review-session");
  link(env, blocked, "claude:blocked-session");
  assert.equal(env.store.completeTask({ sessionId: "claude:done-session" }, () => null).state, "done");
  assert.equal(env.store.completeTask({ sessionId: "claude:review-session" }, () => null).state, "needs_review");
  assert.equal(env.store.blockTask({ sessionId: "claude:blocked-session", reason: "Needs a decision" }).state, "blocked");
  assert.deepEqual(cardsIn(env, "Done"), [done]);
  assert.deepEqual(cardsIn(env, "Review"), [review]);
  assert.deepEqual(cardsIn(env, "In progress"), [blocked]);
});

test("a stalled task stays in its column", async (context) => {
  const env = await setup(context);
  const id = create(env);
  link(env, id);
  assert.deepEqual(env.store.stallEndedTasks(() => CLOSED), { ok: true, stalled: 1 });
  assert.equal(taskOf(env, id).state, "stalled");
  assert.deepEqual(cardsIn(env, "In progress"), [id]);
});

test("Mark done moves the card to Done; Requeue puts it back in Ready until the new session links", async (context) => {
  const env = await setup(context);
  const accepted = create(env);
  const requeued = create(env, { doneWhen: { checks: ["tree_clean"], own: null } });
  link(env, accepted, "claude:accepted-session");
  link(env, requeued, "claude:requeued-session");
  assert.deepEqual(env.store.stallEndedTasks((sessionId) => (sessionId === "claude:accepted-session" ? CLOSED : null)), { ok: true, stalled: 1 });
  assert.equal(env.store.completeTask({ sessionId: "claude:requeued-session" }, () => null).state, "needs_review");
  assert.equal(apply(env, "resolve_done", { id: accepted }).ok, true);
  assert.deepEqual(cardsIn(env, "Done"), [accepted]);
  assert.equal(apply(env, "resolve_requeue", { id: requeued }).ok, true);
  assert.equal(taskOf(env, requeued).state, "queued");
  assert.deepEqual(cardsIn(env, "Review"), []);
  assert.deepEqual(cardsIn(env, "Ready"), [requeued]);
  link(env, requeued, "claude:second-session");
  assert.deepEqual(cardsIn(env, "Ready"), []);
  assert.deepEqual(cardsIn(env, "In progress"), [requeued]);
});

test("a card moved by hand stays there until its next state change, which moves it again", async (context) => {
  const env = await setup(context);
  const id = create(env);
  link(env, id);
  assert.equal(apply(env, "move", { id, columnId: columnNamed(env, "Ready").id, position: 0 }).ok, true);
  assert.deepEqual(cardsIn(env, "Ready"), [id]);
  assert.equal(taskOf(env, id).state, "not_queued");
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).state, "done");
  assert.deepEqual(cardsIn(env, "Ready"), []);
  assert.deepEqual(cardsIn(env, "Done"), [id]);
});

test("a card already in the role's column keeps its place", async (context) => {
  const env = await setup(context);
  const [first, second] = [create(env), create(env)];
  const progress = columnNamed(env, "In progress").id;
  assert.equal(apply(env, "move", { id: second, columnId: progress, position: 0 }).ok, true);
  assert.equal(apply(env, "move", { id: first, columnId: progress, position: 0 }).ok, true);
  link(env, first);
  assert.deepEqual(cardsIn(env, "In progress"), [first, second]);
});

test("every column action is refused, so the roles stay on In progress, Review, and Done", async (context) => {
  const env = await setup(context);
  const done = columnNamed(env, "Done").id;
  for (const [action, payload] of [["column_role", { id: done, role: null }], ["column_rename", { id: done, name: "Shipped" }], ["column_reorder", { id: done, position: 0 }], ["column_delete", { id: done }]]) {
    assert.deepEqual(apply(env, action, payload), { ok: false, error: "unsupported" }, action);
  }
  const id = create(env);
  link(env, id);
  assert.equal(env.store.completeTask({ sessionId: SESSION }, () => null).state, "done");
  assert.deepEqual(cardsIn(env, "Done"), [id]);
  assert.deepEqual(board(env).columns.map((column) => column.role), [null, null, "in_progress", "review", "done"]);
  assert.deepEqual(metaKeys(env), ["done", "in_progress", "review"].map((role) => `column_role:${REPOSITORY}:${role}`));
});
