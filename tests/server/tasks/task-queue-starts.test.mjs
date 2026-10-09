import assert from "node:assert/strict";
import test from "node:test";
import { TASK_DISPATCH_UNBOUND_TTL_MS } from "../../../server/tasks/task-dispatch.mjs";
import { TASK_QUEUE_START_LIMIT } from "../../../server/tasks/task-queue-advance.mjs";
import {
  FACTS, OTHER_REPOSITORY, REPOSITORY, SESSION, START_TIME, createTask, metaValue, openTemporaryStore, pauseReasonKey, queueRow, queueSettings,
  queueTask, repositoryNumber, setQueueRow, startedTask, updateTask, withDatabase, passingGates,
} from "./queue-test-support.mjs";

const MINUTE = 60_000;
const start = (taskId, repositoryId = REPOSITORY) => ({ repositoryId, taskId });

/** A running repository with the given number of queued tasks. */
function runningRepository(store, repositoryId, count = 1) {
  for (let index = 0; index < count; index += 1) createTask(store, repositoryId);
  for (let index = 1; index <= count; index += 1) queueTask(store, `T-${index}`, repositoryId);
  assert.equal(queueSettings(store, true, repositoryId).ok, true);
}

test("every running queue answers its next task, in repository order, and starts nothing itself", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, OTHER_REPOSITORY, 2);
  runningRepository(store, REPOSITORY, 2);
  // Queue order, not task number: T-1 re-joins behind T-2.
  store.apply(REPOSITORY, "queue_remove", { id: "T-1" });
  store.apply(REPOSITORY, "queue_add", { id: "T-1" });
  const stored = withDatabase(directory, (database) => database.prepare("SELECT repository_id, number, state, session_id, dispatch_token, updated_at FROM tasks ORDER BY repository_id, number").all().map((row) => ({ ...row })));
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2"), start("T-1", OTHER_REPOSITORY)] });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2"), start("T-1", OTHER_REPOSITORY)] }, "asking again changes nothing");
  assert.deepEqual(withDatabase(directory, (database) => database.prepare("SELECT repository_id, number, state, session_id, dispatch_token, updated_at FROM tasks ORDER BY repository_id, number").all().map((row) => ({ ...row }))), stored);
});

test("a queue that is idle, blocked, or paused answers nothing", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  for (const status of ["idle", "blocked", "paused"]) {
    setQueueRow(directory, status, status === "idle" ? null : "T-1");
    assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, status);
    assert.equal(queueRow(directory).queue_status, status);
  }
});

test("one step at a time: a live start or a linked session without an outcome holds the queue", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  startedTask(directory, 1, { mintedAt: START_TIME - MINUTE });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "start waiting for its session");
  assert.equal(queueRow(directory).queue_status, "running");

  // The session reported back: the start is gone, the task has a session and no outcome yet.
  startedTask(directory, 1, { session: SESSION });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "session working on it");
  clock.now += 24 * 60 * MINUTE;
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "time alone does not release a linked session");

  // A task started by hand, outside the queue, holds it too.
  startedTask(directory, 1, { session: null, state: "not_queued" });
  startedTask(directory, 2, { session: "claude:manual-session" });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "manual start in flight");
  assert.equal(queueRow(directory).queue_status, "running");
});

test("a task with an outcome frees the queue for the next task", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  startedTask(directory, 1, { session: SESSION, state: "done" });
  updateTask(directory, 1, { queue_position: null });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2")] });
});

test("a start whose time ran out with no session pauses the queue as session_not_linked, once, and the same call still serves other repositories", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  runningRepository(store, OTHER_REPOSITORY, 1);
  startedTask(directory, 1, { mintedAt: clock.now });
  clock.now += TASK_DISPATCH_UNBOUND_TTL_MS - 1;
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1", OTHER_REPOSITORY)] }, "still live on its last millisecond");
  assert.equal(queueRow(directory).queue_status, "running");

  clock.now += 1;
  const answer = store.nextQueueStarts({ resolveGateFacts: passingGates });
  assert.deepEqual(answer, { ok: true, starts: [start("T-1", OTHER_REPOSITORY)] });
  assert.equal(JSON.stringify(answer).includes("session_not_linked"), false, "a pause is written, never returned");
  assert.deepEqual(queueRow(directory), { queue_status: "paused", queue_blocked_by: "T-1" });
  assert.equal(metaValue(directory, pauseReasonKey()), "session_not_linked");
  assert.deepEqual(store.readBoard(REPOSITORY).queue, { status: "paused", blockedBy: "T-1", pauseReason: "session_not_linked", order: ["T-1", "T-2"] });
  // The other repository's queue is untouched, and the paused one answers nothing more.
  assert.equal(queueRow(directory, OTHER_REPOSITORY).queue_status, "running");
  assert.equal(metaValue(directory, pauseReasonKey(OTHER_REPOSITORY)), null);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1", OTHER_REPOSITORY)] });
  assert.equal(metaValue(directory, pauseReasonKey()), "session_not_linked");
});

test("turning the queue on after a session_not_linked pause lets the same task start again", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  startedTask(directory, 1, { mintedAt: clock.now });
  clock.now += TASK_DISPATCH_UNBOUND_TTL_MS;
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  assert.equal(queueRow(directory).queue_status, "paused");
  const on = queueSettings(store, true);
  assert.deepEqual(on.board.queue, { status: "running", blockedBy: null, pauseReason: null, order: ["T-1", "T-2"] });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1")] });
});

test("a start that is not the first queued task does not pause the queue", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  startedTask(directory, 2, { mintedAt: clock.now - 3 * TASK_DISPATCH_UNBOUND_TTL_MS });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1")] });
  assert.equal(queueRow(directory).queue_status, "running");
});

test("the queue waits for earlier feature steps and never skips ahead", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  const feature = store.apply(REPOSITORY, "feature_create", { name: "Search" });
  assert.equal(feature.ok, true);
  const featureId = feature.board.features[0].id;
  createTask(store, REPOSITORY, { featureId });
  createTask(store, REPOSITORY, { featureId });
  createTask(store, REPOSITORY);
  queueTask(store, "T-2");
  queueTask(store, "T-3");
  queueSettings(store, true);
  // T-1 is in step 1 and was never queued, so step 1 is not done: T-2 waits, and T-3 does not jump the line.
  assert.deepEqual(store.readBoard(REPOSITORY).tasks.map((task) => [task.id, task.step]), [["T-1", 1], ["T-2", 2], ["T-3", null]]);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  updateTask(directory, 1, { state: "done" });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2")] });
});

test("a running queue whose rows do not project is skipped while the others are served", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 1);
  runningRepository(store, OTHER_REPOSITORY, 1);
  updateTask(directory, 1, { text: "" }, REPOSITORY);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1", OTHER_REPOSITORY)] });
  assert.equal(queueRow(directory).queue_status, "running");
});

test("at most sixteen starts are answered, in repository order", async (context) => {
  const { store } = await openTemporaryStore(context);
  for (let number = 1; number <= 20; number += 1) runningRepository(store, repositoryNumber(number), 1);
  const { starts } = store.nextQueueStarts({ resolveGateFacts: passingGates });
  assert.equal(TASK_QUEUE_START_LIMIT, 16);
  assert.deepEqual(starts, Array.from({ length: 16 }, (_, index) => start("T-1", repositoryNumber(index + 1))));
});

test("the queue runs a task through its session to the next one", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1")] });
  const planned = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  assert.equal(planned.ok, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "start waiting for its session");
  assert.equal(store.bindSession({ token: planned.plan.token, sessionId: SESSION }).ok, true);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "session working");
  clock.now += 2 * TASK_DISPATCH_UNBOUND_TTL_MS;
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "a bound session never expires");
  assert.equal(store.completeTask({ sessionId: SESSION }, () => null).state, "done");
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2")] });
  assert.equal(queueRow(directory).queue_status, "running");
});

test("a failed report blocks the queue and nothing starts until the user resolves it", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  const planned = store.planStart(REPOSITORY, { id: "T-1" }, () => FACTS, passingGates);
  store.bindSession({ token: planned.plan.token, sessionId: SESSION });
  assert.equal(store.blockTask({ sessionId: SESSION, reason: "cannot continue" }).state, "blocked");
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  assert.deepEqual(queueRow(directory), { queue_status: "blocked", queue_blocked_by: "T-1" });
  assert.equal(store.apply(REPOSITORY, "resolve_done", { id: "T-1" }).board.queue.status, "running");
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2")] });
});

test("pauseQueue pauses a running queue with the reported reason and names the task", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 2);
  for (const reason of ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed"]) {
    setQueueRow(directory, "running");
    assert.deepEqual(store.pauseQueue(REPOSITORY, { id: "T-2", reason }), { ok: true }, reason);
    assert.deepEqual(queueRow(directory), { queue_status: "paused", queue_blocked_by: "T-2" });
    assert.deepEqual(store.readBoard(REPOSITORY).queue, { status: "paused", blockedBy: "T-2", pauseReason: reason, order: ["T-1", "T-2"] });
  }
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
});

test("pauseQueue changes nothing unless the queue is running, and still answers ok", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  for (const [status, blockedBy] of [["idle", null], ["blocked", "T-1"], ["paused", "T-1"]]) {
    setQueueRow(directory, status, blockedBy);
    if (status === "paused") store.pauseQueue(REPOSITORY, { id: "T-1", reason: "cli_missing" });
    const before = [queueRow(directory), metaValue(directory, pauseReasonKey())];
    assert.deepEqual(store.pauseQueue(REPOSITORY, { id: "T-2", reason: "start_failed" }), { ok: true }, status);
    assert.deepEqual([queueRow(directory), metaValue(directory, pauseReasonKey())], before, status);
  }
  assert.equal(metaValue(directory, pauseReasonKey()), null, "an idle or blocked queue never gains a reason");
});

test("pauseQueue refuses a malformed payload, a reason it may not take, and a task that does not exist", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  runningRepository(store, REPOSITORY, 1);
  const invalid = [
    {}, { id: "T-1" }, { reason: "start_failed" }, { id: "T-1", reason: "session_not_linked" }, { id: "T-1", reason: "other" }, { id: "T-1", reason: "" },
    { id: "T-1", reason: null }, { id: "T-1", reason: 3 }, { id: "T-0", reason: "start_failed" }, { id: "t-1", reason: "start_failed" }, { id: 1, reason: "start_failed" },
    { id: "T-1", reason: "start_failed", extra: true }, null, [], "T-1", 7, undefined,
  ];
  for (const payload of invalid) assert.deepEqual(store.pauseQueue(REPOSITORY, payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(store.pauseQueue("repo-nope", { id: "T-1", reason: "start_failed" }), { ok: false, error: "invalid" });
  assert.deepEqual(store.pauseQueue(REPOSITORY, { id: "T-9", reason: "start_failed" }), { ok: false, error: "not_found" });
  assert.deepEqual(store.pauseQueue(`repo-${"c3".repeat(12)}`, { id: "T-1", reason: "start_failed" }), { ok: false, error: "not_found" });
  assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
  assert.equal(metaValue(directory, pauseReasonKey()), null);
});

test("the queue methods answer a fixed unavailable error once the store is closed", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store);
  store.close();
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: false, error: "unavailable" });
  assert.deepEqual(store.pauseQueue(REPOSITORY, { id: "T-1", reason: "start_failed" }), { ok: false, error: "unavailable" });
  assert.deepEqual(store.apply(REPOSITORY, "queue_settings", { on: true }), { ok: false, error: "conflict" });
});

/** A running queue over one feature: `steps` lists the step of each task, T-1 first. */
function runningFeature(store, steps) {
  const feature = store.apply(REPOSITORY, "feature_create", { name: "Search" });
  assert.equal(feature.ok, true);
  const featureId = feature.board.features[0].id;
  steps.forEach((step, index) => {
    createTask(store, REPOSITORY, { featureId, step });
    queueTask(store, `T-${index + 1}`);
  });
  assert.equal(queueSettings(store, true).ok, true);
}

test("the queued tasks of one step are answered together, and the next step waits for all of them", async (context) => {
  const { store, clock, directory } = await openTemporaryStore(context);
  runningFeature(store, [1, 1, 2]);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-1"), start("T-2")] });
  // T-1 started; T-2 has not yet: it is still answered, alone.
  startedTask(directory, 1, { mintedAt: clock.now });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-2")] });
  startedTask(directory, 1, { session: SESSION });
  startedTask(directory, 2, { session: "claude:second-session" });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] }, "the step is in flight");
  // One task done is not the step done.
  updateTask(directory, 1, { state: "done", queue_position: null });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  updateTask(directory, 2, { state: "done", queue_position: null });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [start("T-3")] });
});

test("each task of a step is judged by the gates on its own", async (context) => {
  const { store } = await openTemporaryStore(context);
  runningFeature(store, [1, 1]);
  assert.equal(store.apply(REPOSITORY, "update", { id: "T-1", run: { provider: "codex", model: null, effort: null } }).ok, true);
  const codexOver = () => ({ ...passingGates(), usage: { ...passingGates().usage, codex: { fiveHourPercent: 99, sevenDayPercent: 10 } } });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: codexOver }), { ok: true, starts: [start("T-2")] });
  assert.equal(store.readBoard(REPOSITORY).queue.status, "running");
});

test("the starts of one step stop at the sixteen-start limit", async (context) => {
  const { store } = await openTemporaryStore(context);
  runningFeature(store, Array.from({ length: TASK_QUEUE_START_LIMIT + 2 }, () => 1));
  const answer = store.nextQueueStarts({ resolveGateFacts: passingGates });
  assert.equal(answer.starts.length, TASK_QUEUE_START_LIMIT);
  assert.deepEqual(answer.starts[TASK_QUEUE_START_LIMIT - 1], start(`T-${TASK_QUEUE_START_LIMIT}`));
});
