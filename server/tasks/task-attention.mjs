// What the agent asked the owner to look at when it reported its task complete.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

const prefixOf = (repositoryId) => `task_attention:${repositoryId}:`;

export function readTaskAttention(database, repositoryId, taskNumber) {
  return preparedStatement(database, "SELECT value FROM meta WHERE key = ?")
    .get(`${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`)?.value ?? null;
}

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
