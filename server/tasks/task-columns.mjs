// The fixed five columns, their roles, and the card move that follows a task's state.
//
// Every board has exactly five columns in this order: Backlog, Ready, In progress, Review, Done. None is added,
// renamed, reordered, or removed. The last three carry the roles `in_progress`, `review`, and `done`; Backlog and Ready
// carry none. The roles are kept in the existing `meta` table under `column_role:<repositoryId>:<role>` with the
// column ID as the value, so the schema version does not change and an older build still opens the store. A row that
// names a column the repository no longer has is no role.
//
// A store written before the columns were fixed may hold other columns. `reconcileFixedColumns` brings such a board
// to the five in one transaction, moving tasks and never deleting one.
//
// A card moves only inside the write that persists the state it follows: the session link (`in_progress`), a
// report verified as Needs review (`review`) or Done (`done`), and the user's Mark done (`done`). Blocked, Stalled, and
// Requeue move nothing. The card lands last in the role's column wherever it was, also after a move by hand; with no
// column holding the role, or the card already there, nothing moves. No observation moves a card, so no move is
// ever taken back.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { COLUMN_ID, DEFAULT_TASK_COLUMNS, DEFAULT_TASK_COLUMN_ROLES, STORED_COLUMN_READ_BOUNDS, TASK_COLUMN_ROLES, normalizeStoredColumn } from "./task-record.mjs";

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

const storedColumns = (database, repositoryId) =>
  preparedStatement(database, "SELECT id, name, position FROM columns WHERE repository_id = ? ORDER BY position, id").all(repositoryId);

/** True when the repository's columns are already exactly the five, in place, with their roles. Issues no write. */
export function hasFixedColumns(database, repositoryId) {
  const columns = storedColumns(database, repositoryId);
  if (columns.length !== DEFAULT_TASK_COLUMNS.length) return false;
  if (!columns.every((column, index) => column.position === index && column.name === DEFAULT_TASK_COLUMNS[index])) return false;
  return DEFAULT_TASK_COLUMN_ROLES.every((role, index) => role === null || storedRoleColumn(database, repositoryId, role) === columns[index].id);
}

/**
 * Brings the repository's board to the fixed five columns. The caller owns the transaction and passes `newColumnId()`,
 * which makes a fresh opaque column ID. A board that already matches is not written; so is a board over the read bounds of
 * an older store or with a column row outside the stored contract, which stays unavailable. Each stored column goes to the slot of its role, else of its name (trimmed,
 * case-insensitive), else Backlog. The first column that matches a slot by role or name stays that slot's row, so its tasks
 * keep their column; a slot with none gets a new row. Every other column is merged into its slot: its tasks follow the
 * tasks already there, in stored column order and then their own order, and its row is deleted. No task is changed beyond
 * its column and position, and none is deleted.
 */
export function reconcileFixedColumns(database, repositoryId, newColumnId) {
  if (hasFixedColumns(database, repositoryId)) return;
  const columns = storedColumns(database, repositoryId);
  const roles = readColumnRoles(database, repositoryId);
  // A column row outside the stored contract is never repaired: the board stays unavailable and unwritten.
  if (columns.length > STORED_COLUMN_READ_BOUNDS.columns || columns.some((column) => normalizeStoredColumn({ ...column, role: roles.get(column.id) ?? null }) === undefined)) return;

  const slotByName = new Map(DEFAULT_TASK_COLUMNS.map((name, slot) => [name.toLowerCase(), slot]));
  const resolved = columns.map((column) => {
    const role = roles.get(column.id);
    if (role !== undefined) return { column, slot: DEFAULT_TASK_COLUMN_ROLES.indexOf(role), direct: true };
    const slot = slotByName.get(String(column.name).trim().toLowerCase());
    return slot === undefined ? { column, slot: 0, direct: false } : { column, slot, direct: true };
  });

  const slotIds = DEFAULT_TASK_COLUMNS.map((_, slot) => resolved.find((entry) => entry.direct && entry.slot === slot)?.column.id ?? null);
  const order = DEFAULT_TASK_COLUMNS.map(() => []);
  // Read every order before any task moves, so the lists below do not depend on the writes in between.
  slotIds.forEach((id, slot) => { if (id !== null) order[slot].push(...taskNumbersInOrder(database, repositoryId, id)); });
  for (const { column, slot } of resolved) if (column.id !== slotIds[slot]) order[slot].push(...taskNumbersInOrder(database, repositoryId, column.id));
  const insert = preparedStatement(database, "INSERT INTO columns (id, repository_id, name, position) VALUES (?, ?, ?, ?)");
  slotIds.forEach((id, slot) => {
    if (id !== null) return;
    slotIds[slot] = newColumnId();
    insert.run(slotIds[slot], repositoryId, DEFAULT_TASK_COLUMNS[slot], slot);
  });

  const moveTasks = preparedStatement(database, "UPDATE tasks SET column_id = ? WHERE repository_id = ? AND column_id = ?");
  const deleteColumn = preparedStatement(database, "DELETE FROM columns WHERE repository_id = ? AND id = ?");
  for (const { column, slot } of resolved) {
    if (column.id === slotIds[slot]) continue;
    moveTasks.run(slotIds[slot], repositoryId, column.id);
    deleteColumn.run(repositoryId, column.id);
  }
  const update = preparedStatement(database, "UPDATE columns SET name = ?, position = ? WHERE repository_id = ? AND id = ?");
  slotIds.forEach((id, slot) => update.run(DEFAULT_TASK_COLUMNS[slot], slot, repositoryId, id));
  order.forEach((numbers) => writeTaskOrder(database, repositoryId, numbers));
  DEFAULT_TASK_COLUMN_ROLES.forEach((role, slot) => { if (role !== null) writeRole(database, repositoryId, role, slotIds[slot]); });
}
