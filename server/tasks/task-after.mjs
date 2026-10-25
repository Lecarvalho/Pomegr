// What a task runs after: the tasks of the same board that must be Done (or deleted) before it may start.
// The list is kept in `meta` under `task_after:<repositoryId>:<taskId>`, so the schema version does not change.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { TASK_BOUNDS, isRepositoryId, isTaskId, rowStarted, taskIdFromNumber } from "./task-record.mjs";

// A task runs after at most this many tasks.
export const TASK_AFTER_LIMIT = TASK_BOUNDS.afterPerTask;

const prefixOf = (repositoryId) => `task_after:${repositoryId}:`;
const keyOf = (repositoryId, number) => `${prefixOf(repositoryId)}${taskIdFromNumber(number)}`;
const numberOf = (id) => Number(id.slice(2));

// A stored list: 1 to 8 distinct task IDs. Anything else reads as no list.
function parseStored(value, own) {
  let list;
  try { list = JSON.parse(value); } catch { return null; }
  if (!Array.isArray(list) || list.length === 0 || list.length > TASK_AFTER_LIMIT || !list.every(isTaskId)) return null;
  const numbers = list.map(numberOf);
  return new Set(numbers).size === numbers.length && !numbers.includes(own) ? numbers : null;
}

// The stored list of each task of one repository, by task number.
export function readTaskAfter(database, repositoryId) {
  const after = new Map();
  if (!isRepositoryId(repositoryId)) return after;
  const prefix = prefixOf(repositoryId);
  for (const row of preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix)) {
    const taskId = String(row.key).slice(prefix.length);
    if (!isTaskId(taskId) || typeof row.value !== "string") continue;
    const numbers = parseStored(row.value, numberOf(taskId));
    if (numbers) after.set(numberOf(taskId), numbers);
  }
  return after;
}

function writeTaskAfter(database, repositoryId, number, numbers) {
  const key = keyOf(repositoryId, number);
  if (numbers.length === 0) preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  else preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(numbers.map(taskIdFromNumber)));
}

// In the write that deletes a task: its own list goes, and every task that ran after it is free of it.
export function deleteTaskAfter(database, repositoryId, number) {
  const stored = readTaskAfter(database, repositoryId);
  writeTaskAfter(database, repositoryId, number, []);
  for (const [other, numbers] of stored) {
    if (other !== number && numbers.includes(number)) writeTaskAfter(database, repositoryId, other, numbers.filter((entry) => entry !== number));
  }
}

// Whether `from` already runs, directly or through other tasks, after `target`.
function reaches(stored, from, target) {
  const seen = new Set();
  const pending = [from];
  while (pending.length > 0) {
    const number = pending.pop();
    if (number === target) return true;
    if (seen.has(number)) continue;
    seen.add(number);
    pending.push(...(stored.get(number) ?? []));
  }
  return false;
}

// `after_set`: exactly `{ id, after }`, where `after` lists 0 to 8 distinct task IDs of the same board, never the task
// itself. The list replaces the stored one; an empty list clears it. A task that has started answers `conflict`, and so
// does a list that would make tasks wait for each other.
export function setTaskAfter({ database, repositoryId, now }, payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "invalid" };
  const keys = Object.keys(payload);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("after") || !isTaskId(payload.id) || !Array.isArray(payload.after)) return { ok: false, error: "invalid" };
  if (payload.after.length > TASK_AFTER_LIMIT || !payload.after.every(isTaskId)) return { ok: false, error: "invalid" };
  const number = numberOf(payload.id);
  const numbers = payload.after.map(numberOf);
  if (new Set(numbers).size !== numbers.length || numbers.includes(number)) return { ok: false, error: "invalid" };
  const row = preparedStatement(database, "SELECT state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND number = ?");
  const task = row.get(repositoryId, number);
  if (!task) return { ok: false, error: "not_found" };
  if (numbers.some((other) => row.get(repositoryId, other) === undefined)) return { ok: false, error: "not_found" };
  // The session was started from the task as it was; a hold added later would never reach it.
  if (rowStarted(task, now())) return { ok: false, error: "conflict" };
  const stored = readTaskAfter(database, repositoryId);
  if (numbers.some((other) => reaches(stored, other, number))) return { ok: false, error: "conflict" };
  writeTaskAfter(database, repositoryId, number, numbers);
  return { ok: true };
}

// What an agent's `add_task` or `update_task` sets the task to run after, through the board's `after_set` and in the
// same transaction, so a refused list writes nothing of the call. A task that is not on the board answers
// `after_not_found`, and a list that would make tasks wait for each other answers `after_loop`.
export function agentSetAfter(context, id, after) {
  const result = setTaskAfter(context, { id, after });
  if (result.ok || result.error === "invalid") return result;
  return { ok: false, error: result.error === "not_found" ? "after_not_found" : "after_loop" };
}

// The tasks a task still waits for: those it runs after that are on the board and not Done. `states` maps each task
// number of the board to its state.
export function unfinishedAfter(numbers, states) {
  return (numbers ?? []).filter((number) => states.has(number) && states.get(number) !== "done");
}
