// The parallel groups of Ready: which queued tasks the owner put together to run at the same time.
// A task's group is kept in `meta` under `task_group:<repositoryId>:<taskId>`, so the schema version does not change.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { taskNumbersInOrder, writeTaskOrder } from "./task-columns.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { TASK_GROUP_ID, isRepositoryId, isTaskId, normalizeTaskIdList, taskIdFromNumber } from "./task-record.mjs";

// A group starts in one answer of the queue runner, which takes at most this many starts.
export const TASK_GROUP_LIMIT = 16;

const prefixOf = (repositoryId) => `task_group:${repositoryId}:`;
const migratedKey = (repositoryId) => `ready_groups:${repositoryId}`;
const MIGRATED = "1";

// The stored group of each task of one repository, by task number.
export function readTaskGroups(database, repositoryId) {
  const groups = new Map();
  if (!isRepositoryId(repositoryId)) return groups;
  const prefix = prefixOf(repositoryId);
  const rows = preparedStatement(database, "SELECT key, value FROM meta WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix);
  for (const row of rows) {
    const taskId = String(row.key).slice(prefix.length);
    if (isTaskId(taskId) && typeof row.value === "string" && TASK_GROUP_ID.test(row.value)) groups.set(Number(taskId.slice(2)), row.value);
  }
  return groups;
}

export function writeTaskGroup(database, repositoryId, taskNumber, group) {
  const key = `${prefixOf(repositoryId)}${taskIdFromNumber(taskNumber)}`;
  if (group === null) preparedStatement(database, "DELETE FROM meta WHERE key = ?").run(key);
  else preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, group);
}

const QUEUE_ROWS = "SELECT number, state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND state IN ('queued', 'scheduled')";

// A group holds only tasks that are in the queue, waiting or in flight, and at least two of them. Every other stored
// membership goes: the task that left the queue, and the task left alone in its group.
export function pruneTaskGroups(database, repositoryId) {
  const stored = readTaskGroups(database, repositoryId);
  if (stored.size === 0) return;
  const inQueue = new Set(preparedStatement(database, QUEUE_ROWS).all(repositoryId).map((row) => Number(row.number)));
  const sizes = new Map();
  for (const [number, group] of stored) if (inQueue.has(number)) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  for (const [number, group] of stored) if (!inQueue.has(number) || sizes.get(group) < 2) writeTaskGroup(database, repositoryId, number, null);
}

// Whether a task starts as a member of a parallel group, and so in its own worktree.
export function taskRunsInGroup(database, repositoryId, taskNumber) {
  const stored = readTaskGroups(database, repositoryId);
  const group = stored.get(taskNumber);
  if (group === undefined) return false;
  const inQueue = new Set(preparedStatement(database, QUEUE_ROWS).all(repositoryId).map((row) => Number(row.number)));
  let members = 0;
  for (const [number, other] of stored) if (other === group && inQueue.has(number)) members += 1;
  return inQueue.has(taskNumber) && members > 1;
}

const waits = (row, at) => row !== undefined && (row.session_id ?? null) === null && dispatchStanding(row.dispatch_token, at) !== "live";

function waitingRows(database, repositoryId, numbers, at) {
  const rows = new Map(preparedStatement(database, QUEUE_ROWS).all(repositoryId).map((row) => [Number(row.number), row]));
  const exists = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?");
  for (const number of numbers) {
    if (exists.get(repositoryId, number) === undefined) return "not_found";
    if (!waits(rows.get(number), at)) return "conflict";
  }
  return null;
}

// `queue_group`: the listed waiting cards run in parallel. They join the group of the first listed card that is in
// one, or a new group, and stand together in Ready.
export function groupTasks({ database, repositoryId, now, newGroupId }, payload) {
  const numbers = normalizeTaskIdList(payload, 2, TASK_GROUP_LIMIT);
  if (!numbers) return { ok: false, error: "invalid" };
  const refused = waitingRows(database, repositoryId, numbers, now());
  if (refused) return { ok: false, error: refused };
  pruneTaskGroups(database, repositoryId);
  const stored = readTaskGroups(database, repositoryId);
  const grouped = numbers.find((number) => stored.has(number));
  const group = grouped === undefined ? newGroupId() : stored.get(grouped);
  const joining = numbers.filter((number) => stored.get(number) !== group);
  const members = [...stored].filter(([, other]) => other === group).map(([number]) => number);
  // A group that gives every waiting card away goes with them: its members that already run join too, so they
  // keep running in the same turn as the cards they started with.
  const listed = new Set(numbers);
  const at = now();
  const queued = new Map(preparedStatement(database, QUEUE_ROWS).all(repositoryId).map((row) => [Number(row.number), row]));
  const carried = [];
  for (const former of new Set(joining.map((number) => stored.get(number)).filter((other) => other !== undefined))) {
    const rest = [...stored].filter(([number, other]) => other === former && !listed.has(number)).map(([number]) => number);
    if (rest.every((number) => !waits(queued.get(number), at))) carried.push(...rest);
  }
  if (new Set([...members, ...numbers, ...carried]).size > TASK_GROUP_LIMIT) return { ok: false, error: "limit" };
  if (joining.length === 0) return { ok: true };
  for (const number of new Set([numbers[0], ...joining, ...carried])) writeTaskGroup(database, repositoryId, number, group);

  const column = preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, numbers[0]).column_id;
  const moved = new Set(joining.filter((number) => number !== numbers[0]));
  const order = taskNumbersInOrder(database, repositoryId, column).filter((number) => !moved.has(number));
  const inGroup = new Set([numbers[0], ...members]);
  let last = order.indexOf(numbers[0]);
  order.forEach((number, index) => { if (inGroup.has(number)) last = Math.max(last, index); });
  const left = new Set();
  const arrive = preparedStatement(database, "UPDATE tasks SET column_id = ? WHERE repository_id = ? AND number = ?");
  for (const number of moved) {
    const from = preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number).column_id;
    if (from !== column) { arrive.run(column, repositoryId, number); left.add(from); }
  }
  order.splice(last + 1, 0, ...joining.filter((number) => moved.has(number)));
  writeTaskOrder(database, repositoryId, order);
  for (const columnId of left) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  return { ok: true };
}

// `queue_ungroup`: each listed waiting card leaves its group and keeps its place. A card in no group changes nothing.
export function ungroupTasks({ database, repositoryId, now }, payload) {
  const numbers = normalizeTaskIdList(payload, 1, TASK_GROUP_LIMIT);
  if (!numbers) return { ok: false, error: "invalid" };
  const stored = readTaskGroups(database, repositoryId);
  const at = now();
  const row = preparedStatement(database, "SELECT state, session_id, dispatch_token FROM tasks WHERE repository_id = ? AND number = ?");
  for (const number of numbers) {
    const task = row.get(repositoryId, number);
    if (task === undefined) return { ok: false, error: "not_found" };
    // A member that started runs in its group's turn until it reports.
    if (stored.has(number) && !waits(task, at)) return { ok: false, error: "conflict" };
  }
  for (const number of numbers) writeTaskGroup(database, repositoryId, number, null);
  return { ok: true };
}

export function markReadyGroupsMigrated(database, repositoryId) {
  preparedStatement(database, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(migratedKey(repositoryId), MIGRATED);
}

// A board written while a feature held steps is brought to parallel groups once: the tasks of one step that are in
// the queue, waiting or in flight, become one group when there are two or more. No task row is deleted, and a
// task's column, place, feature, state, session, dispatch, and report stay as they are. The `step` column stays in
// the schema, unread after this and written only with 1 for a task of a feature, so the schema version stays 1.
export function migrateStepGroups(database, repositoryId, newGroupId) {
  if (preparedStatement(database, "SELECT value FROM meta WHERE key = ?").get(migratedKey(repositoryId))?.value === MIGRATED) return;
  const rows = preparedStatement(database, `SELECT number, feature_id, step FROM tasks
    WHERE repository_id = ? AND feature_id IS NOT NULL AND step IS NOT NULL AND state IN ('queued', 'scheduled') ORDER BY number`).all(repositoryId);
  const steps = new Map();
  for (const row of rows) {
    const key = `${row.feature_id}:${Number(row.step)}`;
    steps.set(key, [...(steps.get(key) ?? []), Number(row.number)]);
  }
  for (const numbers of steps.values()) {
    if (numbers.length < 2) continue;
    const group = newGroupId();
    for (const number of numbers.slice(0, TASK_GROUP_LIMIT)) writeTaskGroup(database, repositoryId, number, group);
  }
  preparedStatement(database, "UPDATE tasks SET step = 1 WHERE repository_id = ? AND feature_id IS NOT NULL AND step <> 1").run(repositoryId);
  markReadyGroupsMigrated(database, repositoryId);
}
