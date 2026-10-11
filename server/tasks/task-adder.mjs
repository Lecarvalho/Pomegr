// Which session added a task through the agent's `add_task`.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";

const keyOf = (repositoryId, taskNumber) => `task_added_by:${repositoryId}:${taskIdFromNumber(taskNumber)}`;

// The session that added one task, or null when none is recorded or the stored value is not a session ID.
export function readTaskAdder(database, repositoryId, taskNumber) {
  if (!isRepositoryId(repositoryId) || taskIdFromNumber(taskNumber) === undefined) return null;
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(keyOf(repositoryId, taskNumber))?.value;
  return isTaskSessionId(value) ? value : null;
}

export function writeTaskAdder(database, repositoryId, taskNumber, sessionId) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(keyOf(repositoryId, taskNumber), sessionId);
}

export function deleteTaskAdder(database, repositoryId, taskNumber) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, taskNumber));
}
