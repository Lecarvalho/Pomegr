
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { DEFAULT_TASK_GATE_THRESHOLD, evaluateGates, normalizeGateThreshold, queueGates } from "./task-gates.mjs";
import { earlierTaskBlocker, nextQueueStart, queueWhenTurnedOn, queueWindowHold, taskIsDue } from "./task-queue.mjs";
import { explainQueueWaits } from "./task-queue-waits.mjs";
import { unfinishedAfter } from "./task-after.mjs";
import { readTaskBlockHolds } from "./task-block-holds.mjs";
import { isRepositoryId, isTaskId, normalizeQueueSchedule, projectBoard, rowInFlight, taskIdFromNumber } from "./task-record.mjs";

// The reasons the desktop may report.
export const TASK_QUEUE_PAUSE_REQUEST_REASONS = Object.freeze(["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "worktree_dirty"]);
export const TASK_QUEUE_START_LIMIT = 16;

const hasExactKeys = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

const pauseReasonKey = (repositoryId) => `queue_pause_reason:${repositoryId}`;

export function readPauseReason(database, repositoryId) {
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(pauseReasonKey(repositoryId))?.value ?? null;
}

const clearPauseReason = (database, repositoryId) =>
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(pauseReasonKey(repositoryId));

const gateThresholdKey = (repositoryId) => `queue_gate_threshold:${repositoryId}`;

export function readGateThreshold(database, repositoryId) {
  const stored = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(gateThresholdKey(repositoryId))?.value;
  return normalizeGateThreshold(Number(stored)) ?? DEFAULT_TASK_GATE_THRESHOLD;
}

const startAtKey = (repositoryId) => `queue_start_at:${repositoryId}`;
const stopAfterKey = (repositoryId) => `queue_stop_after:${repositoryId}`;

// The queue's own start and stop times in epoch milliseconds, each null when not set or not a time.
export function readQueueSchedule(database, repositoryId) {
  const read = (key) => {
    const stored = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value;
    const time = typeof stored === "string" && /^[0-9]{1,16}$/u.test(stored) ? Number(stored) : null;
    return Number.isSafeInteger(time) ? time : null;
  };
  return { startAt: read(startAtKey(repositoryId)), stopAfter: read(stopAfterKey(repositoryId)) };
}

function writeQueueSchedule(database, repositoryId, schedule) {
  for (const [key, time] of [[startAtKey(repositoryId), schedule.startAt], [stopAfterKey(repositoryId), schedule.stopAfter]]) {
    if (time === null) preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
    else preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(time));
  }
}

function gateFacts(resolveGateFacts, repositoryId) {
  try { return typeof resolveGateFacts === "function" ? resolveGateFacts(repositoryId) ?? null : null; } catch { return null; }
}

const startProvider = (task) => task.run.provider ?? "claude";

export function startGates({ database, repositoryId, board, rows, taskId, resolveGateFacts, at, manual = false }) {
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { ok: false, reasons: [] };
  const gates = evaluateGates({ provider: startProvider(task), blockedBy: manual ? null : earlierTaskBlocker(taskId, queueRecords(rows, at)) },
    gateFacts(resolveGateFacts, repositoryId), { threshold: readGateThreshold(database, repositoryId) });
  const early = task.state === "scheduled" && task.scheduledAt !== null && !taskIsDue(Date.parse(task.scheduledAt), at);
  // A task that runs after an unfinished task never starts, by the queue or by hand.
  const after = (task.after ?? []).some((id) => board.tasks.some((other) => other.id === id && other.state !== "done"));
  return early || after ? { ok: false, reasons: gates.reasons, early: true, ...(after ? { after: true } : {}) } : gates;
}

export function fillQueueGates({ database, board, rows, resolveGateFacts, at }) {
  if (board?.readiness !== "ready" || typeof resolveGateFacts !== "function") return board;
  // The next task is the one the queue would start first: a waiting member of the group that runs, before the top of Ready.
  const records = queueRecords(rows, at);
  const decision = nextQueueStart({ status: "running", tasks: records });
  const nextId = decision?.starts?.[0] ?? decision?.pause ?? board.queue.order[0];
  const task = board.tasks.find((candidate) => candidate.id === nextId);
  const next = task ? { taskId: task.id, provider: startProvider(task), blockedBy: earlierTaskBlocker(task.id, records) } : null;
  const gates = queueGates(next, gateFacts(resolveGateFacts, board.repositoryId), { threshold: readGateThreshold(database, board.repositoryId) });
  const hold = gates.next ? queueWindowHold(readQueueSchedule(database, board.repositoryId), at) : null;
  if (hold) gates.next = { ...gates.next, reasons: [...gates.next.reasons, hold] };
  return { ...board, queue: { ...board.queue, gates } };
}

// Why each waiting task has not started (task-queue-waits.mjs). A task the running queue would start now is judged by
// the start gates and the queue's window, the rules its start obeys; a queue that is not running says only that.
export function fillQueueWaits({ database, board, rows, resolveGateFacts, at }) {
  if (board?.readiness !== "ready" || !Array.isArray(rows?.tasks)) return board;
  const { repositoryId } = board;
  const running = board.queue.status === "running";
  const hold = running ? queueWindowHold(readQueueSchedule(database, repositoryId), at) : null;
  const waits = explainQueueWaits({ status: board.queue.status, blockedBy: board.queue.blockedBy, tasks: queueRecords(rows, at) })
    .map(({ candidate = false, ...wait }) => {
      if (!candidate || !running) return wait;
      const held = [...startGates({ database, repositoryId, board, rows, taskId: wait.taskId, resolveGateFacts, at }).reasons, ...(hold ? [hold] : [])];
      return { ...wait, reasons: [...wait.reasons, ...held.map((reason) => ({ reason, taskIds: [], more: 0 }))] };
    });
  return waits.length === 0 ? board : { ...board, queue: { ...board.queue, waits } };
}

function pauseRunningQueue(database, repositoryId, taskId, reason) {
  const paused = preparedStatement(database, "UPDATE repositories SET queue_status = 'paused', queue_blocked_by = ? WHERE repository_id = ? AND queue_status = 'running'")
    .run(taskId, repositoryId);
  if (Number(paused.changes) !== 1) return false;
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(pauseReasonKey(repositoryId), reason);
  return true;
}

// An expired start never reported its session.
function clearExpiredDispatches(database, repositoryId, at) {
  const clear = preparedStatement(database, "UPDATE tasks SET dispatch_token = NULL WHERE repository_id = ? AND number = ? AND session_id IS NULL AND dispatch_token = ?");
  for (const row of preparedStatement(database, "SELECT number, dispatch_token FROM tasks WHERE repository_id = ? AND session_id IS NULL AND dispatch_token IS NOT NULL").all(repositoryId)) {
    if (dispatchStanding(row.dispatch_token, at) === "expired") clear.run(repositoryId, row.number, row.dispatch_token);
  }
}

// `queue_settings`, a store action with exactly one setting.
export function queueSettings({ database, repositoryId, ensureRepository, now }, payload) {
  if (hasExactKeys(payload, ["threshold"])) {
    const threshold = normalizeGateThreshold(payload.threshold);
    if (threshold === undefined) return { ok: false, error: "invalid" };
    ensureRepository(database, repositoryId);
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(gateThresholdKey(repositoryId), String(threshold));
    return { ok: true };
  }
  if (hasExactKeys(payload, ["schedule"])) {
    const schedule = normalizeQueueSchedule(payload.schedule, readQueueSchedule(database, repositoryId), now());
    if (schedule === undefined) return { ok: false, error: "invalid" };
    ensureRepository(database, repositoryId);
    writeQueueSchedule(database, repositoryId, schedule);
    return { ok: true };
  }
  if (!hasExactKeys(payload, ["on"]) || typeof payload.on !== "boolean") return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const status = preparedStatement(database, "SELECT queue_status FROM repositories WHERE repository_id = ?").get(repositoryId)?.queue_status;
  if (payload.on && (status === "running" || status === "blocked")) return { ok: true };
  writeQueueStatus(database, repositoryId, payload.on ? turnedOn(database, repositoryId, now()) : QUEUE_OFF);
  return { ok: true };
}

const QUEUE_OFF = Object.freeze({ status: "idle", blockedBy: null });

function turnedOn(database, repositoryId, at) {
  clearExpiredDispatches(database, repositoryId, at);
  const holds = readTaskBlockHolds(database, repositoryId);
  return queueWhenTurnedOn(preparedStatement(database, "SELECT number, state FROM tasks WHERE repository_id = ?").all(repositoryId)
    .map((row) => ({ id: taskIdFromNumber(Number(row.number)), state: row.state,
      held: row.state === "needs_review" && holds.has(taskIdFromNumber(Number(row.number))) })));
}

function writeQueueStatus(database, repositoryId, next) {
  preparedStatement(database, "UPDATE repositories SET queue_status = ?, queue_blocked_by = ? WHERE repository_id = ?").run(next.status, next.blockedBy, repositoryId);
  clearPauseReason(database, repositoryId);
}

// The pause reasons whose cause is the named task itself, so the cause goes when the task goes.
const TASK_OWN_PAUSE_REASONS = Object.freeze(["worktree_dirty", "session_not_linked"]);

function endPause(database, repositoryId, at) {
  const resumes = TASK_OWN_PAUSE_REASONS.includes(readPauseReason(database, repositoryId));
  writeQueueStatus(database, repositoryId, resumes ? turnedOn(database, repositoryId, at) : QUEUE_OFF);
}

// A pause must not keep naming a task that was deleted or left the queue. Call it after the task's own write.
export function releasePause({ database, repositoryId, now }, taskId) {
  const repository = preparedStatement(database, "SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId);
  if (repository?.queue_status === "paused" && repository.queue_blocked_by === taskId) endPause(database, repositoryId, now());
}

// A store written before `releasePause` may hold a pause at a task that is gone.
export function releaseDanglingPause({ database, repositoryId, now }) {
  const repository = preparedStatement(database, "SELECT queue_status, queue_blocked_by FROM repositories WHERE repository_id = ?").get(repositoryId);
  if (repository?.queue_status !== "paused" || !isTaskId(repository.queue_blocked_by)) return;
  const found = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(repository.queue_blocked_by.slice(2)));
  if (found === undefined) endPause(database, repositoryId, now());
}

function queueRecord(row, at, states) {
  const standing = dispatchStanding(row.dispatch_token, at);
  const linked = (row.session_id ?? null) !== null;
  return {
    id: taskIdFromNumber(Number(row.number)),
    group: row.group ?? null,
    waitsFor: unfinishedAfter(row.after, states).map(taskIdFromNumber),
    state: row.state,
    queuePosition: row.position ?? null,
    due: row.state === "scheduled" && taskIsDue(row.scheduled_at ?? null, at),
    inFlight: rowInFlight(row, at),
    unlinked: !linked && standing === "expired",
  };
}

const queueRecords = (rows, at) => {
  const tasks = rows?.tasks ?? [];
  const states = new Map(tasks.map((row) => [Number(row.number), row.state]));
  return tasks.map((row) => queueRecord(row, at, states));
};

// Which tasks the running queues start now.
export function nextQueueStarts({ database, transaction, loadRows, resolveGateFacts, now }) {
  const at = now();
  const starts = [];
  const pauses = [];
  for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM repositories WHERE queue_status = 'running' ORDER BY repository_id").all()) {
    if (starts.length >= TASK_QUEUE_START_LIMIT) break;
    if (!isRepositoryId(repositoryId)) continue;
    const rows = loadRows(repositoryId);
    const board = projectBoard(repositoryId, rows, { at });
    if (!board) continue;
    const held = queueWindowHold(readQueueSchedule(database, repositoryId), at) !== null;
    const decision = nextQueueStart({ status: board.queue.status, tasks: queueRecords(rows, at) });
    if (decision?.starts) {
      for (const taskId of held ? [] : decision.starts) {
        if (starts.length >= TASK_QUEUE_START_LIMIT) break;
        if (startGates({ database, repositoryId, board, rows, taskId, resolveGateFacts, at }).ok) starts.push({ repositoryId, taskId });
      }
    }
    else if (decision?.pause) pauses.push({ repositoryId, taskId: decision.pause });
  }
  if (pauses.length > 0) {
    transaction(() => { for (const { repositoryId, taskId } of pauses) pauseRunningQueue(database, repositoryId, taskId, "session_not_linked"); });
  }
  return { ok: true, starts };
}

// `queue-pause`: the desktop reports that a start it was asked to make did not succeed.
export function pauseQueue({ database, transaction, repositoryId, payload }) {
  if (!isRepositoryId(repositoryId) || !hasExactKeys(payload, ["id", "reason"]) || !isTaskId(payload.id)
    || typeof payload.reason !== "string" || !TASK_QUEUE_PAUSE_REQUEST_REASONS.includes(payload.reason)) return { ok: false, error: "invalid" };
  const found = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(payload.id.slice(2)));
  if (found === undefined) return { ok: false, error: "not_found" };
  transaction(() => { pauseRunningQueue(database, repositoryId, payload.id, payload.reason); });
  return { ok: true };
}
