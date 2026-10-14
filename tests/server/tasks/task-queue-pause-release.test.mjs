// A pause names one task. When that task is deleted or leaves the queue, the pause goes in the same write.

import assert from "node:assert/strict";
import test from "node:test";
import { openTaskStore } from "../../../server/tasks/task-store.mjs";
import {
  REPOSITORY, SESSION, createTask, metaValue, openTemporaryStore, pauseReasonKey, queueRow, queueSettings, queueTask, setMeta, setQueueRow,
  startedTask, updateTask, passingGates, storedQueue,
} from "./queue-test-support.mjs";

const OWN_REASONS = ["worktree_dirty", "session_not_linked"];
const OTHER_REASONS = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed"];

/** Two queued tasks and a queue paused at T-1 with the stored reason; `null` stores no reason. */
async function pausedAtFirst(context, reason) {
  const opened = await openTemporaryStore(context);
  const { store, directory } = opened;
  for (const id of ["T-1", "T-2"]) { createTask(store); queueTask(store, id); }
  assert.equal(queueSettings(store, true).ok, true);
  setQueueRow(directory, "paused", "T-1");
  if (reason !== null) setMeta(directory, pauseReasonKey(), reason);
  assert.deepEqual(storedQueue(store.readBoard(REPOSITORY).queue), { status: "paused", blockedBy: "T-1", pauseReason: reason, order: ["T-1", "T-2"] });
  return opened;
}

const apply = (store, action, id) => {
  const result = store.apply(REPOSITORY, action, { id });
  assert.equal(result.ok, true, action);
  return storedQueue(result.board.queue);
};

test("deleting the task a pause names clears the pause: the queue runs again when the cause was the task's own", async (context) => {
  for (const reason of OWN_REASONS) {
    const { store, directory } = await pausedAtFirst(context, reason);
    assert.deepEqual(apply(store, "delete", "T-1"), { status: "running", blockedBy: null, pauseReason: null, order: ["T-2"] }, reason);
    assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
    assert.equal(metaValue(directory, pauseReasonKey()), null);
    assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [{ repositoryId: REPOSITORY, taskId: "T-2" }] });
  }
});

test("deleting the task a pause names turns the queue off when the cause was not the task's own", async (context) => {
  for (const reason of [...OTHER_REASONS, null]) {
    const { store, directory } = await pausedAtFirst(context, reason);
    assert.deepEqual(apply(store, "delete", "T-1"), { status: "idle", blockedBy: null, pauseReason: null, order: ["T-2"] }, String(reason));
    assert.deepEqual(queueRow(directory), { queue_status: "idle", queue_blocked_by: null });
    assert.equal(metaValue(directory, pauseReasonKey()), null);
    assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
  }
});

test("the paused task and then every queued task deleted leaves a running, empty queue that starts nothing", async (context) => {
  const { store } = await pausedAtFirst(context, "worktree_dirty");
  apply(store, "delete", "T-1");
  assert.deepEqual(apply(store, "delete", "T-2"), { status: "running", blockedBy: null, pauseReason: null, order: [] });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
});

test("a queue that runs again is blocked instead when a stalled or blocked task holds it", async (context) => {
  const { store, directory } = await pausedAtFirst(context, "worktree_dirty");
  updateTask(directory, 2, { state: "stalled" });
  assert.deepEqual(apply(store, "delete", "T-1"), { status: "blocked", blockedBy: "T-2", pauseReason: null, order: [] });
});

test("a pause stays when another task is deleted or removed from the queue", async (context) => {
  for (const action of ["delete", "queue_remove"]) {
    const { store, directory } = await pausedAtFirst(context, "worktree_dirty");
    assert.deepEqual(apply(store, action, "T-2"), { status: "paused", blockedBy: "T-1", pauseReason: "worktree_dirty", order: ["T-1"] }, action);
    assert.equal(metaValue(directory, pauseReasonKey()), "worktree_dirty");
  }
});

test("Remove from queue of the task a pause names clears the pause by the same rule", async (context) => {
  const own = await pausedAtFirst(context, "session_not_linked");
  assert.deepEqual(apply(own.store, "queue_remove", "T-1"), { status: "running", blockedBy: null, pauseReason: null, order: ["T-2"] });
  assert.equal(metaValue(own.directory, pauseReasonKey()), null);
  const other = await pausedAtFirst(context, "cli_missing");
  assert.deepEqual(apply(other.store, "queue_remove", "T-1"), { status: "idle", blockedBy: null, pauseReason: null, order: ["T-2"] });
  assert.equal(metaValue(other.directory, pauseReasonKey()), null);
});

test("Mark done and Requeue of the task a pause names clear the pause by the same rule", async (context) => {
  for (const [action, order] of [["resolve_done", ["T-2"]], ["resolve_requeue", ["T-1", "T-2"]]]) {
    for (const [reason, status] of [["worktree_dirty", "running"], ["start_failed", "idle"]]) {
      const { store, directory } = await pausedAtFirst(context, reason);
      // The task was started by hand after the pause and its session reported.
      startedTask(directory, 1, { session: SESSION, state: "needs_review" });
      assert.deepEqual(apply(store, action, "T-1"), { status, blockedBy: null, pauseReason: null, order }, `${action} ${reason}`);
      assert.equal(metaValue(directory, pauseReasonKey()), null);
    }
  }
});

test("Mark done and Requeue of another task leave the pause as it is", async (context) => {
  for (const action of ["resolve_done", "resolve_requeue"]) {
    const { store, directory } = await pausedAtFirst(context, "worktree_dirty");
    startedTask(directory, 2, { session: SESSION, state: "needs_review" });
    const queue = apply(store, action, "T-2");
    assert.deepEqual([queue.status, queue.blockedBy, queue.pauseReason], ["paused", "T-1", "worktree_dirty"], action);
  }
});

test("a store that already holds a pause at a deleted task never serves its ID, and releases the pause when it opens", async (context) => {
  for (const [reason, status] of [["worktree_dirty", "running"], ["plugin_missing", "idle"]]) {
    const { store, directory } = await openTemporaryStore(context);
    createTask(store);
    queueTask(store, "T-1");
    setQueueRow(directory, "paused", "T-7");
    setMeta(directory, pauseReasonKey(), reason);
    assert.deepEqual(storedQueue(store.readBoard(REPOSITORY).queue), { status: "paused", blockedBy: null, pauseReason: reason, order: ["T-1"] });

    const reopened = openTaskStore({ directory });
    const { queue } = reopened.readBoard(REPOSITORY);
    reopened.close();
    assert.deepEqual(storedQueue(queue), { status, blockedBy: null, pauseReason: null, order: ["T-1"] }, reason);
    assert.deepEqual(queueRow(directory), { queue_status: status, queue_blocked_by: null });
    assert.equal(metaValue(directory, pauseReasonKey()), null);
  }
});

test("opening a store leaves a pause at a task that exists", async (context) => {
  const { directory } = await pausedAtFirst(context, "worktree_dirty");
  const reopened = openTaskStore({ directory });
  const { queue } = reopened.readBoard(REPOSITORY);
  reopened.close();
  assert.deepEqual(storedQueue(queue), { status: "paused", blockedBy: "T-1", pauseReason: "worktree_dirty", order: ["T-1", "T-2"] });
});
