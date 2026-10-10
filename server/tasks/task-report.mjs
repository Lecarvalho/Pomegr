// The agent's report on the task its session was started for, and the user's two resolutions.
//
// `complete` verifies the task's checked conditions from committed repository facts and sets Done or
// Needs review; `block` stores the agent's bounded reason and sets Blocked by agent. Both find the task
// only through the session the harness bound the call to, and a task takes one report per dispatch: a
// second report, or a report on a task that already has an outcome, changes nothing. The stored report
// holds only `{ check, passed }` results, the time, and the block reason. A task is never completed here
// without a report.
//
// A failed check or a block stops a running queue (the task is named in `queue_blocked_by`); resolving
// the last task that needs the user lets it run again. An idle or paused queue keeps its status.
//
// The write that sets Done or Needs review also moves the card to the column that holds that role
// (task-columns.mjs). Blocked leaves the card where it is; Requeue puts it back in Ready, last, like any task that
// joins the queue (`settleReadyColumn`, run by the store after the action).

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { allChecksPassed, verifyChecks } from "./task-checks.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { IN_FLIGHT_STATES, isTaskSessionId, normalizeBlockReason, normalizeQueueTaskPayload, normalizeStoredTask, rowInFlight, taskIdFromNumber } from "./task-record.mjs";

export const TASK_REPORT_ERRORS = Object.freeze(["invalid", "not_found", "already_reported", "unavailable"]);

/** Outcomes that need the user and hold the queue. */
const UNRESOLVED_STATES = Object.freeze(["needs_review", "stalled", "blocked"]);

const hasExactKeys = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

const linkedRow = (database, sessionId) => preparedStatement(database, "SELECT * FROM tasks WHERE session_id = ?").get(sessionId);

// A session can still report on a task in flight that has no report yet; an outcome is final for its dispatch.
const reportable = (row) => IN_FLIGHT_STATES.includes(row.state) && (row.report_at ?? null) === null;

// The first task that needs the user holds a running queue; a queue already blocked keeps its first blocker.
export function blockQueue(database, repositoryId, taskId) {
  preparedStatement(database, "UPDATE repositories SET queue_status = 'blocked', queue_blocked_by = ? WHERE repository_id = ? AND queue_status = 'running'")
    .run(taskId, repositoryId);
}

// After a resolution or a deletion: a blocked queue names the lowest-numbered task that still needs the user, or runs again when none does.
export function releaseQueue(database, repositoryId) {
  const repository = preparedStatement(database, "SELECT queue_status FROM repositories WHERE repository_id = ?").get(repositoryId);
  if (repository?.queue_status !== "blocked") return;
  const next = preparedStatement(database, `SELECT MIN(number) AS number FROM tasks WHERE repository_id = ? AND state IN (${UNRESOLVED_STATES.map(() => "?").join(", ")})`)
    .get(repositoryId, ...UNRESOLVED_STATES);
  const blocker = next?.number === null || next?.number === undefined ? undefined : taskIdFromNumber(Number(next.number));
  if (blocker) preparedStatement(database, "UPDATE repositories SET queue_blocked_by = ? WHERE repository_id = ?").run(blocker, repositoryId);
  else preparedStatement(database, "UPDATE repositories SET queue_status = 'running', queue_blocked_by = NULL WHERE repository_id = ?").run(repositoryId);
}

function storeReport(database, row, { state, at, results, blockReason }) {
  const written = preparedStatement(database, `UPDATE tasks SET state = ?, queue_position = NULL, report_at = ?, report_results = ?, report_block_reason = ?, updated_at = ?
    WHERE repository_id = ? AND number = ? AND session_id = ? AND report_at IS NULL`)
    .run(state, at, JSON.stringify(results), blockReason, at, row.repository_id, row.number, row.session_id);
  if (Number(written.changes) !== 1) return false;
  if (state === "done" || state === "needs_review") moveTaskToRole(database, row.repository_id, Number(row.number), state === "done" ? "done" : "review");
  if (state !== "done") blockQueue(database, row.repository_id, taskIdFromNumber(Number(row.number)));
  return true;
}

/**
 * The checked conditions of the task linked to the session, when that task can still be reported on; otherwise null.
 * The report route asks before it reads the repository, so only a report that will be verified costs a read.
 */
export function reportableChecks({ database, sessionId }) {
  if (!isTaskSessionId(sessionId)) return null;
  const row = linkedRow(database, sessionId);
  const task = row && reportable(row) ? normalizeStoredTask(row) : null;
  return task ? [...task.doneWhen.checks] : null;
}

/**
 * `complete`: the bound session reports its task complete. `resolveFacts()` returns the plain repository facts
 * `verifyChecks` judges, read by the entry point (for a report, from a read made when the report arrived), and is
 * called only for a task that can still be reported on. Answers `{ ok: true, state, results }` with `state` `done` or `needs_review`.
 */
export function reportComplete({ database, transaction, payload, resolveFacts, now }) {
  if (!hasExactKeys(payload, ["sessionId"]) || !isTaskSessionId(payload.sessionId)) return { ok: false, error: "invalid" };
  const row = linkedRow(database, payload.sessionId);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  if (!reportable(row)) return { ok: false, error: "already_reported" };
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts() : null; } catch { facts = null; }
  const results = verifyChecks(task.doneWhen.checks, facts);
  const state = allChecksPassed(results) ? "done" : "needs_review";
  const stored = transaction(() => {
    // The task may have been reported, resolved, or deleted since the read above.
    const fresh = linkedRow(database, payload.sessionId);
    return Boolean(fresh) && fresh.number === row.number && fresh.repository_id === row.repository_id && reportable(fresh)
      && storeReport(database, fresh, { state, at: now(), results, blockReason: null });
  });
  return stored ? { ok: true, state, results } : { ok: false, error: "already_reported" };
}

/** `block`: the bound session reports it cannot continue, with a one-line reason of at most 200 characters. */
export function reportBlock({ database, transaction, payload, now }) {
  if (!hasExactKeys(payload, ["sessionId", "reason"]) || !isTaskSessionId(payload.sessionId)) return { ok: false, error: "invalid" };
  const reason = normalizeBlockReason(payload.reason);
  if (reason === undefined || reason === null) return { ok: false, error: "invalid" };
  const row = linkedRow(database, payload.sessionId);
  if (!row) return { ok: false, error: "not_found" };
  if (!normalizeStoredTask(row)) return { ok: false, error: "unavailable" };
  if (!reportable(row)) return { ok: false, error: "already_reported" };
  const stored = transaction(() => {
    const fresh = linkedRow(database, payload.sessionId);
    return Boolean(fresh) && fresh.number === row.number && fresh.repository_id === row.repository_id && reportable(fresh)
      && storeReport(database, fresh, { state: "blocked", at: now(), results: [], blockReason: reason });
  });
  return stored ? { ok: true, state: "blocked" } : { ok: false, error: "already_reported" };
}

// A linked task whose session has not reported is in flight: the session could still report, and nothing marks it
// done or stalled by itself, so it can hold the queue with no exit. The user resolves it like an outcome.
const awaitingReport = (row) => rowInFlight(row) && reportable(row);

function unresolvedTask(database, repositoryId, payload) {
  const input = normalizeQueueTaskPayload(payload);
  if (!input) return { error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id, report_at FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { error: "not_found" };
  return UNRESOLVED_STATES.includes(task.state) || awaitingReport(task) ? { number: input.number } : { error: "conflict" };
}

/**
 * `resolve_done`: the user accepts a task that needs review, is blocked, or stalled, or a linked task whose session
 * has not reported. Its report and session link stay as recorded. It never touches the session: a report that
 * arrives afterwards is refused, because the task has an outcome. The card moves to the Done column.
 */
export function resolveDone({ database, repositoryId }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  preparedStatement(database, "UPDATE tasks SET state = 'done', queue_position = NULL, updated_at = ? WHERE repository_id = ? AND number = ?")
    .run(Date.now(), repositoryId, target.number);
  moveTaskToRole(database, repositoryId, target.number, "done");
  releaseQueue(database, repositoryId);
  return { ok: true };
}

/**
 * `resolve_requeue`: the user sends the task back to the end of the queue for a new session. The report, the
 * session link, and any dispatch are cleared, so the task can be started and reported on once more. The same
 * tasks as `resolve_done` qualify, including a linked task with no report; the session is not stopped. The card goes
 * to the end of Ready in the same store write, which is the end of the single tasks.
 */
export function resolveRequeue({ database, repositoryId }, payload) {
  const target = unresolvedTask(database, repositoryId, payload);
  if (target.error) return { ok: false, error: target.error };
  preparedStatement(database, `UPDATE tasks SET state = 'queued', queue_position = NULL, scheduled_at = NULL, session_id = NULL, dispatch_token = NULL,
    report_at = NULL, report_results = NULL, report_block_reason = NULL, updated_at = ? WHERE repository_id = ? AND number = ?`)
    .run(Date.now(), repositoryId, target.number);
  releaseQueue(database, repositoryId);
  return { ok: true };
}
