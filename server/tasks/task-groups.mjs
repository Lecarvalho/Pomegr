// The parallel groups: which tasks the owner put together to run at the same time, planned in Backlog or Ready before
// they are queued, and started together by the queue.
// A task's group is kept in `meta` under `task_group:<repositoryId>:<taskId>`, so the schema version does not change.

import { preparedStatement } from "../persistence/prepared-statements.mjs";
import { readColumnRoles, readyColumnId, taskNumbersInOrder, writeTaskOrder } from "./task-columns.mjs";
import { dispatchStanding } from "./task-dispatch-standing.mjs";
import { TASK_GROUP_ID, groupMemberCounts, isRepositoryId, isTaskId, normalizeTaskIdList, taskIdFromNumber } from "./task-record.mjs";

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
const MEMBER_ROWS = "SELECT number, state, session_id, dispatch_token, column_id, position FROM tasks WHERE repository_id = ? AND state IN ('not_queued', 'queued', 'scheduled')";

// The columns with no role: Backlog and Ready, where the owner plans and queues.
function unroledColumns(database, repositoryId) {
  const roles = readColumnRoles(database, repositoryId);
  return new Set(preparedStatement(database, "SELECT id FROM columns WHERE repository_id = ?").all(repositoryId).map((row) => row.id).filter((id) => !roles.has(id)));
}

// The tasks whose membership counts, by task number: in the queue, waiting or in flight, or planned in Backlog or Ready.
function countingRows(database, repositoryId) {
  const unroled = unroledColumns(database, repositoryId);
  return new Map(preparedStatement(database, MEMBER_ROWS).all(repositoryId)
    .filter((row) => groupMemberCounts(row, unroled.has(row.column_id))).map((row) => [Number(row.number), row]));
}

// A group holds only tasks whose membership counts, and at least two of them. Every other stored membership goes: the
// task that left the queue or was started by hand, the planned task moved to a column with a role, and the task left
// alone in its group.
export function pruneTaskGroups(database, repositoryId) {
  const stored = readTaskGroups(database, repositoryId);
  if (stored.size === 0) return;
  const counting = countingRows(database, repositoryId);
  const sizes = new Map();
  for (const [number, group] of stored) if (counting.has(number)) sizes.set(group, (sizes.get(group) ?? 0) + 1);
  for (const [number, group] of stored) if (!counting.has(number) || sizes.get(group) < 2) writeTaskGroup(database, repositoryId, number, null);
}

// Whether a task starts as a member of a parallel group, and so in its own worktree. Only members in the queue count:
// a planned member that is not queued does not start with the group.
export function taskRunsInGroup(database, repositoryId, taskNumber) {
  const stored = readTaskGroups(database, repositoryId);
  const group = stored.get(taskNumber);
  if (group === undefined) return false;
  const inQueue = new Set(preparedStatement(database, QUEUE_ROWS).all(repositoryId).map((row) => Number(row.number)));
  let members = 0;
  for (const [number, other] of stored) if (other === group && inQueue.has(number)) members += 1;
  return inQueue.has(taskNumber) && members > 1;
}

const queued = (row) => row.state === "queued" || row.state === "scheduled";
// A task that has not started: no linked session and no live dispatch, in a state before any outcome.
const notStarted = (row, at) => row !== undefined && (row.session_id ?? null) === null && dispatchStanding(row.dispatch_token, at) !== "live"
  && (row.state === "not_queued" || queued(row));

function refusedRows(database, repositoryId, numbers, counting, at) {
  const exists = preparedStatement(database, "SELECT 1 FROM tasks WHERE repository_id = ? AND number = ?");
  for (const number of numbers) {
    if (exists.get(repositoryId, number) === undefined) return "not_found";
    if (!notStarted(counting.get(number), at)) return "conflict";
  }
  return null;
}

const columnOf = (database, repositoryId, number) =>
  preparedStatement(database, "SELECT column_id FROM tasks WHERE repository_id = ? AND number = ?").get(repositoryId, number).column_id;

// `queue_group`: the listed cards run in parallel. Each is a waiting card of the queue or a planned card of Backlog or
// Ready. They join the group of the first listed card that is in one, or a new group, and stand together: in Ready when
// any member is in the queue, otherwise in the first listed card's column.
export function groupTasks({ database, repositoryId, now, newGroupId }, payload) {
  const numbers = normalizeTaskIdList(payload, 2, TASK_GROUP_LIMIT);
  if (!numbers) return { ok: false, error: "invalid" };
  const at = now();
  pruneTaskGroups(database, repositoryId);
  const counting = countingRows(database, repositoryId);
  const refused = refusedRows(database, repositoryId, numbers, counting, at);
  if (refused) return { ok: false, error: refused };
  const stored = readTaskGroups(database, repositoryId);
  const grouped = numbers.find((number) => stored.has(number));
  const group = grouped === undefined ? newGroupId() : stored.get(grouped);
  const joining = numbers.filter((number) => stored.get(number) !== group);
  const members = [...stored].filter(([, other]) => other === group).map(([number]) => number);
  // A group that gives every card that has not started away goes with them: its members that already run join too, so
  // they keep running in the same turn as the cards they started with.
  const listed = new Set(numbers);
  const carried = [];
  for (const former of new Set(joining.map((number) => stored.get(number)).filter((other) => other !== undefined))) {
    const rest = [...stored].filter(([number, other]) => other === former && !listed.has(number)).map(([number]) => number);
    if (rest.every((number) => !notStarted(counting.get(number), at))) carried.push(...rest);
  }
  const all = new Set([...members, ...numbers, ...carried]);
  if (all.size > TASK_GROUP_LIMIT) return { ok: false, error: "limit" };
  if (joining.length === 0) return { ok: true };
  for (const number of new Set([numbers[0], ...joining, ...carried])) writeTaskGroup(database, repositoryId, number, group);

  const inQueue = [...all].some((number) => counting.has(number) && queued(counting.get(number)));
  const column = (inQueue ? readyColumnId(database, repositoryId) : null) ?? columnOf(database, repositoryId, numbers[0]);
  // The listed cards that join land right after the group's last card in that column, or last when none is there.
  // The first listed card stays where it is unless the group stands in another column.
  const moved = new Set(numbers.filter((number) => (number === numbers[0] ? columnOf(database, repositoryId, number) !== column : joining.includes(number))));
  const order = taskNumbersInOrder(database, repositoryId, column).filter((number) => !moved.has(number));
  const inGroup = new Set([numbers[0], ...members]);
  const present = order.map((number, index) => (inGroup.has(number) ? index : -1)).filter((index) => index >= 0);
  const last = present.length > 0 ? Math.max(...present) : order.length - 1;
  const left = new Set();
  const arrive = preparedStatement(database, "UPDATE tasks SET column_id = ? WHERE repository_id = ? AND number = ?");
  for (const number of moved) {
    const from = columnOf(database, repositoryId, number);
    if (from !== column) { arrive.run(column, repositoryId, number); left.add(from); }
  }
  order.splice(last + 1, 0, ...numbers.filter((number) => moved.has(number)));
  writeTaskOrder(database, repositoryId, order);
  for (const columnId of left) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  return { ok: true };
}

// `queue_ungroup`: each listed card leaves its group and keeps its place. A card in no group changes nothing.
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
    if (stored.has(number) && !notStarted(task, at)) return { ok: false, error: "conflict" };
  }
  for (const number of numbers) writeTaskGroup(database, repositoryId, number, null);
  return { ok: true };
}

// The members of one group that have not started, in board order (column, then place): the cards that move together.
export function groupCardsNotStarted(database, repositoryId, group, at) {
  const stored = readTaskGroups(database, repositoryId);
  const columns = new Map(preparedStatement(database, "SELECT id, position FROM columns WHERE repository_id = ?").all(repositoryId).map((row) => [row.id, Number(row.position)]));
  return preparedStatement(database, MEMBER_ROWS).all(repositoryId)
    .filter((row) => stored.get(Number(row.number)) === group && notStarted(row, at))
    .sort((a, b) => (columns.get(a.column_id) ?? 0) - (columns.get(b.column_id) ?? 0) || Number(a.position) - Number(b.position) || Number(a.number) - Number(b.number))
    .map((row) => Number(row.number));
}

// After every action, the cards of each group that have not started stand together in one lane: Ready when one of them
// is there, otherwise the lane of the first, at the place of that lane's first member. No other card is reordered.
export function settleGroupLanes(database, repositoryId, at) {
  const stored = readTaskGroups(database, repositoryId);
  const readyId = readyColumnId(database, repositoryId);
  const arrive = preparedStatement(database, "UPDATE tasks SET column_id = ? WHERE repository_id = ? AND number = ?");
  for (const group of new Set(stored.values())) {
    const cards = groupCardsNotStarted(database, repositoryId, group, at);
    if (cards.length < 2) continue;
    const lanes = cards.map((number) => columnOf(database, repositoryId, number));
    const lane = readyId !== null && lanes.includes(readyId) ? readyId : lanes[0];
    const order = taskNumbersInOrder(database, repositoryId, lane);
    const members = new Set(cards);
    const anchor = order.findIndex((number) => members.has(number));
    const inLane = order.filter((number) => members.has(number));
    const arriving = cards.filter((number) => !inLane.includes(number));
    const rest = order.filter((number) => !members.has(number));
    const settled = [...rest.slice(0, anchor), ...inLane, ...arriving, ...rest.slice(anchor)];
    const left = new Set();
    for (const number of arriving) {
      left.add(columnOf(database, repositoryId, number));
      arrive.run(lane, repositoryId, number);
    }
    if (settled.join() !== order.join()) writeTaskOrder(database, repositoryId, settled);
    for (const columnId of left) writeTaskOrder(database, repositoryId, taskNumbersInOrder(database, repositoryId, columnId));
  }
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
