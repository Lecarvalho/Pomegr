// The agent's report on a task of its session (the one it was started for, or one it is assigned to), and the user's two resolutions.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { sessionAssignedTasks } from "./task-assignments.mjs";
import { deleteTaskAttention, writeTaskAttention } from "./task-attention.mjs";
import { verifyChecks } from "./task-checks.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { writeTaskGroup } from "./task-groups.mjs";
import { releasePause } from "./task-queue-advance.mjs";
import { requestWorktreeCleanup } from "./task-worktree-cleanup.mjs";
import { IN_FLIGHT_STATES, isTaskId, isTaskSessionId, normalizeBlockReason, normalizeQueueTaskPayload, normalizeStoredTask, rowInFlight, taskIdFromNumber } from "./task-record.mjs";

export const TASK_REPORT_ERRORS = Object.freeze(["invalid", "not_found", "task_required", "already_reported", "stalled", "unavailable"]);

const UNRESOLVED_STATES = Object.freeze(["needs_review", "stalled", "blocked"]);
const QUEUE_HOLDING_STATES = Object.freeze(["stalled", "blocked"]);

// A report names its session, optionally one task of that session, and the keys of its kind.
const reportInput = (payload, required, optional = []) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && ["sessionId", ...required].every((key) => Object.hasOwn(payload, key))
  && Object.keys(payload).every((key) => key === "sessionId" || key === "taskId" || required.includes(key) || optional.includes(key))
  && isTaskSessionId(payload.sessionId) && (payload.taskId === undefined || isTaskId(payload.taskId));

const linkedRow = (database, sessionId) => preparedStatement(database, "SELECT * FROM tasks WHERE session_id = ?").get(sessionId);
const taskRow = (database, repositoryId, number) => preparedStatement(database, "SELECT * FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);
const sameTask = (left, right) => left.repository_id === right.repository_id && Number(left.number) === Number(right.number);

// The tasks a session may report: the one Pomegr started it for, then the ones it is assigned to.
function sessionRows(database, sessionId) {
  const linked = linkedRow(database, sessionId);
  const rows = linked ? [linked] : [];
  for (const assigned of sessionAssignedTasks(database, sessionId)) {
    const row = taskRow(database, assigned.repositoryId, assigned.number);
    if (row && !rows.some((entry) => sameTask(entry, row))) rows.push(row);
  }
  return rows;
}

// The one task a report is about: the named one, or the session's only task.
function reportTarget(database, sessionId, taskId) {
  const rows = sessionRows(database, sessionId);
  const named = taskId === undefined ? rows : rows.filter((row) => taskIdFromNumber(Number(row.number)) === taskId);
  if (named.length === 0) return { error: "not_found" };
  return named.length === 1 ? { row: named[0] } : { error: "task_required" };
}

const unreported = (row) => (row.report_at ?? null) === null;
// The first report on a task wins. An assigned session may also report a task Pomegr stalled: its first session ended
// with no report, and the assigned session is the one that resumed the work.
const reportable = (row, sessionId) => unreported(row)
  && (IN_FLIGHT_STATES.includes(row.state) || (row.state === "stalled" && row.session_id !== sessionId));

// Why a task takes no report: Pomegr stalled it before any report from the session it started, or it has an outcome.
const refusal = (row) => (row?.state === "stalled" && unreported(row) ? "stalled" : "already_reported");

export function blockQueue(database, repositoryId, taskId) {
  preparedStatement(database, "UPDATE repositories SET queue_status = 'blocked', queue_blocked_by = ? WHERE repository_id = ? AND queue_status = 'running'")
    .run(taskId, repositoryId);
}

export function releaseQueue(database, repositoryId) {
  const repository = preparedStatement(database, "SELECT queue_status FROM repositories WHERE repository_id = ?").get(repositoryId);
  if (repository?.queue_status !== "blocked") return;
  const next = preparedStatement(database, `SELECT MIN(number) AS number FROM tasks WHERE repository_id = ? AND state IN (${QUEUE_HOLDING_STATES.map(() => "?").join(", ")})`)
    .get(repositoryId, ...QUEUE_HOLDING_STATES);
  const blocker = next?.number === null || next?.number === undefined ? undefined : taskIdFromNumber(Number(next.number));
  if (blocker) preparedStatement(database, "UPDATE repositories SET queue_blocked_by = ? WHERE repository_id = ?").run(blocker, repositoryId);
  else preparedStatement(database, "UPDATE repositories SET queue_status = 'running', queue_blocked_by = NULL WHERE repository_id = ?").run(repositoryId);
}

function storeReport(database, row, { state, at, results, blockReason, attention = null }) {
  // A task an assigned session reports before any session linked keeps no dispatch: a start still in flight links nothing.
  const written = preparedStatement(database, `UPDATE tasks SET state = ?, queue_position = NULL, dispatch_token = NULL, report_at = ?, report_results = ?, report_block_reason = ?, updated_at = ?
    WHERE repository_id = ? AND number = ? AND report_at IS NULL`)
    .run(state, at, JSON.stringify(results), blockReason, at, row.repository_id, row.number);
  if (Number(written.changes) !== 1) return false;
  if (attention === null) deleteTaskAttention(database, row.repository_id, Number(row.number));
  else writeTaskAttention(database, row.repository_id, Number(row.number), attention);
  if (state === "needs_review") moveTaskToRole(database, row.repository_id, Number(row.number), "review");
  if (QUEUE_HOLDING_STATES.includes(state)) blockQueue(database, row.repository_id, taskIdFromNumber(Number(row.number)));
  // A stalled task that is now reported complete holds the queue no longer.
  else if (row.state === "stalled") releaseQueue(database, row.repository_id);
  return true;
}

export function reportableChecks({ database, sessionId, taskId }) {
  if (!isTaskSessionId(sessionId) || (taskId !== undefined && !isTaskId(taskId))) return null;
  const { row } = reportTarget(database, sessionId, taskId);
  const task = row && reportable(row, sessionId) ? normalizeStoredTask(row) : null;
  return task ? [...task.completeWhen.checks] : null;
}

// Stores a report on the task the earlier read chose, if it is still that session's task and still takes a report.
function storeFresh({ database, transaction, payload, row }, report) {
  let fresh = null;
  const stored = transaction(() => {
    fresh = sessionRows(database, payload.sessionId).find((entry) => sameTask(entry, row)) ?? null;
    return fresh !== null && reportable(fresh, payload.sessionId) && storeReport(database, fresh, report);
  });
  return stored ? null : fresh === null ? "not_found" : refusal(fresh);
}

// `complete`: the bound session reports one of its tasks complete.
export function reportComplete({ database, transaction, payload, resolveFacts, now }) {
  if (!reportInput(payload, [], ["attention"])) return { ok: false, error: "invalid" };
  const noted = Object.hasOwn(payload, "attention");
  const attention = noted ? normalizeBlockReason(payload.attention) : null;
  if (attention === undefined || (noted && attention === null)) return { ok: false, error: "invalid" };
  const { row, error } = reportTarget(database, payload.sessionId, payload.taskId);
  if (!row) return { ok: false, error };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  if (!reportable(row, payload.sessionId)) return { ok: false, error: refusal(row) };
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts() : null; } catch { facts = null; }
  const results = verifyChecks(task.completeWhen.checks, facts);
  const state = "needs_review";
  const refused = storeFresh({ database, transaction, payload, row }, { state, at: now(), results, blockReason: null, attention });
  return refused === null ? { ok: true, state, results } : { ok: false, error: refused };
}

// `block`: the bound session reports it cannot continue one of its tasks, with a one-line reason of at most 200 characters.
export function reportBlock({ database, transaction, payload, now }) {
  if (!reportInput(payload, ["reason"])) return { ok: false, error: "invalid" };
  const reason = normalizeBlockReason(payload.reason);
  if (reason === undefined || reason === null) return { ok: false, error: "invalid" };
  const { row, error } = reportTarget(database, payload.sessionId, payload.taskId);
  if (!row) return { ok: false, error };
  if (!normalizeStoredTask(row)) return { ok: false, error: "unavailable" };
  if (!reportable(row, payload.sessionId)) return { ok: false, error: refusal(row) };
  const refused = storeFresh({ database, transaction, payload, row }, { state: "blocked", at: now(), results: [], blockReason: reason });
  return refused === null ? { ok: true, state: "blocked" } : { ok: false, error: refused };
}

const awaitingReport = (row) => rowInFlight(row) && unreported(row);

function unresolvedTask(database, repositoryId, payload) {
  const input = normalizeQueueTaskPayload(payload);
  if (!input) return { error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id, report_at FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { error: "not_found" };
  return UNRESOLVED_STATES.includes(task.state) || awaitingReport(task) ? { number: input.number } : { error: "conflict" };
}

export function resolveDone({ database, repositoryId, now }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  preparedStatement(database, "UPDATE tasks SET state = 'done', queue_position = NULL, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(Date.now(), repositoryId, target.number);
  moveTaskToRole(database, repositoryId, target.number, "done");
  requestWorktreeCleanup(database, repositoryId, target.number);
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(target.number));
  return { ok: true };
}

// `resolve_requeue`: the user sends the task back to the end of the queue for a new session.
export function resolveRequeue({ database, repositoryId, now }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  preparedStatement(database, `UPDATE tasks SET state = 'queued', queue_position = NULL, scheduled_at = NULL, session_id = NULL, dispatch_token = NULL,
    report_at = NULL, report_results = NULL, report_block_reason = NULL, updated_at = ? WHERE repository_id = ? AND number = ?`)
    .run(Date.now(), repositoryId, target.number);
  deleteTaskAttention(database, repositoryId, target.number);
  // A requeued task is an ordinary card again: it left its parallel group when it started over.
  writeTaskGroup(database, repositoryId, target.number, null);
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(target.number));
  return { ok: true };
}
