// The fixed five columns, their roles, and the card move that follows a task's state.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { COLUMN_ID, DEFAULT_TASK_COLUMNS, DEFAULT_TASK_COLUMN_ROLES, STORED_COLUMN_READ_BOUNDS, TASK_COLUMN_ROLES, normalizeStoredColumn } from "./task-record.mjs";

const roleKey = (repositoryId, role) => `column_role:${repositoryId}:${role}`;

const storedRoleColumn = (database, repositoryId, role) => {
  const value = preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(roleKey(repositoryId, role))?.value;
  return typeof value === "string" && COLUMN_ID.test(value) ? value : null;
};

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

export function seedColumnRoles(database, repositoryId, columnIds) {
  DEFAULT_TASK_COLUMN_ROLES.forEach((role, index) => { if (role !== null && columnIds[index]) writeRole(database, repositoryId, role, columnIds[index]); });
}

export const taskNumbersInOrder = (database, repositoryId, columnId) =>
  preparedStatement(database, "SELECT number FROM tasks WHERE repository_id = ? AND column_id = ? ORDER BY position, number")
    .all(repositoryId, columnId).map((row) => Number(row.number));

export function writeTaskOrder(database, repositoryId, numbers) {
  const update = preparedStatement(database, "UPDATE tasks SET position = ? WHERE repository_id = ? AND number = ? AND position <> ?");
  numbers.forEach((number, index) => update.run(index, repositoryId, number, index));
}

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

export function hasFixedColumns(database, repositoryId) {
  const columns = storedColumns(database, repositoryId);
  if (columns.length !== DEFAULT_TASK_COLUMNS.length) return false;
  if (!columns.every((column, index) => column.position === index && column.name === DEFAULT_TASK_COLUMNS[index])) return false;
  return DEFAULT_TASK_COLUMN_ROLES.every((role, index) => role === null || storedRoleColumn(database, repositoryId, role) === columns[index].id);
}

const READY_COLUMN_INDEX = DEFAULT_TASK_COLUMNS.indexOf("Ready");

// The Ready column's ID: the second of the fixed five.
export function readyColumnId(database, repositoryId) {
  return hasFixedColumns(database, repositoryId) ? storedColumns(database, repositoryId)[READY_COLUMN_INDEX].id : null;
}

// Puts every waiting queue card in Ready, with the waiting cards of each parallel group together. `groups` is the
// stored group of each task by number. The waiting cards keep their order, which is the start order, and a card
// that does not wait keeps its place.
export function settleReadyColumn(database, repositoryId, groups = new Map()) {
  const readyId = readyColumnId(database, repositoryId);
  if (readyId === null) return;
  const waiting = preparedStatement(database, `SELECT number, column_id, queue_position FROM tasks
    WHERE repository_id = ? AND state IN ('queued', 'scheduled') AND session_id IS NULL ORDER BY queue_position IS NULL, queue_position, number`).all(repositoryId);
  if (waiting.length === 0) return;
  const cards = taskNumbersInOrder(database, repositoryId, readyId);
  const left = new Set();
  const arrive = preparedStatement(database, "UPDATE tasks SET column_id = ? WHERE repository_id = ? AND number = ?");
  for (const row of waiting) {
    if (row.column_id === readyId) continue;
    arrive.run(readyId, repositoryId, Number(row.number));
    cards.push(Number(row.number));
    left.add(row.column_id);
  }
  // A store from before Ready was the queue ordered its tasks by a stored position: that order is taken once.
  const legacy = waiting.some((row) => (row.queue_position ?? null) !== null);
  const waits = new Set(waiting.map((row) => Number(row.number)));
  const standing = legacy ? waiting.map((row) => Number(row.number)) : cards.filter((number) => waits.has(number));
  const byGroup = new Map();
  for (const number of standing) if (groups.has(number)) byGroup.set(groups.get(number), [...(byGroup.get(groups.get(number)) ?? []), number]);
  const inOrder = [];
  const placed = new Set();
  for (const number of standing) {
    if (placed.has(number)) continue;
    for (const member of byGroup.get(groups.get(number)) ?? [number]) { placed.add(member); inOrder.push(member); }
  }
  let next = 0;
  writeTaskOrder(database, repositoryId, cards.map((number) => (waits.has(number) ? inOrder[next++] : number)));
  for (const columnId of left) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  if (legacy) preparedStatement(database, "UPDATE tasks SET queue_position = NULL WHERE repository_id = ? AND queue_position IS NOT NULL").run(repositoryId);
}

// Brings the repository's board to the fixed five columns.
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
