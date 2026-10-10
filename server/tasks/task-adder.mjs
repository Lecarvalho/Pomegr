// Which session added a task through the agent's `add_task`. The normalized session ID is kept in the existing `meta`
// table under `task_added_by:<repositoryId>:<taskId>` like a task's source (task-source.mjs), so the schema version does
// not change. It is written in the transaction that creates the task and removed in the one that deletes it. Its only
// reader is the agent's `remove_task` rule (task-store.mjs): it is never projected onto a board or served anywhere. A
// task the user made, or one made before this record existed, has no row and so no session may remove it.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskSessionId, taskIdFromNumber } from "./task-record.mjs";

const keyOf = (repositoryId, taskNumber) => `task_added_by:${repositoryId}:${taskIdFromNumber(taskNumber)}`;

/** The session that added one task, or null when none is recorded or the stored value is not a session ID. */
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
