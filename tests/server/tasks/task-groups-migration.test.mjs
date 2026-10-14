import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import {
  GATE_FACTS, REPOSITORY, SESSION, START_TIME, createTask, metaValue, openTemporaryStore, passingGates, queueTask, removeDirectory, startedTask, updateTask, withDatabase,
} from "./queue-test-support.mjs";

// A board written while a feature held steps is brought to parallel groups once, when the monitor opens the store.

const MARKER = `ready_groups:${REPOSITORY}`;
const DAY = 3_600_000;

const rowsOf = (directory) => withDatabase(directory, (database) => database.prepare("SELECT * FROM tasks WHERE repository_id = ? ORDER BY number").all(REPOSITORY).map((row) => ({ ...row })));
const withoutStep = ({ step, ...row }) => row;
const dump = (directory) => withDatabase(directory, (database) => Object.fromEntries(["tasks", "meta", "repositories", "columns", "features"]
  .map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all().map((row) => ({ ...row }))])));
const groupRows = (directory) => withDatabase(directory, (database) => database.prepare("SELECT key FROM meta WHERE key LIKE 'task_group:%' ORDER BY key").all().map((row) => row.key.slice(row.key.lastIndexOf(":") + 1)));
const groupOf = (board, id) => board.tasks.find((task) => task.id === id).group;
const readyCards = (directory, columnId) => rowsOf(directory).filter((row) => row.column_id === columnId).toSorted((a, b) => a.position - b.position).map((row) => `T-${row.number}`);

/**
 * A store in the shape the step build wrote: closed, with the marker gone and a step on each task of a feature.
 * Feature A: step 1 holds T-1, T-2 (waiting) and T-3 (not queued); step 2 holds T-4 (live start) and T-5 (scheduled, not due);
 * step 3 holds T-6 (session linked) and T-7 (waiting). Feature B: step 1 holds T-8 (waiting alone), T-9 (review), T-10 (done),
 * T-11 (stalled), T-12 (blocked) and T-13 (not queued). Feature C: T-14 (not queued, step 1) held T-15 (waiting, step 2).
 * T-16 is a plain waiting task. The queue was running.
 */
async function stepStore(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pomegr-task-groups-migration-"));
  const clock = { now: START_TIME };
  const opened = [];
  const open = () => {
    const store = openTaskStore({ directory, now: () => clock.now });
    opened.push(store);
    return store;
  };
  context.after(async () => {
    opened.forEach((store) => store.close());
    await removeDirectory(directory);
  });
  const store = open();
  const featureIds = ["A", "B", "C"].map((name) => {
    const result = store.apply(REPOSITORY, "feature_create", { name });
    assert.equal(result.ok, true);
    return result.board.features.find((feature) => feature.name === name).id;
  });
  const [a, b, c] = featureIds;
  const placement = [a, a, a, a, a, a, a, b, b, b, b, b, b, c, c, null];
  placement.forEach((featureId, index) => createTask(store, REPOSITORY, { text: `Task number ${index + 1}`, ...(featureId === null ? {} : { featureId }) }));
  for (const number of [1, 2, 4, 6, 7, 8, 15, 16]) queueTask(store, `T-${number}`);
  assert.equal(store.apply(REPOSITORY, "queue_add", { id: "T-5", at: new Date(START_TIME + DAY).toISOString() }).ok, true);
  const ready = store.readBoard(REPOSITORY).columns.find((column) => column.name === "Ready").id;
  // T-5 was queued last: bring its card beside T-4 the way the step build kept a step together.
  assert.equal(store.apply(REPOSITORY, "move", { id: "T-5", columnId: ready, position: 3 }).ok, true);
  store.close();

  const steps = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 3, 7: 3, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 14: 1, 15: 2 };
  withDatabase(directory, (database) => {
    database.prepare("DELETE FROM meta WHERE key LIKE 'ready_groups:%' OR key LIKE 'task_group:%'").run();
    const edit = database.prepare("UPDATE tasks SET step = ?, updated_at = ? WHERE repository_id = ? AND number = ?");
    for (let number = 1; number <= 16; number += 1) edit.run(steps[number] ?? null, 5_000_000 + number, REPOSITORY, number);
    database.prepare("UPDATE repositories SET queue_status = 'running', queue_blocked_by = NULL WHERE repository_id = ?").run(REPOSITORY);
  });
  startedTask(directory, 4, { mintedAt: START_TIME - 1000 });
  startedTask(directory, 6, { session: SESSION });
  startedTask(directory, 9, { session: "claude:1c9f3d2f-2222-4333-8444-555566667777", state: "needs_review" });
  updateTask(directory, 9, { report_at: START_TIME, report_results: "[]" });
  startedTask(directory, 10, { session: "claude:2c9f3d2f-2222-4333-8444-555566667777", state: "done" });
  startedTask(directory, 11, { session: "claude:3c9f3d2f-2222-4333-8444-555566667777", state: "stalled" });
  startedTask(directory, 12, { session: "claude:4c9f3d2f-2222-4333-8444-555566667777", state: "blocked" });
  updateTask(directory, 12, { report_at: START_TIME, report_results: "[]", report_block_reason: "needs a decision" });
  assert.equal(metaValue(directory, MARKER), null);
  return { directory, clock, ready, featureIds, reopen: open };
}

test("a step store keeps every task row but the step, and the queue status, when it is opened", async (context) => {
  const { directory, reopen } = await stepStore(context);
  const before = rowsOf(directory);
  const status = withDatabase(directory, (database) => ({ ...database.prepare("SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(REPOSITORY) }));
  assert.equal(before.length, 16);
  assert.ok(before.some((row) => row.step === 3));
  const store = reopen();
  const after = rowsOf(directory);
  assert.deepEqual(after.map(withoutStep), before.map(withoutStep), "text, column, position, feature, state, schedule, session, dispatch, report, update time");
  // The step column stays in the schema, is written 1 for a task of a feature and NULL for a task of none.
  assert.deepEqual(after.map((row) => [row.number, row.step]), before.map((row) => [row.number, row.feature_id === null ? null : 1]));
  assert.deepEqual(withDatabase(directory, (database) => ({ ...database.prepare("SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(REPOSITORY) })), status);
  assert.equal(metaValue(directory, MARKER), "1");
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
});

test("the steps with two or more queued tasks become one group each, and no other task is in a group", async (context) => {
  const { directory, reopen } = await stepStore(context);
  const board = reopen().readBoard(REPOSITORY);
  const ids = (...numbers) => numbers.map((number) => `T-${number}`);
  // Waiting or in flight counts: a live start, a linked session, and a scheduled task that is not due all join their step-mates.
  for (const members of [ids(1, 2), ids(4, 5), ids(6, 7)]) {
    const [first, ...rest] = members.map((id) => groupOf(board, id));
    assert.match(first, /^grp-[0-9a-f]{12}$/u);
    assert.deepEqual(rest, rest.map(() => first), members.join());
  }
  assert.equal(new Set(ids(1, 4, 6).map((id) => groupOf(board, id))).size, 3, "one group for each step");
  // A step with one queued task is no group, and review, done, stalled, blocked, and not queued step-mates are in none.
  for (const id of ids(3, 8, 9, 10, 11, 12, 13, 14, 15, 16)) assert.equal(groupOf(board, id), null, id);
  assert.deepEqual(groupRows(directory), ids(1, 2, 4, 5, 6, 7));
});

test("Ready order is unchanged, and a feature held by a step that was not queued now starts at its place", async (context) => {
  const { directory, ready, reopen } = await stepStore(context);
  const cardsBefore = readyCards(directory, ready);
  assert.deepEqual(cardsBefore, ["T-1", "T-2", "T-4", "T-5", "T-6", "T-7", "T-8", "T-15", "T-16"]);
  const board = reopen().readBoard(REPOSITORY);
  assert.deepEqual(readyCards(directory, ready), cardsBefore);
  // T-4 and T-6 are in flight and T-5 is not due: the waiting due cards, in Ready order. T-15 was held by T-14, which was never queued.
  assert.deepEqual(board.queue.order, ["T-1", "T-2", "T-7", "T-8", "T-15", "T-16"]);
  assert.equal(board.queue.status, "running");
});

test("opening the store a second time changes nothing", async (context) => {
  const { directory, reopen } = await stepStore(context);
  const first = reopen();
  const board = first.readBoard(REPOSITORY);
  first.close();
  const snapshot = dump(directory);
  const second = reopen();
  assert.deepEqual(second.readBoard(REPOSITORY), board);
  second.close();
  assert.deepEqual(dump(directory), snapshot);
  // A step written afterwards is never read as a group again: the marker holds.
  withDatabase(directory, (database) => database.prepare("UPDATE tasks SET step = 2 WHERE repository_id = ? AND number = 8").run(REPOSITORY));
  const third = reopen();
  assert.deepEqual(groupRows(directory), ["T-1", "T-2", "T-4", "T-5", "T-6", "T-7"]);
  assert.equal(groupOf(third.readBoard(REPOSITORY), "T-8"), null);
});

test("a store that does not project is not written by the migration", async (context) => {
  const { directory, reopen } = await stepStore(context);
  updateTask(directory, 3, { text: "" });
  const before = dump(directory);
  const store = reopen();
  assert.equal(store.readBoard(REPOSITORY).readiness, "unavailable");
  assert.deepEqual(dump(directory), before, "no marker, no group, no step rewritten");
  assert.equal(metaValue(directory, MARKER), null);
  assert.deepEqual(groupRows(directory), []);
});

test("right after the migration the queue never answers a task in flight or with a live start", async (context) => {
  const { directory, clock, reopen } = await stepStore(context);
  const store = reopen();
  const starts = () => store.nextQueueStarts({ resolveGateFacts: passingGates }).starts.map((start) => start.taskId);
  // T-4 (a live start) and T-6 (a session) are in flight in two groups: nothing starts, in particular neither of them again.
  assert.deepEqual(starts(), []);
  assert.equal(store.nextQueueStarts({ resolveGateFacts: () => GATE_FACTS }).ok, true);
  // The T-6 group reports: only the T-4 group runs, and its waiting rest may start, T-4 never.
  updateTask(directory, 6, { state: "needs_review" });
  updateTask(directory, 7, { state: "needs_review", session_id: "claude:5c9f3d2f-2222-4333-8444-555566667777" });
  updateTask(directory, 5, { scheduled_at: clock.now });
  assert.deepEqual(starts(), ["T-5"]);
  // With T-4's group done, the top waiting card of Ready starts alone.
  updateTask(directory, 4, { state: "needs_review", session_id: "claude:6c9f3d2f-2222-4333-8444-555566667777", dispatch_token: null });
  updateTask(directory, 5, { state: "needs_review", session_id: "claude:7c9f3d2f-2222-4333-8444-555566667777" });
  assert.deepEqual(starts(), ["T-1", "T-2"]);
});

test("a new repository is marked at creation and holds no group", async (context) => {
  const { store, directory } = await openTemporaryStore(context, "pomegr-task-groups-migration-");
  assert.equal(store.readBoard(REPOSITORY).readiness, "ready");
  createTask(store, REPOSITORY);
  assert.equal(metaValue(directory, MARKER), "1");
  assert.deepEqual(groupRows(directory), []);
  assert.equal(rowsOf(directory)[0].step, null);
});
