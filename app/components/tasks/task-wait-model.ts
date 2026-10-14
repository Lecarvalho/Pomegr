import { TASK_GATE_REASONS, type Task, type TaskBoard, type TaskGateReason, type TaskQueueWait } from "../../../shared/task-contract";
import { reasonText, waitingLine } from "./task-gates-model";

// Why a waiting task has not started, in words. The monitor judges the order and the reasons (`queue.waits`); this
// module only words them and never orders a task itself.

type WaitQueue = Pick<TaskBoard["queue"], "gates" | "schedule" | "waits">;
type WaitReason = TaskQueueWait["reasons"][number];
type WaitTask = Pick<Task, "id" | "run">;

const GATE_REASONS = new Set<string>(TASK_GATE_REASONS);
/** A card names at most this many tasks for one reason; the task modal names every task the monitor sent. */
const CARD_TASKS = 3;

export function taskWait(queue: Pick<WaitQueue, "waits"> | undefined, taskId: string): TaskQueueWait | null {
  return queue?.waits?.find((wait) => wait.taskId === taskId) ?? null;
}

export function ordinal(value: number): string {
  const tens = value % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : value % 10 === 1 ? "st" : value % 10 === 2 ? "nd" : value % 10 === 3 ? "rd" : "th";
  return `${value}${suffix}`;
}

function taskList(entry: WaitReason, shown: number): string {
  const ids = entry.taskIds.slice(0, shown);
  const rest = entry.more + entry.taskIds.length - ids.length;
  return rest > 0 ? `${ids.join(", ")} and ${rest} more` : ids.join(", ");
}

const gateText = (entry: WaitReason, task: WaitTask, queue: WaitQueue) =>
  reasonText(entry.reason as TaskGateReason, queue.gates, { provider: task.run.provider ?? "claude", blockedBy: entry.taskIds[0] ?? null }, queue.schedule);

const runs = (entry: WaitReason) => (entry.taskIds.length + entry.more === 1 ? "is" : "are");

/** One reason as a clause of the card's Waiting line. */
function clause(entry: WaitReason, task: WaitTask, queue: WaitQueue): string {
  const tasks = taskList(entry, CARD_TASKS);
  switch (entry.reason) {
    case "queue_off": return "the queue is off";
    case "queue_blocked": return tasks ? `the queue is blocked by ${tasks}` : "the queue is blocked";
    case "queue_paused": return tasks ? `the queue is paused at ${tasks}` : "the queue is paused";
    case "own_schedule": return "its start time has not come";
    case "earlier_tasks": return `earlier tasks start first (${tasks})`;
    case "running_work": return `${tasks} ${runs(entry)} running`;
    case "unknown": return "the reason is not known yet";
    default: return GATE_REASONS.has(entry.reason) ? gateText(entry, task, queue) : "the reason is not known yet";
  }
}

/** The line of a waiting card in Ready: its place in the start order, then why it waits. The Starts line already says a task's own time. */
export function waitCardLine(queue: TaskBoard["queue"], task: WaitTask): string | null {
  const wait = taskWait(queue, task.id);
  // A monitor that sends no waits still names the gates that hold the next task.
  if (!wait) return queue.waits ? null : waitingLine(queue, task.id);
  const clauses = wait.reasons.filter((entry) => entry.reason !== "own_schedule").map((entry) => clause(entry, task, queue));
  const parts = [wait.place !== null && wait.place > 1 ? `${ordinal(wait.place)} in queue` : null, clauses.length > 0 ? `Waiting: ${clauses.join("; ")}` : null];
  return parts.filter((part) => part !== null).join(" · ") || null;
}

/** One reason as a sentence of the task modal's Queue block. */
function sentence(entry: WaitReason, task: WaitTask, queue: WaitQueue): string {
  const tasks = taskList(entry, entry.taskIds.length);
  switch (entry.reason) {
    case "queue_off": return "The queue is off, so Pomegr starts no task by itself.";
    case "queue_blocked": return tasks ? `The queue is blocked by ${tasks}. Nothing starts until that task is resolved.` : "The queue is blocked.";
    case "queue_paused": return tasks ? `The queue is paused at ${tasks}. Select On to retry.` : "The queue is paused.";
    case "own_schedule": return "Its own start time has not come.";
    case "earlier_task": return tasks ? `${tasks} has not finished.` : "An earlier task has not finished.";
    case "earlier_tasks": return `These are above it in Ready and start first: ${tasks}.`;
    case "running_work": return `${tasks} ${runs(entry)} running. The next card starts when that work is in Review or Done.`;
    case "before_queue_start": case "after_queue_stop": return `Schedule: ${gateText(entry, task, queue)}.`;
    case "unknown": return "The reason is not known yet.";
    default: return GATE_REASONS.has(entry.reason) ? `Start gate: ${gateText(entry, task, queue)}.` : "The reason is not known yet.";
  }
}

export type WaitDetail = { place: string; lines: string[] };

export const NO_KNOWN_HOLD = "Nothing known holds it. The queue starts it at its next check.";

/** The Queue block of the task modal, or null for a task that does not wait in the queue. */
export function waitDetail(queue: WaitQueue | undefined, task: WaitTask): WaitDetail | null {
  const wait = queue ? taskWait(queue, task.id) : null;
  if (!queue || !wait) return null;
  const place = wait.place === null ? "Not in the start order yet" : wait.place === 1 ? "Next to start" : `${ordinal(wait.place)} to start`;
  return { place, lines: wait.reasons.length > 0 ? wait.reasons.map((entry) => sentence(entry, task, queue)) : [NO_KNOWN_HOLD] };
}
