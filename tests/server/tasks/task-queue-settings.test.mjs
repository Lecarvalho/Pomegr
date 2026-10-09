import assert from "node:assert/strict";
import test from "node:test";
import { TASK_DISPATCH_UNBOUND_TTL_MS } from "../../../server/tasks/task-dispatch.mjs";
import { TASK_STORE_SCHEMA_VERSION } from "../../../server/tasks/task-store.mjs";
import {
  OTHER_REPOSITORY, REPOSITORY, SESSION, START_TIME, createTask, metaValue, openTemporaryStore, pauseReasonKey, queueRow, queueSettings, queueTask,
  setMeta, setQueueRow, startedTask, storedDispatch, updateTask, withDatabase, passingGates,
} from "./queue-test-support.mjs";

const EXPIRED = START_TIME - TASK_DISPATCH_UNBOUND_TTL_MS - 1;
const LIVE = START_TIME - 1000;

test("the queue is off by default and a fresh board names no pause reason", async (context) => {
  const { store } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  assert.deepEqual(store.readBoard(REPOSITORY).queue, { status: "idle", blockedBy: null, pauseReason: null, order: ["T-1"] });
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [] });
});

test("turning the queue on runs it, and turning it on again changes nothing", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  queueTask(store, "T-2");
  const first = queueSettings(store, true);
  assert.equal(first.ok, true);
  assert.deepEqual(first.board.queue, { status: "running", blockedBy: null, pauseReason: null, order: ["T-2"] });
  const stored = withDatabase(directory, (database) => database.prepare("SELECT number, updated_at FROM tasks ORDER BY number").all().map((row) => ({ ...row })));
  const again = queueSettings(store, true);
  assert.deepEqual(again.board, first.board);
  assert.deepEqual(withDatabase(directory, (database) => database.prepare("SELECT number, updated_at FROM tasks ORDER BY number").all().map((row) => ({ ...row }))), stored);
  assert.deepEqual(queueRow(directory), { queue_status: "running", queue_blocked_by: null });
});

test("a repository the board never saw can have its queue turned on or off and keeps the default columns", async (context) => {
  const { store } = await openTemporaryStore(context);
  const on = queueSettings(store, true, OTHER_REPOSITORY);
  assert.equal(on.ok, true);
  assert.equal(on.board.queue.status, "running");
  assert.deepEqual(on.board.columns.map((column) => column.name), ["Backlog", "Ready", "In progress", "Review", "Done"]);
  assert.equal(queueSettings(store, false, `repo-${"c3".repeat(12)}`).board.queue.status, "idle");
});

test("turning the queue on with a task that needs the user blocks it at the lowest-numbered such task", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  for (let count = 0; count < 12; count += 1) createTask(store);
  updateTask(directory, 11, { state: "stalled" });
  updateTask(directory, 10, { state: "blocked" });
  updateTask(directory, 3, { state: "needs_review" });
  updateTask(directory, 2, { state: "done" });
  const result = queueSettings(store, true);
  assert.deepEqual({ ...result.board.queue, order: undefined }, { status: "blocked", blockedBy: "T-3", pauseReason: null, order: undefined });
  assert.deepEqual(queueRow(directory), { queue_status: "blocked", queue_blocked_by: "T-3" });
  // On again leaves a blocked queue as it is, so its named task does not change under the user.
  updateTask(directory, 1, { state: "stalled" });
  assert.equal(queueSettings(store, true).board.queue.blockedBy, "T-3");
});

test("turning the queue off idles it from every status and never touches a task or its session", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  startedTask(directory, 1, { session: SESSION });
  const before = withDatabase(directory, (database) => ({ ...database.prepare("SELECT * FROM tasks WHERE number = 1").get() }));
  for (const [status, blockedBy] of [["running", null], ["blocked", "T-1"], ["paused", "T-1"], ["idle", null]]) {
    setQueueRow(directory, status, blockedBy);
    if (status === "paused") setMeta(directory, pauseReasonKey(), "start_failed");
    const off = queueSettings(store, false);
    assert.equal(off.ok, true);
    assert.deepEqual({ ...off.board.queue, order: undefined }, { status: "idle", blockedBy: null, pauseReason: null, order: undefined }, status);
    assert.deepEqual(queueRow(directory), { queue_status: "idle", queue_blocked_by: null }, status);
    assert.equal(metaValue(directory, pauseReasonKey()), null, status);
  }
  assert.deepEqual(withDatabase(directory, (database) => ({ ...database.prepare("SELECT * FROM tasks WHERE number = 1").get() })), before);
});

test("queue_settings takes exactly { on: boolean }", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  setQueueRow(directory, "idle");
  const invalid = [{}, { on: 1 }, { on: 0 }, { on: "true" }, { on: null }, { on: undefined }, { on: true, extra: 1 }, { enabled: true }, { on: true, off: false }, null, [], "on", true, 7, undefined];
  for (const payload of invalid) assert.deepEqual(store.apply(REPOSITORY, "queue_settings", payload), { ok: false, error: "invalid" }, JSON.stringify(payload));
  assert.deepEqual(queueRow(directory), { queue_status: "idle", queue_blocked_by: null });
  // A refused payload does not even create an unseen repository.
  assert.deepEqual(store.apply(OTHER_REPOSITORY, "queue_settings", { on: "yes" }), { ok: false, error: "invalid" });
  assert.equal(withDatabase(directory, (database) => database.prepare("SELECT COUNT(*) AS n FROM repositories WHERE repository_id = ?").get(OTHER_REPOSITORY).n), 0);
});

test("turning the queue on clears an expired start that never reported a session, and only that", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  for (let count = 0; count < 4; count += 1) createTask(store);
  createTask(store, OTHER_REPOSITORY);
  for (const id of ["T-1", "T-2", "T-3", "T-4"]) queueTask(store, id);
  startedTask(directory, 1, { mintedAt: EXPIRED });
  startedTask(directory, 2, { mintedAt: LIVE });
  // A linked task never holds a start, but even a stale value on one is not this action's to clear.
  startedTask(directory, 3, { mintedAt: EXPIRED, session: SESSION });
  startedTask(directory, 1, { mintedAt: EXPIRED, repositoryId: OTHER_REPOSITORY });
  setQueueRow(directory, "paused", "T-1");
  setMeta(directory, pauseReasonKey(), "session_not_linked");
  const updatedAt = withDatabase(directory, (database) => database.prepare("SELECT updated_at FROM tasks WHERE repository_id = ? AND number = 1").get(REPOSITORY).updated_at);

  const result = queueSettings(store, true);
  assert.equal(result.ok, true);
  assert.deepEqual({ ...result.board.queue, order: undefined }, { status: "running", blockedBy: null, pauseReason: null, order: undefined });
  assert.equal(storedDispatch(directory, 1), null);
  assert.equal(storedDispatch(directory, 2), `${"ab".repeat(32)}:${LIVE}`);
  assert.equal(storedDispatch(directory, 3), `${"ab".repeat(32)}:${EXPIRED}`);
  assert.equal(storedDispatch(directory, 4), null);
  assert.equal(storedDispatch(directory, 1, OTHER_REPOSITORY), `${"ab".repeat(32)}:${EXPIRED}`);
  assert.equal(metaValue(directory, pauseReasonKey()), null);
  assert.equal(withDatabase(directory, (database) => database.prepare("SELECT updated_at FROM tasks WHERE repository_id = ? AND number = 1").get(REPOSITORY).updated_at), updatedAt);
});

test("a queue that is already on keeps an expired start, so the pause rule can still see it", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  queueSettings(store, true);
  startedTask(directory, 1, { mintedAt: EXPIRED });
  assert.equal(queueSettings(store, true).ok, true);
  assert.equal(storedDispatch(directory, 1), `${"ab".repeat(32)}:${EXPIRED}`);
});

test("the pause reason lives in meta, is validated on read, and shows only while the queue is paused", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  const reasons = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked"];
  setQueueRow(directory, "paused", "T-1");
  for (const reason of reasons) {
    setMeta(directory, pauseReasonKey(), reason);
    assert.deepEqual({ ...store.readBoard(REPOSITORY).queue, order: undefined }, { status: "paused", blockedBy: "T-1", pauseReason: reason, order: undefined }, reason);
  }
  for (const junk of ["", "unknown", "START_FAILED", "C:\\Users\\secret\\path", "start_failed ", "null"]) {
    setMeta(directory, pauseReasonKey(), junk);
    assert.equal(store.readBoard(REPOSITORY).queue.pauseReason, null, junk);
    assert.equal(store.readBoard(REPOSITORY).readiness, "ready", junk);
  }
  // A reason left behind while the status is not paused is never served.
  setMeta(directory, pauseReasonKey(), "start_failed");
  for (const status of ["idle", "running", "blocked"]) {
    setQueueRow(directory, status, status === "blocked" ? "T-1" : null);
    assert.equal(store.readBoard(REPOSITORY).queue.pauseReason, null, status);
  }
  // Another repository's reason is its own.
  setQueueRow(directory, "paused", "T-1");
  assert.equal(store.readBoard(OTHER_REPOSITORY).queue.pauseReason, null);
  assert.equal(store.readBoard(REPOSITORY).queue.pauseReason, "start_failed");
});

test("turning the queue on after a pause clears the reason from meta and resumes the same task", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  queueTask(store, "T-1");
  setQueueRow(directory, "paused", "T-1");
  setMeta(directory, pauseReasonKey(), "cli_missing");
  assert.equal(store.readBoard(REPOSITORY).queue.pauseReason, "cli_missing");
  const on = queueSettings(store, true);
  assert.deepEqual(on.board.queue, { status: "running", blockedBy: null, pauseReason: null, order: ["T-1"] });
  assert.equal(metaValue(directory, pauseReasonKey()), null);
  assert.deepEqual(store.nextQueueStarts({ resolveGateFacts: passingGates }), { ok: true, starts: [{ repositoryId: REPOSITORY, taskId: "T-1" }] });
});

test("a task that needs the user while the queue is paused or idle leaves the status alone until the queue is turned on", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  setQueueRow(directory, "paused", "T-1");
  setMeta(directory, pauseReasonKey(), "start_failed");
  updateTask(directory, 2, { state: "stalled" });
  assert.equal(store.readBoard(REPOSITORY).queue.status, "paused");
  const on = queueSettings(store, true);
  assert.deepEqual({ ...on.board.queue, order: undefined }, { status: "blocked", blockedBy: "T-2", pauseReason: null, order: undefined });
  assert.equal(metaValue(directory, pauseReasonKey()), null);
});

test("storing the pause reason in meta leaves the schema version and the repository columns as they were", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  setQueueRow(directory, "running");
  store.pauseQueue(REPOSITORY, { id: "T-1", reason: "start_failed" });
  assert.equal(TASK_STORE_SCHEMA_VERSION, 1);
  assert.equal(metaValue(directory, "schema_version"), "1");
  assert.equal(metaValue(directory, pauseReasonKey()), "start_failed");
  const columns = withDatabase(directory, (database) => database.prepare("PRAGMA table_info(repositories)").all().map((row) => row.name));
  assert.deepEqual(columns, ["repository_id", "queue_status", "queue_blocked_by", "created_at"]);
});

test("deleting the task a blocked queue names releases the queue, or names the next task that needs the user", async (context) => {
  const { store, directory } = await openTemporaryStore(context);
  createTask(store);
  createTask(store);
  withDatabase(directory, (database) => database.prepare("UPDATE tasks SET state = 'stalled'").run());
  assert.deepEqual(queueSettings(store, true).board.queue, { status: "blocked", blockedBy: "T-1", pauseReason: null, order: [] });
  assert.deepEqual(store.apply(REPOSITORY, "delete", { id: "T-1" }).board.queue, { status: "blocked", blockedBy: "T-2", pauseReason: null, order: [] });
  assert.deepEqual(store.apply(REPOSITORY, "delete", { id: "T-2" }).board.queue, { status: "running", blockedBy: null, pauseReason: null, order: [] });
});
