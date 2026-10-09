// The pure queue rule: which queued task starts when, and how each feature's steps stand.
// It takes plain records and returns plain values, with no store, route, or Git access, and it
// never throws on odd input: a record it cannot place is ignored, not reported.
//
// A task in a feature runs by feature order, then step, then task number, because a step starts
// only when the step before it is done and the tasks of one step run in parallel. A task without a
// feature has no such structure, so it runs in the order it was queued. Only tasks in state
// `queued` are in the order; every task of a feature takes part in its steps.

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;

const isRecord = (value) => value !== null && typeof value === "object";

/** The number of a `T-<n>` task ID, or undefined; "T-2" sorts before "T-10". */
const taskNumber = (id) => (typeof id === "string" && TASK_ID.test(id) ? Number(id.slice(2)) : undefined);

/** Stored feature steps are integers of at least 1; anything else places the task nowhere. */
const isStep = (value) => Number.isSafeInteger(value) && value >= 1;

/**
 * `tasks` are `{ id, featureId, step, state, queuePosition }` and `features` are `{ id }` in board
 * order. `queuePosition` is the monitor-private integer a task received when it was queued, or null.
 *
 * Returns `{ order, steps }`:
 * - `order`: the IDs of the queued tasks in the order they would start. Features in the given
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
      queued: task.state === "queued",
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
 * What a queue does next. `tasks` are `{ id, featureId, step, state, queuePosition, inFlight, unlinked }` and `features`
 * are `{ id }` in board order. The store supplies two facts the rule cannot know: `inFlight` is true for a task whose
 * session is linked and has no outcome yet, or whose start is still waiting for its session to report; `unlinked` is true
 * for a task whose start expired with no session ever linked.
 *
 * Returns `{ start: taskId }`, `{ pause: taskId }`, or null for nothing to do. The queue only acts while `running`, one
 * task at a time, and always on `orderQueue`'s first task, so the task the board marks as next and the task that starts
 * next are one task. A candidate whose earlier feature steps are not all done waits: the queue never skips ahead to a
 * later task.
 */
export function nextQueueStart(input) {
  const { status, tasks, features } = isRecord(input) ? input : {};
  if (status !== "running") return null;
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  if (records.some((task) => task.inFlight === true)) return null;
  const { order, steps } = orderQueue(records, features);
  const candidateId = order[0];
  if (candidateId === undefined) return null;
  const candidate = records.find((task) => task.id === candidateId);
  if (candidate.unlinked === true) return { pause: candidateId };
  if (typeof candidate.featureId === "string" && isStep(candidate.step)
    && steps.some((entry) => entry.featureId === candidate.featureId && entry.step < candidate.step && !entry.done)) return null;
  return { start: candidateId };
}
