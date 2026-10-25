// The agent routes of a session and its tasks: assign and unassign, and the complete and block reports.

import {
  AGENT_REMOVE_BODY_LIMIT_BYTES, AGENT_SESSION_REF_PATTERN, AGENT_TASK_ID_PATTERN, JSON_HEADERS, agentBoardRepository, isPlainObject, readAgentJson, writeAgentOutcome,
} from "./task-routes.mjs";

export const AGENT_TASK_ASSIGN_PATH = "/api/agent/v1/tasks/assign";
export const AGENT_TASK_UNASSIGN_PATH = "/api/agent/v1/tasks/unassign";
const AGENT_ASSIGN_STATUS = Object.freeze({
  invalid: 400, session_not_found: 404, repository_unavailable: 409, not_found: 404, conflict: 409, limit: 409, unavailable: 503,
});
const writeAgentAssignResult = writeAgentOutcome.bind(null, AGENT_ASSIGN_STATUS);

// `POST /api/agent/v1/tasks/assign` and `/unassign`: the bound session assigns itself to a task of its own board, or
// takes its own assignment back. The answer is a fixed status; it carries no task content or state.
export async function serveAgentTaskAssignRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, AGENT_REMOVE_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentAssignResult(response, "invalid", { close: true });
    return;
  }
  const { body } = read;
  const valid = isPlainObject(body) && Object.keys(body).length === 2
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId);
  if (!valid) {
    writeAgentAssignResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.apply !== "function" || typeof resolveSession !== "function") {
      writeAgentAssignResult(response, "unavailable");
      return;
    }
    const { repositoryId, reason: boardReason } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (boardReason) {
      writeAgentAssignResult(response, boardReason);
      return;
    }
    const assigning = requestUrl.pathname === AGENT_TASK_ASSIGN_PATH;
    const result = taskStore.apply(repositoryId, assigning ? "session_assign" : "session_unassign", { id: body.taskId, sessionId: body.sessionRef });
    if (result?.ok === true) writeAgentAssignResult(response, null);
    else writeAgentAssignResult(response, ["invalid", "not_found", ...(assigning ? ["conflict", "limit"] : [])].includes(result?.error) ? result.error : "unavailable");
  } catch {
    writeAgentAssignResult(response, "unavailable");
  }
}

export const AGENT_TASK_COMPLETE_PATH = "/api/agent/v1/tasks/complete";
export const AGENT_TASK_BLOCK_PATH = "/api/agent/v1/tasks/block";
export const AGENT_TASK_REVIEW_PATH = "/api/agent/v1/tasks/review";
const AGENT_REPORT_BODY_LIMIT_BYTES = 2048;
const AGENT_REVIEW_BODY_LIMIT_BYTES = 16 * 1024;
const AGENT_BLOCK_REASON_LIMIT = 200;
const AGENT_REPORT_STATUS = Object.freeze({ invalid: 400, not_found: 404, not_reviewable: 409, task_required: 409, already_reported: 409, stalled: 409, unavailable: 503 });
const REPORT_CHECKS = Object.freeze(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed", "user_validated"]);

function writeAgentReportResult(response, reason, answer = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_REPORT_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, ...answer } : { schemaVersion: 1, ok: false, reason }));
}

// Only the fixed check names and booleans the store recorded reach the agent.
function reportResults(results) {
  return (Array.isArray(results) ? results : [])
    .filter((result) => REPORT_CHECKS.includes(result?.check) && typeof result.passed === "boolean")
    .map((result) => ({ check: result.check, passed: result.passed, ...(result.passed === false && result.unavailable === true ? { unavailable: true } : {}) }));
}

// `POST /api/agent/v1/tasks/complete` and `/block`: the bound session reports on the task it was started for or on one
// it is assigned to. With more than one task, the body names the one.
export async function serveAgentTaskReportRoute({ request, response, requestUrl, taskStore, resolveCheckFacts = null, readCheckFacts = null }) {
  const blocking = requestUrl.pathname === AGENT_TASK_BLOCK_PATH;
  const reviewing = requestUrl.pathname === AGENT_TASK_REVIEW_PATH;
  const read = await readAgentJson(request, requestUrl, reviewing ? AGENT_REVIEW_BODY_LIMIT_BYTES : AGENT_REPORT_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentReportResult(response, "invalid", null, { close: true });
    return;
  }
  const { body } = read;
  if (reviewing) {
    const keys = isPlainObject(body) ? Object.keys(body) : [];
    const reasonsValid = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 10
      && value.every((reason) => typeof reason === "string" && reason.length >= 1 && reason.length <= AGENT_BLOCK_REASON_LIMIT
        && reason.trim().length > 0 && !/[\r\n\u2028\u2029]/u.test(reason));
    const valid = isPlainObject(body) && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
      && ((body.verdict === "pass" && keys.every((key) => ["sessionRef", "verdict", "taskId"].includes(key)) && !Object.hasOwn(body, "reasons"))
        || (body.verdict === "fail" && keys.every((key) => ["sessionRef", "verdict", "taskId", "reasons"].includes(key)) && reasonsValid(body.reasons)))
      && (!Object.hasOwn(body, "taskId") || (typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId)))
      && keys.includes("sessionRef") && keys.includes("verdict");
    if (!valid) {
      writeAgentReportResult(response, "invalid");
      return;
    }
    try {
      if (typeof taskStore?.reportReview !== "function") {
        writeAgentReportResult(response, "unavailable");
        return;
      }
      const result = taskStore.reportReview({ sessionId: body.sessionRef, verdict: body.verdict,
        ...(Object.hasOwn(body, "taskId") ? { taskId: body.taskId } : {}), ...(body.verdict === "fail" ? { reasons: body.reasons } : {}) });
      if (result?.ok === true) writeAgentReportResult(response, null);
      else writeAgentReportResult(response, ["invalid", "not_found", "not_reviewable", "unavailable"].includes(result?.error) ? result.error : "unavailable");
    } catch {
      writeAgentReportResult(response, "unavailable");
    }
    return;
  }
  const noted = !blocking && isPlainObject(body) && Object.hasOwn(body, "attention");
  const named = isPlainObject(body) && Object.hasOwn(body, "taskId");
  const keys = [...(blocking ? ["sessionRef", "reason"] : noted ? ["sessionRef", "attention"] : ["sessionRef"]), ...(named ? ["taskId"] : [])];
  const boundedLine = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= AGENT_BLOCK_REASON_LIMIT;
  const valid = isPlainObject(body) && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key))
    && typeof body.sessionRef === "string" && AGENT_SESSION_REF_PATTERN.test(body.sessionRef)
    && (!named || (typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId)))
    && (!blocking || boundedLine(body.reason)) && (!noted || boundedLine(body.attention));
  if (!valid) {
    writeAgentReportResult(response, "invalid");
    return;
  }
  try {
    const call = blocking ? taskStore?.blockTask : taskStore?.completeTask;
    if (typeof call !== "function") {
      writeAgentReportResult(response, "unavailable");
      return;
    }
    let read = null;
    if (!blocking && typeof readCheckFacts === "function" && typeof taskStore.reportChecks === "function"
      && (taskStore.reportChecks(body.sessionRef, body.taskId) ?? []).length > 0) {
      try { read = await readCheckFacts(body.sessionRef); } catch { read = null; }
    }
    const task = named ? { taskId: body.taskId } : {};
    const result = blocking
      ? call({ sessionId: body.sessionRef, ...task, reason: body.reason })
      : call({ sessionId: body.sessionRef, ...task, ...(noted ? { attention: body.attention } : {}) }, () => read ?? (typeof resolveCheckFacts === "function" ? resolveCheckFacts(body.sessionRef) : null));
    if (result?.ok === true && blocking) writeAgentReportResult(response, null, { state: "blocked" });
    else if (result?.ok === true && ["needs_review", "blocked"].includes(result.state)) {
      writeAgentReportResult(response, null, { state: result.state, results: reportResults(result.results), ...(result.ownerHold === true ? { ownerHold: true } : {}) });
    } else writeAgentReportResult(response, Object.hasOwn(AGENT_REPORT_STATUS, result?.error) ? result.error : "unavailable");
  } catch {
    writeAgentReportResult(response, "unavailable");
  }
}
