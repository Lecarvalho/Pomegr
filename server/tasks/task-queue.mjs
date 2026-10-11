// The pure queue rule: which queued task starts when. A task's place is its card's place; no task holds a step number.

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const SETTLED_STATES = new Set(["done", "needs_review"]);

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

// The start order: features in board order, a feature's tasks in the order of their cards, then the single tasks.
export function orderQueue(tasks, features) {
  const featureIds = [];
  const known = new Set();
  for (const feature of Array.isArray(features) ? features : []) {
    if (!isRecord(feature) || typeof feature.id !== "string" || feature.id === "" || known.has(feature.id)) continue;
    known.add(feature.id);
    featureIds.push(feature.id);
  }

  const queued = [];
  const seen = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const number = isRecord(task) ? taskNumber(task.id) : undefined;
    if (number === undefined || seen.has(task.id)) continue;
    seen.add(task.id);
    if (task.inFlight === true || !(task.state === "queued" || (task.state === "scheduled" && task.due === true))) continue;
    queued.push({
      id: task.id,
      number,
      featureId: typeof task.featureId === "string" && known.has(task.featureId) ? task.featureId : null,
      place: Number.isSafeInteger(task.queuePosition) ? task.queuePosition : Number.POSITIVE_INFINITY,
    });
  }
  queued.sort((a, b) => (a.place === b.place ? a.number - b.number : a.place < b.place ? -1 : 1));

  const order = [];
  for (const featureId of featureIds) for (const entry of queued) if (entry.featureId === featureId) order.push(entry.id);
  for (const entry of queued) if (entry.featureId === null) order.push(entry.id);
  return { order };
}

// Outcomes that hold a running queue until the user resolves them.
const UNRESOLVED_STATES = new Set(["stalled", "blocked"]);

// The status a queue takes when the user turns it on.
export function queueWhenTurnedOn(tasks) {
  let blockedBy = null;
  let lowest = Number.POSITIVE_INFINITY;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const number = isRecord(task) && UNRESOLVED_STATES.has(task.state) ? taskNumber(task.id) : undefined;
    if (number !== undefined && number < lowest) {
      lowest = number;
      blockedBy = task.id;
    }
  }
  return blockedBy === null ? { status: "running", blockedBy: null } : { status: "blocked", blockedBy };
}

const started = (task) => task.inFlight === true || task.linked === true || UNRESOLVED_STATES.has(task.state);
const waits = (task) => (task.state === "queued" || task.state === "scheduled") && !started(task);
const place = (task) => (Number.isSafeInteger(task.queuePosition) ? task.queuePosition : Number.POSITIVE_INFINITY);

// The earlier task of the same feature that a waiting task waits on: one that started and is not settled
// (the lowest-numbered), otherwise the first one that waits above it in Ready.
export function previousStepBlocker(taskId, tasks) {
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const task = records.find((record) => record.id === taskId);
  if (!task || typeof task.featureId !== "string" || task.featureId === "") return null;
  const others = records.filter((record) => record.id !== taskId && record.featureId === task.featureId && !SETTLED_STATES.has(record.state) && taskNumber(record.id) !== undefined);
  const running = others.filter(started).sort((a, b) => taskNumber(a.id) - taskNumber(b.id))[0];
  if (running) return running.id;
  const above = others.filter((record) => waits(record) && place(record) < place(task)).sort((a, b) => place(a) - place(b) || taskNumber(a.id) - taskNumber(b.id))[0];
  return above?.id ?? null;
}

// What a queue does next: one task at a time, the first of the order.
export function nextQueueStart(input) {
  const { status, tasks, features } = isRecord(input) ? input : {};
  if (status !== "running") return null;
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { order } = orderQueue(records, features);
  if (order.length === 0 || records.some((task) => task.inFlight === true)) return null;
  const next = order[0];
  if (records.find((task) => task.id === next).unlinked === true) return { pause: next };
  if (previousStepBlocker(next, records) !== null) return null;
  return { starts: [next] };
}
