// The agent's report on a task of its session (the one it was started for, or one it is assigned to), and the user's two resolutions.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { clearTaskReviewer, taskReviewOutcome } from "./task-review.mjs";
import { sessionAssignedTasks } from "./task-assignments.mjs";
import { deleteTaskAttention, readTaskAttention, writeTaskAttention } from "./task-attention.mjs";
import { verifyChecks } from "./task-checks.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { writeTaskGroup } from "./task-groups.mjs";
import { releasePause } from "./task-queue-advance.mjs";
import { requestWorktreeCleanup } from "./task-worktree-cleanup.mjs";
import { archiveTaskReport } from "./task-report-history.mjs";
import { readTaskEvents, recordTaskEvent } from "./task-events.mjs";
import { taskOutcome, writeTaskOutcome } from "./task-outcomes.mjs";
import { deleteTaskBlockHold, holdTaskBlock, readTaskBlockHolds } from "./task-block-holds.mjs";
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
// Reports remain replaceable until the owner accepts the task. A block is an owner-controlled hold,
// even when the latest report claims completion. The session relation still gates every replacement.
const reportable = (row) => IN_FLIGHT_STATES.includes(row.state) || UNRESOLVED_STATES.includes(row.state);

// A task that takes no report has an outcome. `stalled` stays a known reason for older plugins; it is no longer sent.
const REFUSED = "already_reported";

export function blockQueue(database, repositoryId, taskId) {
  preparedStatement(database, "UPDATE repositories SET queue_status = 'blocked', queue_blocked_by = ? WHERE repository_id = ? AND queue_status = 'running'")
    .run(taskId, repositoryId);
}

export function releaseQueue(database, repositoryId) {
  const repository = preparedStatement(database, "SELECT queue_status FROM repositories WHERE repository_id = ?").get(repositoryId);
  if (repository?.queue_status !== "blocked") return;
  const holds = readTaskBlockHolds(database, repositoryId);
  const next = preparedStatement(database, "SELECT number, state FROM tasks WHERE repository_id = ? ORDER BY number")
    .all(repositoryId).find((row) => QUEUE_HOLDING_STATES.includes(row.state)
      || (row.state === "needs_review" && holds.has(taskIdFromNumber(Number(row.number)))));
  const blocker = next === undefined ? undefined : taskIdFromNumber(Number(next.number));
  if (blocker) preparedStatement(database, "UPDATE repositories SET queue_blocked_by = ? WHERE repository_id = ?").run(blocker, repositoryId);
  else preparedStatement(database, "UPDATE repositories SET queue_status = 'running', queue_blocked_by = NULL WHERE repository_id = ?").run(repositoryId);
}

function storeReport(database, row, { state, at, results, blockReason, attention = null }) {
  // Also captures a block recorded by an older monitor, before separate holds existed.
  if (row.state === "blocked" || state === "blocked") holdTaskBlock(database, row.repository_id, row.number);
  const previous = normalizeStoredTask(row)?.report;
  const previousAttention = readTaskAttention(database, row.repository_id, Number(row.number));
  // Identical retries with identical check results have no additional effect.
  if (previous && row.state === state && previous.blockReason === blockReason && previousAttention === attention
    && JSON.stringify(previous.results) === JSON.stringify(results)) return true;
  if (previous) archiveTaskReport(database, row, { ...previous, attention: previousAttention });
  // A task an assigned session reports before any session linked keeps no dispatch: a start still in flight links nothing.
  const written = preparedStatement(database, `UPDATE tasks SET state = ?, queue_position = NULL, dispatch_token = NULL, report_at = ?, report_results = ?, report_block_reason = ?, updated_at = ?
    WHERE repository_id = ? AND number = ?`)
    .run(state, at, JSON.stringify(results), blockReason, at, row.repository_id, row.number);
  if (Number(written.changes) !== 1) return false;
  if (state !== "needs_review") clearTaskReviewer(database, row.repository_id, Number(row.number));
  recordTaskEvent(database, row.repository_id, Number(row.number), state === "needs_review" ? "review" : "blocked", at, row.session_id);
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
  const task = row && reportable(row) ? normalizeStoredTask(row) : null;
  return task ? [...task.completeWhen.checks] : null;
}

// Stores a report on the task the earlier read chose, if it is still that session's task and still takes a report.
function storeFresh({ database, transaction, payload, row }, report) {
  let fresh = null;
  const state = report.state;
  let ownerHold = false;
  const stored = transaction(() => {
    fresh = sessionRows(database, payload.sessionId).find((entry) => sameTask(entry, row)) ?? null;
    if (fresh === null || !reportable(fresh)) return false;
    const written = storeReport(database, fresh, report);
    ownerHold = readTaskBlockHolds(database, fresh.repository_id).has(taskIdFromNumber(Number(fresh.number)));
    return written;
  });
  return stored ? { state, ownerHold } : { error: fresh === null ? "not_found" : REFUSED };
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
  if (!reportable(row)) return { ok: false, error: REFUSED };
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts() : null; } catch { facts = null; }
  const results = verifyChecks(task.completeWhen.checks, facts);
  const state = "needs_review";
  const stored = storeFresh({ database, transaction, payload, row }, { state, at: now(), results, blockReason: null, attention });
  return stored.error ? { ok: false, error: stored.error } : { ok: true, state: stored.state, results, ...(stored.ownerHold ? { ownerHold: true } : {}) };
}

// `block`: the bound session reports it cannot continue one of its tasks, with a one-line reason of at most 200 characters.
export function reportBlock({ database, transaction, payload, now }) {
  if (!reportInput(payload, ["reason"])) return { ok: false, error: "invalid" };
  const reason = normalizeBlockReason(payload.reason);
  if (reason === undefined || reason === null) return { ok: false, error: "invalid" };
  const { row, error } = reportTarget(database, payload.sessionId, payload.taskId);
  if (!row) return { ok: false, error };
  if (!normalizeStoredTask(row)) return { ok: false, error: "unavailable" };
  if (!reportable(row)) return { ok: false, error: REFUSED };
  const stored = storeFresh({ database, transaction, payload, row }, { state: "blocked", at: now(), results: [], blockReason: reason });
  return stored.error ? { ok: false, error: stored.error } : { ok: true, state: stored.state };
}

const awaitingReport = (row) => rowInFlight(row) && unreported(row);

function unresolvedTask(database, repositoryId, payload) {
  const input = normalizeQueueTaskPayload(payload);
  if (!input) return { error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id, report_at FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { error: "not_found" };
  return UNRESOLVED_STATES.includes(task.state) || awaitingReport(task) ? { number: input.number } : { error: "conflict" };
}

export function resolveDone({ database, repositoryId, now, resolveOutcomeFacts = null }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  markTaskDone({ database, repositoryId, now, resolveOutcomeFacts }, target.number);
  return { ok: true };
}

// The owner's acceptance, shared by Mark done and an explicit card move to Done.
// Callers validate the task and perform this write inside their action's transaction.
export function markTaskDone({ database, repositoryId, now, resolveOutcomeFacts = null }, number) {
  const row = taskRow(database, repositoryId, number);
  const at = Date.now();
  preparedStatement(database, "UPDATE tasks SET state = 'done', queue_position = NULL, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(at, repositoryId, number);
  recordTaskEvent(database, repositoryId, number, "done", at, row.session_id);
  try {
    const events = readTaskEvents(database, repositoryId, number);
    const reviewAt = events.find((event) => event.kind === "review")?.at ?? null;
    const sessionIds = [...new Set(events.filter((event) => ["started", "assigned"].includes(event.kind) && event.sessionId !== null).map((event) => event.sessionId))];
    let facts = null;
    try {
      if (reviewAt !== null) facts = resolveOutcomeFacts?.(sessionIds, reviewAt, taskIdFromNumber(number)) ?? null;
    } catch { /* Missing observation facts stay unknown. */ }
    writeTaskOutcome(database, repositoryId, number, { ...taskOutcome(events, facts, at), ...taskReviewOutcome(database, repositoryId, number) });
  } catch { /* An outcome must never prevent the owner's acceptance. */ }
  moveTaskToRole(database, repositoryId, number, "done");
  deleteTaskBlockHold(database, repositoryId, number);
  clearTaskReviewer(database, repositoryId, number);
  requestWorktreeCleanup(database, repositoryId, number);
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(number));
}

// `resolve_requeue`: the user sends the task back to the end of the queue for a new session.
export function resolveRequeue({ database, repositoryId, now }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  const previous = taskRow(database, repositoryId, target.number);
  const report = normalizeStoredTask(previous)?.report;
  if (report) {
    const attention = readTaskAttention(database, repositoryId, target.number);
    archiveTaskReport(database, previous, { ...report, attention });
  }
  const at = Date.now();
  preparedStatement(database, `UPDATE tasks SET state = 'queued', queue_position = NULL, scheduled_at = NULL, session_id = NULL, dispatch_token = NULL,
    report_at = NULL, report_results = NULL, report_block_reason = NULL, updated_at = ? WHERE repository_id = ? AND number = ?`)
    .run(at, repositoryId, target.number);
  recordTaskEvent(database, repositoryId, target.number, "requeued", at, previous.session_id);
  deleteTaskAttention(database, repositoryId, target.number);
  clearTaskReviewer(database, repositoryId, target.number);
  deleteTaskBlockHold(database, repositoryId, target.number);
  // A requeued task is an ordinary card again: it left its parallel group when it started over.
  writeTaskGroup(database, repositoryId, target.number, null);
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(target.number));
  return { ok: true };
}
