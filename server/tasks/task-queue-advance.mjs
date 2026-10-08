// How the queue moves: the user's switch, the monitor-wide question "which task starts next", and the pause a
// failed start writes.
//
// The queue is per repository and off by default (`idle`). Turning it on makes it `running`, or `blocked` when a
// task already needs the user. The pure rules (`task-queue.mjs`) decide what happens next; this module only feeds
// them committed store facts and writes the answer. It starts nothing: the desktop turns an answer into a session.
//
// A queue pauses when a start it made did not succeed, and the fixed reason is kept in the existing `meta` table
// under `queue_pause_reason:<repositoryId>`, so the schema version does not change and an older build still opens
// the store. The row exists only while the queue is paused; whatever moves the queue out of paused removes it.
//
// Before a start, the start gates (`task-gates.mjs`) judge facts the entry point read from committed observation.
// A held start changes nothing: the queue stays `running`, the task stays queued, and the next question judges the
// gates again. The usage threshold is a per-repository setting kept in `meta` under
// `queue_gate_threshold:<repositoryId>`; no row means the default.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { dispatchStanding } from "./task-dispatch.mjs";
import { DEFAULT_TASK_GATE_THRESHOLD, evaluateGates, normalizeGateThreshold, queueGates } from "./task-gates.mjs";
import { nextQueueStart, previousStepBlocker, queueWhenTurnedOn } from "./task-queue.mjs";
import { isRepositoryId, isTaskId, projectBoard, taskIdFromNumber } from "./task-record.mjs";

/** The reasons the desktop may report. `session_not_linked` is found here, from an expired dispatch, never reported. */
export const TASK_QUEUE_PAUSE_REQUEST_REASONS = Object.freeze(["cli_missing", "plugin_missing", "unsupported_platform", "start_failed"]);
/** Starts answered in one call. */
export const TASK_QUEUE_START_LIMIT = 16;

/** States of a task with a linked session that has not reported: the session is working on it. */
const IN_FLIGHT_STATES = new Set(["not_queued", "queued", "scheduled"]);

const hasExactKeys = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

const pauseReasonKey = (repositoryId) => `queue_pause_reason:${repositoryId}`;

/** The stored pause reason as written, or null. `projectBoard` validates it against the fixed list and the status. */
export function readPauseReason(database, repositoryId) {
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(pauseReasonKey(repositoryId))?.value ?? null;
}

const clearPauseReason = (database, repositoryId) =>
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(pauseReasonKey(repositoryId));

const gateThresholdKey = (repositoryId) => `queue_gate_threshold:${repositoryId}`;

/** The repository's usage threshold; a missing or malformed row is the default. */
export function readGateThreshold(database, repositoryId) {
  const stored = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(gateThresholdKey(repositoryId))?.value;
  return normalizeGateThreshold(Number(stored)) ?? DEFAULT_TASK_GATE_THRESHOLD;
}

// The facts the entry point committed for one repository; a missing or throwing resolver is no facts, which holds every gate.
function gateFacts(resolveGateFacts, repositoryId) {
  try { return typeof resolveGateFacts === "function" ? resolveGateFacts(repositoryId) ?? null : null; } catch { return null; }
}

/** A task with no provider runs on Claude Code (`task-dispatch.mjs`). */
const startProvider = (task) => task.run.provider ?? "claude";

/**
 * Whether the start gates let one task of a projected board start now, judged from `resolveGateFacts(repositoryId)`.
 * Returns `{ ok, reasons }`; a task the board does not hold is not ok.
 */
export function startGates({ database, repositoryId, board, taskId, resolveGateFacts }) {
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) return { ok: false, reasons: [] };
  return evaluateGates({ provider: startProvider(task), blockedBy: previousStepBlocker(taskId, board.tasks, board.features) },
    gateFacts(resolveGateFacts, repositoryId), { threshold: readGateThreshold(database, repositoryId) });
}

/**
 * The board with `queue.gates` filled from `resolveGateFacts(repositoryId)`: the readings, and why the next task waits.
 * A caller that hands in no resolver asked for no gates, and the board carries none.
 */
export function fillQueueGates({ database, board, resolveGateFacts }) {
  if (board?.readiness !== "ready" || typeof resolveGateFacts !== "function") return board;
  const task = board.tasks.find((candidate) => candidate.id === board.queue.order[0]);
  const next = task ? { taskId: task.id, provider: startProvider(task), blockedBy: previousStepBlocker(task.id, board.tasks, board.features) } : null;
  const gates = queueGates(next, gateFacts(resolveGateFacts, board.repositoryId), { threshold: readGateThreshold(database, board.repositoryId) });
  return { ...board, queue: { ...board.queue, gates } };
}

/** Pauses a running queue at a task with a fixed reason. A queue in any other status is left alone. Returns whether it paused. */
function pauseRunningQueue(database, repositoryId, taskId, reason) {
  const paused = preparedStatement(database, "UPDATE repositories SET queue_status = 'paused', queue_blocked_by = ? WHERE repository_id = ? AND queue_status = 'running'")
    .run(taskId, repositoryId);
  if (Number(paused.changes) !== 1) return false;
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(pauseReasonKey(repositoryId), reason);
  return true;
}

// An expired start never reported its session. Clearing it makes the task startable again; a live one, and a task that
// has a session, are not touched.
function clearExpiredDispatches(database, repositoryId, at) {
  const clear = preparedStatement(database, "UPDATE tasks SET dispatch_token = NULL WHERE repository_id = ? AND number = ? AND session_id IS NULL AND dispatch_token = ?");
  for (const row of preparedStatement(database, "SELECT number, dispatch_token FROM tasks WHERE repository_id = ? AND session_id IS NULL AND dispatch_token IS NOT NULL").all(repositoryId)) {
    if (dispatchStanding(row.dispatch_token, at) === "expired") clear.run(repositoryId, row.number, row.dispatch_token);
  }
}

/**
 * `queue_settings`, a store action with exactly one setting. `{ threshold }` is one of the fixed usage thresholds and
 * changes nothing else: the queue keeps its status. `{ on: boolean }` is the switch. Off sets the queue idle and clears whatever it
 * named; running sessions are never touched. On does nothing to a queue that is already on. From idle or paused it
 * clears the pause reason and any expired start, so the task that did not start can start again, and then runs, or
 * is blocked at the lowest-numbered task that needs the user.
 */
export function queueSettings({ database, repositoryId, ensureRepository, now }, payload) {
  if (hasExactKeys(payload, ["threshold"])) {
    const threshold = normalizeGateThreshold(payload.threshold);
    if (threshold === undefined) return { ok: false, error: "invalid" };
    ensureRepository(database, repositoryId);
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(gateThresholdKey(repositoryId), String(threshold));
    return { ok: true };
  }
  if (!hasExactKeys(payload, ["on"]) || typeof payload.on !== "boolean") return { ok: false, error: "invalid" };
  ensureRepository(database, repositoryId);
  const status = preparedStatement(database, "SELECT queue_status FROM repositories WHERE repository_id = ?").get(repositoryId)?.queue_status;
  if (payload.on && (status === "running" || status === "blocked")) return { ok: true };
  let next = { status: "idle", blockedBy: null };
  if (payload.on) {
    clearExpiredDispatches(database, repositoryId, now());
    next = queueWhenTurnedOn(preparedStatement(database, "SELECT number, state FROM tasks WHERE repository_id = ?").all(repositoryId)
      .map((row) => ({ id: taskIdFromNumber(Number(row.number)), state: row.state })));
  }
  preparedStatement(database, "UPDATE repositories SET queue_status = ?, queue_blocked_by = ? WHERE repository_id = ?").run(next.status, next.blockedBy, repositoryId);
  clearPauseReason(database, repositoryId);
  return { ok: true };
}

// One stored task as the pure rule sees it. The row already projected, so its number and fields are valid.
function queueRecord(row, at) {
  const standing = dispatchStanding(row.dispatch_token, at);
  const linked = (row.session_id ?? null) !== null;
  return {
    id: taskIdFromNumber(Number(row.number)),
    featureId: row.feature_id ?? null,
    step: row.step ?? null,
    state: row.state,
    queuePosition: row.queue_position ?? null,
    inFlight: standing === "live" || (linked && IN_FLIGHT_STATES.has(row.state)),
    unlinked: !linked && standing === "expired",
  };
}

/**
 * Which tasks the running queues start now. For every repository whose queue is `running`, in repository ID order,
 * the pure rule answers a start, a pause, or nothing; a pause is written at once as `session_not_linked`, and at most
 * `TASK_QUEUE_START_LIMIT` starts are answered. A start the gates hold is not answered and changes nothing, so the
 * task waits and is judged again on the next call. A repository whose rows do not project is skipped. Answers
 * `{ ok: true, starts: [{ repositoryId, taskId }] }`, and starts nothing itself. `loadRows(repositoryId)` is the store's
 * row reader and `resolveGateFacts(repositoryId)` the entry point's committed gate facts.
 */
export function nextQueueStarts({ database, transaction, loadRows, resolveGateFacts, now }) {
  const at = now();
  const starts = [];
  const pauses = [];
  for (const { repository_id: repositoryId } of preparedStatement(database, "SELECT repository_id FROM repositories WHERE queue_status = 'running' ORDER BY repository_id").all()) {
    if (starts.length >= TASK_QUEUE_START_LIMIT) break;
    if (!isRepositoryId(repositoryId)) continue;
    const rows = loadRows(repositoryId);
    const board = projectBoard(repositoryId, rows);
    if (!board) continue;
    const decision = nextQueueStart({ status: board.queue.status, tasks: rows.tasks.map((row) => queueRecord(row, at)), features: board.features });
    if (decision?.start) {
      if (startGates({ database, repositoryId, board, taskId: decision.start, resolveGateFacts }).ok) starts.push({ repositoryId, taskId: decision.start });
    }
    else if (decision?.pause) pauses.push({ repositoryId, taskId: decision.pause });
  }
  if (pauses.length > 0) {
    transaction(() => { for (const { repositoryId, taskId } of pauses) pauseRunningQueue(database, repositoryId, taskId, "session_not_linked"); });
  }
  return { ok: true, starts };
}

/**
 * `queue-pause`: the desktop reports that a start it was asked to make did not succeed. The payload is exactly
 * `{ id, reason }` with a reason from `TASK_QUEUE_PAUSE_REQUEST_REASONS`. The task must exist. Only a `running` queue
 * pauses; for any other status nothing changes and the answer is still `{ ok: true }`.
 */
export function pauseQueue({ database, transaction, repositoryId, payload }) {
  if (!isRepositoryId(repositoryId) || !hasExactKeys(payload, ["id", "reason"]) || !isTaskId(payload.id)
    || typeof payload.reason !== "string" || !TASK_QUEUE_PAUSE_REQUEST_REASONS.includes(payload.reason)) return { ok: false, error: "invalid" };
  const found = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, Number(payload.id.slice(2)));
  if (found === undefined) return { ok: false, error: "not_found" };
  transaction(() => { pauseRunningQueue(database, repositoryId, payload.id, payload.reason); });
  return { ok: true };
}
