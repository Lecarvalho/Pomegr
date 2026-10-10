// The pure queue rule: which queued task starts when, and how each feature's steps stand.
// It takes plain records and returns plain values, with no store, route, or Git access, and it
// never throws on odd input: a record it cannot place is ignored, not reported.
//
// A task in a feature runs by feature order, then step, then task number, because a step starts
// only when the step before it is done and the tasks of one step run in parallel. A task without a
// feature has no such structure, so it runs in the order of its card in the Ready column. Only tasks that wait to
// start now are in the order: those in state `queued`, and those in state `scheduled` whose own
// time has come (`due`). Every task of a feature takes part in its steps.
//
// The schedule rules are pure too and take the clock as a value: a scheduled task is due from its
// own time on, and a queue starts nothing before its start time or from its stop time on. A time
// that passed while nothing was asking is simply in the past at the next question, so a missed
// start happens then, and only if the stop time has not come.

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;

const isRecord = (value) => value !== null && typeof value === "object";

/** The number of a `T-<n>` task ID, or undefined; "T-2" sorts before "T-10". */
const taskNumber = (id) => (typeof id === "string" && TASK_ID.test(id) ? Number(id.slice(2)) : undefined);

/** Stored feature steps are integers of at least 1; anything else places the task nowhere. */
const isStep = (value) => Number.isSafeInteger(value) && value >= 1;

/** A scheduled task is due from its own time on. `scheduledAt` and `at` are epoch milliseconds; a task with no time has nothing to wait for. */
export function taskIsDue(scheduledAt, at) {
  if (scheduledAt === null || scheduledAt === undefined) return true;
  return Number.isSafeInteger(scheduledAt) && Number.isFinite(at) && scheduledAt <= at;
}

/**
 * Why a queue's own schedule holds every start at `at`: `before_queue_start` until `startAt`, `after_queue_stop` from
 * `stopAfter` on, or null. All three are epoch milliseconds, the two settings null when not set; a setting that is
 * not a time is not set. A clock that is not a number holds like a stop: nothing starts on an unknown time.
 */
export function queueWindowHold(schedule, at) {
  const { startAt = null, stopAfter = null } = isRecord(schedule) ? schedule : {};
  if (!Number.isFinite(at)) return Number.isSafeInteger(startAt) || Number.isSafeInteger(stopAfter) ? "after_queue_stop" : null;
  if (Number.isSafeInteger(stopAfter) && at >= stopAfter) return "after_queue_stop";
  return Number.isSafeInteger(startAt) && at < startAt ? "before_queue_start" : null;
}

/**
 * `tasks` are `{ id, featureId, step, state, queuePosition, due, inFlight }` and `features` are `{ id }` in board
 * order. `inFlight` is optional: a task already started (its session linked with no outcome, or a live dispatch) is not in `order`, but stays in its step, so the step is not done. `queuePosition` is the place of the task's card in its column (the store keeps every waiting card in Ready), or null.
 * `due` is true for a `scheduled` task whose own time has come; the caller, which holds the clock, supplies it.
 *
 * Returns `{ order, steps }`:
 * - `order`: the IDs of the tasks that wait to start now, in the order they would start. Features in the given
 *   order, each feature's steps ascending, the tasks of one step by task number; then the queued
 *   tasks without a feature by `queuePosition` ascending (null last), ties by task number.
 * - `steps`: every step of every feature, features in the given order and steps ascending, with the
 *   IDs of its tasks of any state by task number and `done` true when every one of them is done.
 *
 * A task whose `featureId` names no listed feature, or whose step is not an integer of at least 1,
 * is a task without a feature. A record without a valid task ID is ignored, and so is a repeated ID.
 */
export function orderQueue(tasks, features) {
  const featureIds = [];
  const known = new Set();
  for (const feature of Array.isArray(features) ? features : []) {
    if (!isRecord(feature) || typeof feature.id !== "string" || feature.id === "" || known.has(feature.id)) continue;
    known.add(feature.id);
    featureIds.push(feature.id);
  }

  const entries = [];
  const seen = new Set();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const number = isRecord(task) ? taskNumber(task.id) : undefined;
    if (number === undefined || seen.has(task.id)) continue;
    seen.add(task.id);
    const placed = typeof task.featureId === "string" && known.has(task.featureId) && isStep(task.step);
    entries.push({
      id: task.id,
      number,
      featureId: placed ? task.featureId : null,
      step: placed ? task.step : null,
      queued: task.inFlight !== true && (task.state === "queued" || (task.state === "scheduled" && task.due === true)),
      done: task.state === "done",
      queuePosition: Number.isSafeInteger(task.queuePosition) ? task.queuePosition : null,
    });
  }
  // Sorted once by number, so every group below keeps task-number order.
  entries.sort((a, b) => a.number - b.number);

  const byFeature = new Map(featureIds.map((id) => [id, new Map()]));
  const singles = [];
  for (const entry of entries) {
    if (entry.featureId === null) {
      if (entry.queued) singles.push(entry);
      continue;
    }
    const stepsOfFeature = byFeature.get(entry.featureId);
    if (!stepsOfFeature.has(entry.step)) stepsOfFeature.set(entry.step, []);
    stepsOfFeature.get(entry.step).push(entry);
  }

  const order = [];
  const steps = [];
  for (const featureId of featureIds) {
    const stepsOfFeature = byFeature.get(featureId);
    for (const step of [...stepsOfFeature.keys()].sort((a, b) => a - b)) {
      const inStep = stepsOfFeature.get(step);
      steps.push({ featureId, step, taskIds: inStep.map((entry) => entry.id), done: inStep.every((entry) => entry.done) });
      for (const entry of inStep) if (entry.queued) order.push(entry.id);
    }
  }
  const position = (entry) => entry.queuePosition ?? Number.POSITIVE_INFINITY;
  singles.sort((a, b) => (position(a) === position(b) ? a.number - b.number : position(a) < position(b) ? -1 : 1));
  for (const entry of singles) order.push(entry.id);

  return { order, steps };
}

/** Outcomes that need the user and hold a running queue. */
const UNRESOLVED_STATES = new Set(["needs_review", "stalled", "blocked"]);

/**
 * The status a queue takes when the user turns it on. `tasks` are `{ id, state }`. A queue that finds a task needing
 * the user (Needs review, Stalled, or Blocked by agent) starts blocked and names the lowest-numbered one; otherwise
 * it runs. A record without a valid task ID is ignored. Returns `{ status, blockedBy }`.
 */
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

/**
 * The task a feature task waits on: the lowest-numbered task that is not done in the earliest step before its own
 * that is not done, or null when every earlier step is done. `tasks` are `{ id, featureId, step, state }` and
 * `features` are `{ id }`. A task without a feature, or one the rule cannot place, waits on nothing.
 */
export function previousStepBlocker(taskId, tasks, features) {
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const task = records.find((record) => record.id === taskId);
  if (!task || !isStep(task.step)) return null;
  const earlier = orderQueue(records, features).steps.find((entry) => entry.featureId === task.featureId && entry.step < task.step && !entry.done);
  return earlier?.taskIds.find((id) => records.find((record) => record.id === id)?.state !== "done") ?? null;
}

/**
 * What a queue does next. `tasks` are `{ id, featureId, step, state, queuePosition, due, inFlight, unlinked }` and `features`
 * are `{ id }` in board order. The store supplies two facts the rule cannot know: `inFlight` is true for a task whose
 * session is linked and has no outcome yet, or whose start is still waiting for its session to report; `unlinked` is true
 * for a task whose start expired with no session ever linked.
 *
 * Returns `{ starts: taskIds }`, `{ pause: taskId }`, or null for nothing to do. The queue only acts while `running`, one
 * step at a time. With nothing in flight the step is the one of `orderQueue`'s first task, so the task the board marks as
 * next is always among the starts, and the starts are every queued task of that step: the tasks of one step run in
 * parallel. A task without a feature is a step of its own. While tasks are in flight, only the queued rest of their own
 * step may join them; tasks in flight outside one feature step hold the queue. A step whose earlier feature steps are
 * not all done waits: the queue never skips ahead to a later task. A scheduled task that is not due is not in the order,
 * so the tasks behind it start, and the step it is in stays not done until it ran. The queue's own start and stop
 * times are the caller's to judge (`queueWindowHold`).
 */
export function nextQueueStart(input) {
  const { status, tasks, features } = isRecord(input) ? input : {};
  if (status !== "running") return null;
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { order, steps } = orderQueue(records, features);
  const byId = new Map();
  for (const task of records) if (!byId.has(task.id)) byId.set(task.id, task);
  const stepOf = (id) => steps.find((entry) => entry.taskIds.includes(id)) ?? null;

  // `orderQueue` already leaves a task in flight out of `order`.
  if (order.length === 0) return null;
  const flying = records.filter((task) => task.inFlight === true);
  const current = stepOf(flying.length > 0 ? flying[0].id : order[0]);
  if (flying.length > 0 && (current === null || flying.some((task) => stepOf(task.id) !== current))) return null;
  const candidates = current === null ? [order[0]] : order.filter((id) => current.taskIds.includes(id));
  if (candidates.length === 0) return null;
  const unlinked = candidates.find((id) => byId.get(id).unlinked === true);
  if (unlinked !== undefined) return { pause: unlinked };
  if (current !== null && steps.some((entry) => entry.featureId === current.featureId && entry.step < current.step && !entry.done)) return null;
  return { starts: candidates };
}
