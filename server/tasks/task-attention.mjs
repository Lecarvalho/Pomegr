// What the agent asked the owner to look at when it reported its task complete. The one-line note is kept in the
// existing `meta` table under `task_attention:<repositoryId>:<taskId>` like a task's source (task-source.mjs), so the
// schema version does not change. The key is written in the transaction that stores the report and removed in the one
// that requeues or deletes the task; a note without a stored report is never projected.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

const prefixOf = (repositoryId) => `task_attention:${repositoryId}:`;

/** Every stored note of one repository as `Map<taskNumber, text>`, as written; the projection validates each. */
export function readTaskAttentions(database, repositoryId) {
  const notes = new Map();
  if (!isRepositoryId(repositoryId)) return notes;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (isTaskId(taskId) && typeof row.value === "string") notes.set(Number(taskId.slice(2)), row.value);
  }
  return notes;
}

export function writeTaskAttention(database, repositoryId, taskNumber, text) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`, text);
}

export function deleteTaskAttention(database, repositoryId, taskNumber) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(`${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`);
}
