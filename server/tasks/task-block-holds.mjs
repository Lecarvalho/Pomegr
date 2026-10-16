// A block's owner-controlled hold survives replacement of the agent's current report.
import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { isTaskId, taskIdFromNumber } from "./task-record.mjs";

const prefixOf = (repositoryId) => `task_block_hold:${repositoryId}:`;
const keyOf = (repositoryId, number) => `${prefixOf(repositoryId)}${taskIdFromNumber(Number(number))}`;

export function readTaskBlockHolds(database, repositoryId) {
  const prefix = prefixOf(repositoryId);
  return new Set(preparedStatement(database, "SELECT key FROM meta WHERE substr(key, 1, ?) = ? AND value = '1'")
    .all(prefix.length, prefix).map((row) => String(row.key).slice(prefix.length)).filter(isTaskId));
}

export function holdTaskBlock(database, repositoryId, number) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
    .run(keyOf(repositoryId, number));
}

export function deleteTaskBlockHold(database, repositoryId, number) {
  preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(keyOf(repositoryId, number));
}
