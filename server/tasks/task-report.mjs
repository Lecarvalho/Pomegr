// The agent's report on the task its session was started for, and the user's two resolutions.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { deleteTaskAttention, writeTaskAttention } from "./task-attention.mjs";
import { verifyChecks } from "./task-checks.mjs";
import { moveTaskToRole } from "./task-columns.mjs";
import { releasePause } from "./task-queue-advance.mjs";
import { requestWorktreeCleanup } from "./task-worktree-cleanup.mjs";
import { IN_FLIGHT_STATES, isTaskSessionId, normalizeBlockReason, normalizeQueueTaskPayload, normalizeStoredTask, rowInFlight, taskIdFromNumber } from "./task-record.mjs";

export const TASK_REPORT_ERRORS = Object.freeze(["invalid", "not_found", "already_reported", "unavailable"]);

const UNRESOLVED_STATES = Object.freeze(["needs_review", "stalled", "blocked"]);
const QUEUE_HOLDING_STATES = Object.freeze(["stalled", "blocked"]);

const hasExactKeys = (payload, keys) => payload !== null && typeof payload === "object" && !Array.isArray(payload)
  && Object.keys(payload).length === keys.length && keys.every((key) => Object.hasOwn(payload, key));

const linkedRow = (database, sessionId) => preparedStatement(database, "SELECT * FROM tasks WHERE session_id = ?").get(sessionId);

const reportable = (row) => IN_FLIGHT_STATES.includes(row.state) && (row.report_at ?? null) === null;

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
  const written = preparedStatement(database, `UPDATE tasks SET state = ?, queue_position = NULL, report_at = ?, report_results = ?, report_block_reason = ?, updated_at = ?
    WHERE repository_id = ? AND number = ? AND session_id = ? AND report_at IS NULL`)
    .run(state, at, JSON.stringify(results), blockReason, at, row.repository_id, row.number, row.session_id);
  if (Number(written.changes) !== 1) return false;
  if (attention === null) deleteTaskAttention(database, row.repository_id, Number(row.number));
  else writeTaskAttention(database, row.repository_id, Number(row.number), attention);
  if (state === "needs_review") moveTaskToRole(database, row.repository_id, Number(row.number), "review");
  if (QUEUE_HOLDING_STATES.includes(state)) blockQueue(database, row.repository_id, taskIdFromNumber(Number(row.number)));
  return true;
}

export function reportableChecks({ database, sessionId }) {
  if (!isTaskSessionId(sessionId)) return null;
  const row = linkedRow(database, sessionId);
  const task = row && reportable(row) ? normalizeStoredTask(row) : null;
  return task ? [...task.completeWhen.checks] : null;
}

// `complete`: the bound session reports its task complete.
export function reportComplete({ database, transaction, payload, resolveFacts, now }) {
  const noted = hasExactKeys(payload, ["sessionId", "attention"]);
  if ((!noted && !hasExactKeys(payload, ["sessionId"])) || !isTaskSessionId(payload.sessionId)) return { ok: false, error: "invalid" };
  const attention = noted ? normalizeBlockReason(payload.attention) : null;
  if (attention === undefined || (noted && attention === null)) return { ok: false, error: "invalid" };
  const row = linkedRow(database, payload.sessionId);
  if (!row) return { ok: false, error: "not_found" };
  const task = normalizeStoredTask(row);
  if (!task) return { ok: false, error: "unavailable" };
  if (!reportable(row)) return { ok: false, error: "already_reported" };
  let facts = null;
  try { facts = typeof resolveFacts === "function" ? resolveFacts() : null; } catch { facts = null; }
  const results = verifyChecks(task.completeWhen.checks, facts);
  const state = "needs_review";
  const stored = transaction(() => {
    const fresh = linkedRow(database, payload.sessionId);
    return Boolean(fresh) && fresh.number === row.number && fresh.repository_id === row.repository_id && reportable(fresh)
      && storeReport(database, fresh, { state, at: now(), results, blockReason: null, attention });
  });
  return stored ? { ok: true, state, results } : { ok: false, error: "already_reported" };
}

// `block`: the bound session reports it cannot continue, with a one-line reason of at most 200 characters.
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

const awaitingReport = (row) => rowInFlight(row) && reportable(row);

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
  releaseQueue(database, repositoryId);
  releasePause({ database, repositoryId, now }, taskIdFromNumber(target.number));
  return { ok: true };
}
