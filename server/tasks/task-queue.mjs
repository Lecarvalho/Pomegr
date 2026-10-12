// The pure queue rule: which queued task starts when, and how each feature's steps stand.

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const SETTLED_STATES = new Set(["done", "needs_review"]);

const isRecord = (value) => value !== null && typeof value === "object";

const taskNumber = (id) => (typeof id === "string" && TASK_ID.test(id) ? Number(id.slice(2)) : undefined);

const isStep = (value) => Number.isSafeInteger(value) && value >= 1;

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
      settled: SETTLED_STATES.has(task.state),
      inFlight: task.inFlight === true,
      queuePosition: Number.isSafeInteger(task.queuePosition) ? task.queuePosition : null,
    });
  }
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
  const held = [];
  const steps = [];
  for (const featureId of featureIds) {
    const stepsOfFeature = byFeature.get(featureId);
    const queuedOfFeature = [];
    // A feature is held when a step before its first queued one holds a task that is not settled and not running:
    // the queue will not start that task, so the feature's queued tasks wait behind everything else.
    let stuck = false;
    let isHeld = false;
    for (const step of [...stepsOfFeature.keys()].sort((a, b) => a - b)) {
      const inStep = stepsOfFeature.get(step);
      steps.push({ featureId, step, taskIds: inStep.map((entry) => entry.id), done: inStep.every((entry) => entry.done), settled: inStep.every((entry) => entry.settled) });
      const queuedInStep = inStep.filter((entry) => entry.queued);
      if (queuedInStep.length > 0 && queuedOfFeature.length === 0) isHeld = stuck;
      queuedOfFeature.push(...queuedInStep.map((entry) => entry.id));
      if (inStep.some((entry) => !entry.settled && !entry.inFlight)) stuck = true;
    }
    (isHeld ? held : order).push(...queuedOfFeature);
  }
  const position = (entry) => entry.queuePosition ?? Number.POSITIVE_INFINITY;
  singles.sort((a, b) => (position(a) === position(b) ? a.number - b.number : position(a) < position(b) ? -1 : 1));
  for (const entry of singles) order.push(entry.id);
  order.push(...held);

  return { order, steps };
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

export function previousStepBlocker(taskId, tasks, features) {
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const task = records.find((record) => record.id === taskId);
  if (!task || !isStep(task.step)) return null;
  const earlier = orderQueue(records, features).steps.find((entry) => entry.featureId === task.featureId && entry.step < task.step && !entry.settled);
  return earlier?.taskIds.find((id) => !SETTLED_STATES.has(records.find((record) => record.id === id)?.state)) ?? null;
}

// What a queue does next.
export function nextQueueStart(input) {
  const { status, tasks, features } = isRecord(input) ? input : {};
  if (status !== "running") return null;
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { order, steps } = orderQueue(records, features);
  const byId = new Map();
  for (const task of records) if (!byId.has(task.id)) byId.set(task.id, task);
  const stepOf = (id) => steps.find((entry) => entry.taskIds.includes(id)) ?? null;

  if (order.length === 0) return null;
  const flying = records.filter((task) => task.inFlight === true);
  const current = stepOf(flying.length > 0 ? flying[0].id : order[0]);
  if (flying.length > 0 && (current === null || flying.some((task) => stepOf(task.id) !== current))) return null;
  const candidates = current === null ? [order[0]] : order.filter((id) => current.taskIds.includes(id));
  if (candidates.length === 0) return null;
  const unlinked = candidates.find((id) => byId.get(id).unlinked === true);
  if (unlinked !== undefined) return { pause: unlinked };
  if (current !== null && steps.some((entry) => entry.featureId === current.featureId && entry.step < current.step && !entry.settled)) return null;
  return { starts: candidates };
}
