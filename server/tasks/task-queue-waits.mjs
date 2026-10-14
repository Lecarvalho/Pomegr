// The pure wait rule: why each task that waits in the queue has not started. It reads the order and the next start
// from the queue rule and never orders anything itself.

import { TASK_GATE_REASONS } from "./task-gates.mjs";
import { nextQueueStart, orderQueue } from "./task-queue.mjs";

// Why a waiting task has not started: the queue's own state, the task's own time, the work the queue starts first,
// a start gate, or `unknown` when the committed facts name no reason.
export const TASK_QUEUE_WAIT_REASONS = Object.freeze([
  "queue_off", "queue_blocked", "queue_paused", "own_schedule", "earlier_tasks", "running_work", ...TASK_GATE_REASONS, "unknown",
]);
// A reason names at most this many tasks; `more` counts the rest.
export const TASK_QUEUE_WAIT_TASK_LIMIT = 8;

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const isRecord = (value) => value !== null && typeof value === "object";

function because(reason, ids = []) {
  const taskIds = ids.filter((id) => typeof id === "string" && TASK_ID.test(id));
  return { reason, taskIds: taskIds.slice(0, TASK_QUEUE_WAIT_TASK_LIMIT), more: Math.max(0, taskIds.length - TASK_QUEUE_WAIT_TASK_LIMIT) };
}

function queueReasons(status, blockedBy) {
  if (status === "running") return [];
  if (status === "idle") return [because("queue_off")];
  if (status === "blocked" || status === "paused") return [because(`queue_${status}`, [blockedBy])];
  return [because("unknown")];
}

// One entry per task that waits (queued or scheduled, and not started), in task order. `place` is the task's place in
// the start order, from 1, or null while it is not in the order. `candidate` marks a task the queue would start now,
// so only the start gates can still hold it; the composition judges those.
export function explainQueueWaits(input) {
  const { status, blockedBy, tasks } = isRecord(input) ? input : {};
  const records = (Array.isArray(tasks) ? tasks : []).filter(isRecord);
  const { order, groups } = orderQueue(records);
  // The next start of a queue that runs, so a queue that is off still says what it would start first.
  const decision = nextQueueStart({ status: "running", tasks: records });
  const starts = new Set(decision?.starts ?? []);
  // The tasks of a task's own parallel group start with it, so they are never ahead of it and never hold it.
  const together = (id, other) => (groups.get(id) ?? null) !== null && groups.get(id) === groups.get(other);
  const flying = records.filter((task) => task.inFlight === true && groups.has(task.id)).map((task) => task.id);
  const standing = queueReasons(status, blockedBy);

  const waits = [];
  const seen = new Set();
  for (const task of records) {
    if (typeof task.id !== "string" || !TASK_ID.test(task.id) || seen.has(task.id)) continue;
    seen.add(task.id);
    if (task.inFlight === true || (task.state !== "queued" && task.state !== "scheduled")) continue;
    const index = order.indexOf(task.id);
    const wait = { taskId: task.id, place: index < 0 ? null : index + 1, reasons: [...standing] };
    waits.push(wait);
    if (index < 0) {
      wait.reasons.push(because(task.state === "scheduled" ? "own_schedule" : "unknown"));
      continue;
    }
    if (starts.has(task.id)) {
      wait.candidate = true;
      continue;
    }
    const tasksAhead = order.slice(0, index).filter((id) => !together(task.id, id));
    const running = flying.filter((id) => !together(task.id, id));
    const found = [];
    if (tasksAhead.length > 0) found.push(because("earlier_tasks", tasksAhead));
    if (running.length > 0) found.push(because("running_work", running));
    wait.reasons.push(...(found.length > 0 ? found : [because("unknown")]));
  }
  return waits.sort((a, b) => Number(a.taskId.slice(2)) - Number(b.taskId.slice(2)));
}
