
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isRepositoryId, isTaskId, taskIdFromNumber } from "./task-record.mjs";

export const ISSUE_NUMBER_MAX = 999_999_999;

const NUMBER = /^[1-9][0-9]{0,8}$/u;
const prefixOf = (repositoryId) => `task_source:${repositoryId}:`;

export function taskSourceOf(number) {
  return Number.isSafeInteger(number) && number >= 1 && number <= ISSUE_NUMBER_MAX ? { kind: "github_issue", number } : null;
}

// Every stored source of one repository as `Map<taskNumber, issueNumber>`.
export function readTaskSources(database, repositoryId) {
  const sources = new Map();
  if (!isRepositoryId(repositoryId)) return sources;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (!isTaskId(taskId) || typeof row.value !== "string" || !NUMBER.test(row.value)) continue;
    sources.set(Number(taskId.slice(2)), Number(row.value));
  }
  return sources;
}

export function readTaskSource(database, repositoryId, taskNumber) {
  const taskId = taskIdFromNumber(taskNumber);
  if (!isRepositoryId(repositoryId) || taskId === undefined) return null;
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(`${prefixOf(repositoryId)}${taskId}`)?.value;
  return typeof value === "string" && NUMBER.test(value) ? Number(value) : null;
}

export function writeTaskSource(database, repositoryId, taskNumber, issueNumber) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`, String(issueNumber));
}

export function deleteTaskSource(database, repositoryId, taskNumber) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(`${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`);
}

export function withTaskSource(database, row) {
  return row ? { ...row, source_issue: readTaskSource(database, row.repository_id, row.number) } : row;
}
