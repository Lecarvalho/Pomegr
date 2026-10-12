// The sessions assigned to a task: a many-to-many relation beside the one session Pomegr started for it.
// An assignment is a marker. It changes no state, column, or queue place, and it is never a dispatch.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, isTaskSessionId, normalizeQueueTaskPayload, taskIdFromNumber } from "./task-record.mjs";

export const TASK_ASSIGNED_SESSIONS_MAX = 16;
export const SESSION_ASSIGNED_TASKS_MAX = 16;

const PREFIX = "task_assigned:";
const prefixOf = (repositoryId) => `${PREFIX}${repositoryId}:`;
const keyOf = (repositoryId, taskNumber) => `${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`;

// A stored list as session IDs in the order they were assigned. A value outside the contract reads as none.
export function normalizeAssignedSessions(value) {
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); } catch { return []; }
  }
  const sessionIds = [];
  for (const entry of Array.isArray(parsed) ? parsed : []) {
    if (sessionIds.length >= TASK_ASSIGNED_SESSIONS_MAX) break;
    if (isTaskSessionId(entry) && !sessionIds.includes(entry)) sessionIds.push(entry);
  }
  return sessionIds;
}

export function readTaskAssigned(database, repositoryId, taskNumber) {
  if (!isRepositoryId(repositoryId) || taskIdFromNumber(taskNumber) === undefined) return [];
  return normalizeAssignedSessions(preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(keyOf(repositoryId, taskNumber))?.value);
}

// Every task of one repository that holds an assigned session, by task number.
export function readTaskAssignments(database, repositoryId) {
  const assignments = new Map();
  if (!isRepositoryId(repositoryId)) return assignments;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    const sessionIds = isTaskId(taskId) ? normalizeAssignedSessions(row.value) : [];
    if (sessionIds.length > 0) assignments.set(Number(taskId.slice(2)), sessionIds);
  }
  return assignments;
}

// The tasks one session is assigned to, on every board, as `{ repositoryId, number }` in repository and number order.
export function sessionAssignedTasks(database, sessionId) {
  if (!isTaskSessionId(sessionId)) return [];
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ? AND instr(value, ?) > 0")
    .all(PREFIX.length, PREFIX, JSON.stringify(sessionId));
  const tasks = [];
  for (const row of rows) {
    const [repositoryId, taskId, ...rest] = String(row.key).slice(PREFIX.length).split(":");
    if (rest.length > 0 || !isRepositoryId(repositoryId) || !isTaskId(taskId) || !normalizeAssignedSessions(row.value).includes(sessionId)) continue;
    tasks.push({ repositoryId, number: Number(taskId.slice(2)) });
  }
  return tasks.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId) || left.number - right.number);
}

function writeTaskAssigned(database, repositoryId, taskNumber, sessionIds) {
  if (sessionIds.length === 0) {
    deleteTaskAssigned(database, repositoryId, taskNumber);
    return;
  }
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(keyOf(repositoryId, taskNumber), JSON.stringify(sessionIds));
}

export function deleteTaskAssigned(database, repositoryId, taskNumber) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, taskNumber));
}

function assignmentInput(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("sessionId") || !isTaskSessionId(payload.sessionId)) return null;
  const task = normalizeQueueTaskPayload({ id: payload.id });
  return task ? { number: task.number, sessionId: payload.sessionId } : null;
}

// `session_assign`: any task of the board that is not done takes the session. Assigning it again changes nothing.
export function assignSession({ database, repositoryId }, payload) {
  const input = assignmentInput(payload);
  if (!input) return { ok: false, error: "invalid" };
  const task = preparedStatement(database, "SELECT state, session_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, input.number);
  if (!task) return { ok: false, error: "not_found" };
  // A done task takes no report, and the session Pomegr started for the task reports it already.
  if (task.state === "done" || task.session_id === input.sessionId) return { ok: false, error: "conflict" };
  const sessionIds = readTaskAssigned(database, repositoryId, input.number);
  if (sessionIds.includes(input.sessionId)) return { ok: true };
  if (sessionIds.length >= TASK_ASSIGNED_SESSIONS_MAX || sessionAssignedTasks(database, input.sessionId).length >= SESSION_ASSIGNED_TASKS_MAX) return { ok: false, error: "limit" };
  writeTaskAssigned(database, repositoryId, input.number, [...sessionIds, input.sessionId]);
  return { ok: true };
}

// `session_unassign`: removes one assignment. The session Pomegr started for a task is not an assignment.
export function unassignSession({ database, repositoryId }, payload) {
  const input = assignmentInput(payload);
  if (!input) return { ok: false, error: "invalid" };
  const sessionIds = readTaskAssigned(database, repositoryId, input.number);
  if (!sessionIds.includes(input.sessionId)) return { ok: false, error: "not_found" };
  writeTaskAssigned(database, repositoryId, input.number, sessionIds.filter((sessionId) => sessionId !== input.sessionId));
  return { ok: true };
}
