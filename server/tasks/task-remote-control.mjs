// Whether a task's Claude Code session starts with Remote Control on.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

const ON = "1";
const prefixOf = (repositoryId) => `task_remote_control:${repositoryId}:`;

// The numbers of one repository's tasks that have the flag on.
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

export function readTaskRemoteControl(database, repositoryId, taskNumber) {
  const taskId = taskIdFromNumber(taskNumber);
  if (!isRepositoryId(repositoryId) || taskId === undefined) return false;
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(`${prefixOf(repositoryId)}${taskId}`)?.value === ON;
}

export function writeTaskRemoteControl(database, repositoryId, taskNumber, on) {
  const key = `${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`;
  if (on === true) {
    preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, ON);
  } else {
    preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  }
}

export function withTaskRemoteControl(database, row) {
  return row ? { ...row, run_remote_control: readTaskRemoteControl(database, row.repository_id, row.number) } : row;
}
