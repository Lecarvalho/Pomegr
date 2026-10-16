// Superseded reports stay private to the task store, outside all observation evidence.
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { taskIdFromNumber } from "./task-record.mjs";

const keyOf = (repositoryId, number) => `task_report_history:${repositoryId}:${taskIdFromNumber(Number(number))}`;
export const TASK_REPORT_HISTORY_LIMIT = 100;

export function archiveTaskReport(database, row, report) {
  const key = keyOf(row.repository_id, row.number);
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(key)?.value;
  const history = value === undefined ? [] : JSON.parse(value);
  // Invalid retained history must not be silently overwritten.
  if (!Array.isArray(history)) throw new Error("TASK_REPORT_HISTORY_INVALID");
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify([...history, report].slice(-TASK_REPORT_HISTORY_LIMIT)));
}

export function deleteTaskReportHistory(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, number));
}
