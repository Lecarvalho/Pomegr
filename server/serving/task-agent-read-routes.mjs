// `POST /api/agent/v1/tasks/get` and `/list` (task T-118): the bound session reads the tasks of its own board. This
// module reuses the one served-task shape (shared/task-agent-read.mjs); the store builds the entries (server/tasks/task-agent-read.mjs), and each one
// is bounded again here on the way out. No body names a repository or a path, and nothing is written.

import { AGENT_SESSION_REF_PATTERN, AGENT_TASK_ID_PATTERN, JSON_HEADERS, agentBoardRepository, isPlainObject, readAgentJson } from "./task-routes.mjs";

export const AGENT_TASK_GET_PATH = "/api/agent/v1/tasks/get";
export const AGENT_TASK_LIST_PATH = "/api/agent/v1/tasks/list";
export const AGENT_TASK_READ_PATHS = Object.freeze([AGENT_TASK_GET_PATH, AGENT_TASK_LIST_PATH]);
export { AGENT_TASK_READ_BOUNDS, servedAgentTask } from "../../shared/task-agent-read.mjs";
import { AGENT_TASK_READ_BOUNDS, servedAgentTask, servedChatTask } from "../../shared/task-agent-read.mjs";
const AGENT_READ_BODY_LIMIT_BYTES = 1024;
const AGENT_READ_STATUS = Object.freeze({ invalid: 400, session_not_found: 404, repository_unavailable: 409, not_found: 404, unavailable: 503 });
const LIST_KEYS = Object.freeze(["query", "state", "feature", "editable"]);
const ONE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const STATES = Object.freeze(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]);
const oneLine = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit && ONE_LINE.test(value);
const FEATURE_TITLE_LIMIT = 80;

// The list's search: every filter that is set must match. `query` is a case-insensitive part of the text or the own condition.
export function matchAgentTasks(entries, { query, state, feature, editable } = {}) {
  const needle = typeof query === "string" ? query.toLowerCase() : null;
  return entries.filter((entry) => (needle === null || String(entry.text).toLowerCase().includes(needle)
    || String(entry.ownCondition ?? "").toLowerCase().includes(needle))
    && (state === undefined || entry.state === state)
    && (feature === undefined || entry.feature === feature)
    && (editable === undefined || entry.editable === editable));
}

function writeAgentReadResult(response, reason, answer = null, { close = false } = {}) {
  const ok = reason === null;
  response.writeHead(ok ? 200 : AGENT_READ_STATUS[reason], {
    ...JSON_HEADERS, "Cache-Control": "no-store", ...(close ? { Connection: "close" } : {}),
  });
  response.end(JSON.stringify(ok ? { schemaVersion: 1, ok: true, ...answer } : { schemaVersion: 1, ok: false, reason }));
}

function validBody(body, operation) {
  if (!isPlainObject(body) || typeof body.sessionRef !== "string" || !AGENT_SESSION_REF_PATTERN.test(body.sessionRef)) return false;
  if (operation === AGENT_TASK_GET_PATH) {
    return Object.keys(body).length === 2 && typeof body.taskId === "string" && AGENT_TASK_ID_PATTERN.test(body.taskId);
  }
  return Object.keys(body).every((key) => key === "sessionRef" || LIST_KEYS.includes(key))
    && (body.query === undefined || oneLine(body.query, AGENT_TASK_READ_BOUNDS.queryLength))
    && (body.state === undefined || STATES.includes(body.state))
    && (body.feature === undefined || oneLine(body.feature, FEATURE_TITLE_LIMIT))
    && (body.editable === undefined || typeof body.editable === "boolean");
}

export async function serveAgentTaskReadRoute({ request, response, requestUrl, taskStore, resolveSession }) {
  const read = await readAgentJson(request, requestUrl, AGENT_READ_BODY_LIMIT_BYTES);
  if (read.failed) {
    writeAgentReadResult(response, "invalid", null, { close: true });
    return;
  }
  const operation = requestUrl.pathname;
  const { body } = read;
  if (!validBody(body, operation)) {
    writeAgentReadResult(response, "invalid");
    return;
  }
  try {
    if (typeof taskStore?.readAgentTasks !== "function" || typeof resolveSession !== "function") {
      writeAgentReadResult(response, "unavailable");
      return;
    }
    const { repositoryId, reason: boardReason } = agentBoardRepository(taskStore, resolveSession, body.sessionRef);
    if (boardReason) {
      writeAgentReadResult(response, boardReason);
      return;
    }
    const entries = taskStore.readAgentTasks(repositoryId);
    if (!Array.isArray(entries)) {
      writeAgentReadResult(response, "unavailable");
      return;
    }
    if (operation === AGENT_TASK_GET_PATH) {
      // A task of another board is not on this one, so it answers the same `not_found` as a task that does not exist.
      const entry = entries.find((candidate) => candidate?.id === body.taskId);
      const task = entry === undefined ? null : servedAgentTask(entry);
      if (task) writeAgentReadResult(response, null, { task });
      else writeAgentReadResult(response, entry === undefined ? "not_found" : "unavailable");
      return;
    }
    const matched = matchAgentTasks(entries.filter(isPlainObject), body);
    const tasks = matched.slice(0, AGENT_TASK_READ_BOUNDS.listTasks).map((entry) => servedAgentTask(entry, { cut: true }));
    if (tasks.includes(null)) {
      writeAgentReadResult(response, "unavailable");
      return;
    }
    writeAgentReadResult(response, null, { tasks, matched: matched.length, truncated: matched.length > tasks.length });
  } catch {
    writeAgentReadResult(response, "unavailable");
  }
}

// Desktop-only read for the repository-bound chat bridge. No observed session is fabricated.
export const CHAT_TASK_READ_PATH = "/internal/agent-chat/task";
export function serveChatTaskReadRoute({ request, response, requestUrl, taskStore, authorized }) {
  const unavailable = () => writeAgentReadResult(response, "unavailable");
  if (!authorized) { response.writeHead(401, { ...JSON_HEADERS, "Cache-Control": "no-store" }); response.end(JSON.stringify({ ok: false })); return; }
  if (request.method !== "GET") { response.writeHead(405, { Allow: "GET" }); response.end(); return; }
  const repositoryId = requestUrl.searchParams.get("repositoryId");
  const taskId = requestUrl.searchParams.get("taskId");
  if (!/^repo-[a-f0-9]{24}$/u.test(repositoryId ?? "") || !AGENT_TASK_ID_PATTERN.test(taskId ?? "")
    || [...requestUrl.searchParams.keys()].length !== 2
    || ![...requestUrl.searchParams.keys()].every((key) => ["repositoryId", "taskId"].includes(key))
    || Number(request.headers["content-length"] || 0) > 0 || request.headers["transfer-encoding"] !== undefined) {
    writeAgentReadResult(response, "invalid"); return;
  }
  try {
    const entries = taskStore?.readAgentTasks(repositoryId, { includeChatReport: true });
    if (!Array.isArray(entries)) return unavailable();
    const entry = entries.find((candidate) => candidate?.id === taskId);
    if (!entry) { writeAgentReadResult(response, "not_found"); return; }
    const task = servedChatTask(entry);
    if (!task) return unavailable();
    writeAgentReadResult(response, null, { task });
  } catch { unavailable(); }
}
