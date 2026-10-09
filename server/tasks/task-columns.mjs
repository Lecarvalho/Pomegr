// Column roles and the card move that follows a task's state.
//
// Columns are the user's: up to twelve, renamed, reordered, and deleted at will, so a column is never recognized by
// its name or its place. A column may instead hold one fixed role (`in_progress`, `review`, `done`), and at most one
// column of a repository holds each role. The roles are kept in the existing `meta` table under
// `column_role:<repositoryId>:<role>` with the column ID as the value, so the schema version does not change and an
// older build still opens the store. A row that names a column the repository no longer has is no role.
//
// A card moves only inside the write that persists the state it follows: the session link (`in_progress`), a
// report verified as Needs review (`review`) or Done (`done`), and the user's Mark done (`done`). Blocked, Stalled, and
// Requeue move nothing. The card lands last in the role's column wherever it was, also after a move by hand; with no
// column holding the role, or the card already there, nothing moves. No observation moves a card, so no move is
// ever taken back.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { COLUMN_ID, DEFAULT_TASK_COLUMN_ROLES, TASK_COLUMN_ROLES, normalizeColumnRolePayload } from "./task-record.mjs";

const roleKey = (repositoryId, role) => `column_role:${repositoryId}:${role}`;

const storedRoleColumn = (database, repositoryId, role) => {
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(roleKey(repositoryId, role))?.value;
  return typeof value === "string" && COLUMN_ID.test(value) ? value : null;
};

/** The stored roles as `Map<columnId, role>`. A column named by two roles reads as the first of the fixed list. */
export function readColumnRoles(database, repositoryId) {
  const roles = new Map();
  for (const role of TASK_COLUMN_ROLES) {
    const columnId = storedRoleColumn(database, repositoryId, role);
    if (columnId !== null && !roles.has(columnId)) roles.set(columnId, role);
  }
  return roles;
}

const writeRole = (database, repositoryId, role, columnId) =>
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(roleKey(repositoryId, role), columnId);

/** Gives the freshly seeded default columns their roles. `columnIds` are in the order of `DEFAULT_TASK_COLUMNS`. */
export function seedColumnRoles(database, repositoryId, columnIds) {
  DEFAULT_TASK_COLUMN_ROLES.forEach((role, index) => { if (role !== null && columnIds[index]) writeRole(database, repositoryId, role, columnIds[index]); });
}

/** Takes every role off one column, for a column that is deleted or set to no role. */
export function clearColumnRoles(database, repositoryId, columnId) {
  for (const role of TASK_COLUMN_ROLES) {
    if (storedRoleColumn(database, repositoryId, role) === columnId) preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(roleKey(repositoryId, role));
  }
}

/**
 * `column_role`: `{ id, role }` gives one column a role, or none with `role: null`. A column holds one role, and a role
 * one column: the column's earlier role goes, and the column that held the role before loses it. No card moves.
 */
export function setColumnRole({ database, repositoryId }, payload) {
  const input = normalizeColumnRolePayload(payload);
  if (!input) return { ok: false, error: "invalid" };
  if (preparedStatement(database, "SELECT 1 FROM columns WHERE repository_id = ? AND id = ?").get(repositoryId, input.id) === undefined) return { ok: false, error: "not_found" };
  clearColumnRoles(database, repositoryId, input.id);
  if (input.role !== null) writeRole(database, repositoryId, input.role, input.id);
  return { ok: true };
}

// Positions stay dense (0..n-1) in every column. Each write reads the affected order, changes it as a list, and
// writes the whole list back, so a gap or a tie left by an earlier write is closed by the next one.
export const taskNumbersInOrder = (database, repositoryId, columnId) =>
  preparedStatement(database, "SELECT number FROM tasks WHERE repository_id = ? AND column_id = ? ORDER BY position, number")
    .all(repositoryId, columnId).map((row) => Number(row.number));

export function writeTaskOrder(database, repositoryId, numbers) {
  const update = preparedStatement(database, "UPDATE tasks SET position = ? WHERE repository_id = ? AND number = ? AND position <> ?");
  numbers.forEach((number, index) => update.run(index, repositoryId, number, index));
}

/**
 * Moves one task to the last place of the column that holds `role`. The caller owns the transaction and has just
 * written the state the move follows, with its update time. Nothing moves when no column of the repository holds the
 * role or the task is already in that column.
 */
export function moveTaskToRole(database, repositoryId, number, role) {
  const columnId = storedRoleColumn(database, repositoryId, role);
  if (columnId === null || preparedStatement(database, "SELECT 1 FROM columns WHERE repository_id = ? AND id = ?").get(repositoryId, columnId) === undefined) return;
  const task = preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number);
  if (!task || task.column_id === columnId) return;
  const order = taskNumbersInOrder(database, repositoryId, columnId);
  preparedStatement(database, "UPDATE tasks SET column_id = ?, position = ? WHERE repository_id = ? AND number = ?").run(columnId, order.length, repositoryId, number);
  writeTaskOrder(database, repositoryId, [...order, number]);
  writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, task.column_id));
}
