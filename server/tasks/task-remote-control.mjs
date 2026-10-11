// Whether a task's Claude Code session starts with Remote Control on. One fixed flag, kept in the existing `meta` table
// under `task_remote_control:<repositoryId>:<taskId>` like a task's source (task-source.mjs), so the schema version does
// not change. A row exists only while the flag is on. It is written in the transaction that creates or updates the task
// and removed in the one that deletes it.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

const ON = "1";
const prefixOf = (repositoryId) => `task_remote_control:${repositoryId}:`;

/** The numbers of one repository's tasks that have the flag on. A row that is not a task ID and the fixed value is ignored. */
export function readTaskRemoteControls(database, repositoryId) {
  const numbers = new Set();
  if (!isRepositoryId(repositoryId)) return numbers;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (isTaskId(taskId) && row.value === ON) numbers.add(Number(taskId.slice(2)));
  }
  return numbers;
}

/** Whether one task has the flag on. */
export function readTaskRemoteControl(database, repositoryId, taskNumber) {
  const taskId = taskIdFromNumber(taskNumber);
  if (!isRepositoryId(repositoryId) || taskId === undefined) return false;
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(`${prefixOf(repositoryId)}${taskId}`)?.value === ON;
}

/** Turns the flag on or off for one task; off removes the row. */
export function writeTaskRemoteControl(database, repositoryId, taskNumber, on) {
  const key = `${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`;
  if (on === true) {
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, ON);
  } else {
    preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  }
}

/** A stored row with its `run_remote_control` attached, the way the projection reads it. */
export function withTaskRemoteControl(database, row) {
  return row ? { ...row, run_remote_control: readTaskRemoteControl(database, row.repository_id, row.number) } : row;
}
