// The pure queue rule: which queued task starts when. Ready order decides, only a parallel group starts together, and a
// task that runs after an unfinished task waits out of the order.

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const QUEUE_STATES = new Set(["queued", "scheduled"]);

const isRecord = (value) => value !== null && typeof value === "object";

const taskNumber = (id) => (typeof id === "string" && TASK_ID.test(id) ? Number(id.slice(2)) : undefined);

export function taskIsDue(scheduledAt, at) {
  if (scheduledAt === null || scheduledAt === undefined) return true;
  return Number.isSafeInteger(scheduledAt) && Number.isFinite(at) && scheduledAt <= at;
}

export function queueWindowHold(schedule, at) {
  const { startAt = null, stopAfter = null } = isRecord(schedule) ? schedule : {};
  if (!Number.isFinite(at)) return Number.isSafeInteger(startAt) || Number.isSafeInteger(stopAfter) ? "after_queue_stop" : null;
  if (Number.isSafeInteger(stopAfter) && at >= stopAfter) return "after_queue_stop";
  return Number.isSafeInteger(startAt) && at < startAt ? "before_queue_start" : null;
}

// Whether a task still waits for a task it runs after that is not Done: it may not start, by the queue or by hand.
export const waitsForTasks = (task) => isRecord(task) && Array.isArray(task.waitsFor) && task.waitsFor.length > 0;

// The queue order and each task's parallel group. A group counts only while two or more of its tasks are in the queue,
// waiting or in flight; a task left alone in one is an ordinary task.
export function orderQueue(tasks) {
  const entries = [];
  const seen = new Set();
  const sizes = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const number = isRecord(task) ? taskNumber(task.id) : undefined;
    if (number === undefined || seen.has(task.id)) continue;
    seen.add(task.id);
    const inQueue = QUEUE_STATES.has(task.state);
    const group = inQueue && typeof task.group === "string" && task.group !== "" ? task.group : null;
    if (group !== null) sizes.set(group, (sizes.get(group) ?? 0) + 1);
    entries.push({
      id: task.id,
      number,
      group,
      // A task that runs after an unfinished task is not a candidate, like a scheduled task before its time.
      queued: task.inFlight !== true && !waitsForTasks(task) && (task.state === "queued" || (task.state === "scheduled" && task.due === true)),
      queuePosition: Number.isSafeInteger(task.queuePosition) ? task.queuePosition : null,
    });
  }
  const groups = new Map(entries.map((entry) => [entry.id, entry.group !== null && sizes.get(entry.group) > 1 ? entry.group : null]));
  const position = (entry) => entry.queuePosition ?? Number.POSITIVE_INFINITY;
  const order = entries.filter((entry) => entry.queued)
    .sort((a, b) => (position(a) === position(b) ? a.number - b.number : position(a) < position(b) ? -1 : 1))
    .map((entry) => entry.id);
  return { order, groups };
}

// Outcomes that hold a running queue until the user resolves them.
const UNRESOLVED_STATES = new Set(["stalled", "blocked"]);

// The status a queue takes when the user turns it on.
export function queueWhenTurnedOn(tasks) {
  let blockedBy = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const number = isRecord(task) && (UNRESOLVED_STATES.has(task.state) || task.held === true) ? taskNumber(task.id) : undefined;
    if (number !== undefined && number < lowest) {
      lowest = number;
      blockedBy = task.id;
    }
  }
  return blockedBy === null ? { status: "running", blockedBy: null } : { status: "blocked", blockedBy };
}

// The task in flight that a waiting task waits on: one that runs outside the task's own parallel group.
export function earlierTaskBlocker(taskId, tasks) {
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { groups } = orderQueue(records);
  if (!groups.has(taskId)) return null;
  const group = groups.get(taskId);
  let blocker = null;
  for (const record of records) {
    if (record.inFlight !== true || record.id === taskId || !groups.has(record.id) || (group !== null && groups.get(record.id) === group)) continue;
    if (blocker === null || taskNumber(record.id) < taskNumber(blocker)) blocker = record.id;
  }
  return blocker;
}

// What a queue does next. The queue never passes the first waiting task of Ready: it starts that task, with the
// waiting tasks of its parallel group when it has one. While tasks are in flight, only the waiting rest of their
// own group may start.
export function nextQueueStart(input) {
  const { status, tasks } = isRecord(input) ? input : {};
  if (status !== "running") return null;
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { order, groups } = orderQueue(records);
  if (order.length === 0) return null;
  const byId = new Map();
  for (const task of records) if (!byId.has(task.id)) byId.set(task.id, task);

  const flying = records.filter((task) => task.inFlight === true && groups.has(task.id));
  const group = groups.get(flying.length > 0 ? flying[0].id : order[0]) ?? null;
  if (flying.length > 0 && (group === null || flying.some((task) => groups.get(task.id) !== group))) return null;
  const candidates = group === null ? [order[0]] : order.filter((id) => groups.get(id) === group);
  if (candidates.length === 0) return null;
  const unlinked = candidates.find((id) => byId.get(id).unlinked === true);
  if (unlinked !== undefined) return { pause: unlinked };
  return { starts: candidates };
}
