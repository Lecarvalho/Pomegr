import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";
import { placementOf, readyColumnId, waitsInQueue } from "./task-board-model";
import type { TaskMove } from "./task-desktop";
import { featureSteps } from "./task-features";

/** One step is one task: a feature's tasks run one at a time, in the order of their cards. */
export type QueueStep = { step: number; task: Task };
export type QueueFeature = { feature: TaskFeature; steps: QueueStep[]; total: number; done: number };

function idNumber(id: string) {
  return Number(id.slice(2));
}

const byTaskNumber = (left: Task, right: Task) => idNumber(left.id) - idNumber(right.id);

export function queueFeatures(board: Pick<TaskBoard, "columns" | "features" | "tasks">): QueueFeature[] {
  const panels: QueueFeature[] = [];
  for (const feature of board.features) {
    if (feature.done) continue;
    const own = featureSteps(board, feature.id);
    if (own.length === 0) continue;
    panels.push({ feature, steps: own.map((task, index) => ({ step: index + 1, task })), total: own.length, done: own.filter((task) => task.state === "done").length });
  }
  return panels;
}

export function singleQueueTasks(board: Pick<TaskBoard, "tasks" | "queue">): Task[] {
  const order = new Map(board.queue.order.map((id, index) => [id, index]));
  const listed = board.tasks.filter((task) => task.featureId === null && task.state !== "not_queued" && task.state !== "done");
  // A started task keeps its queued state but is not in the order.
  const waits = (task: Task) => (task.state === "queued" || task.state === "scheduled") && order.has(task.id);
  const queued = listed.filter(waits).sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity) || byTaskNumber(left, right));
  return [...queued, ...listed.filter((task) => !waits(task)).sort(byTaskNumber)];
}

/** A feature task that waits in the queue: its card is in Ready, and its place there is its step. */
export function isMovableQueueTask(task: Task) {
  return waitsInQueue(task) && task.featureId !== null;
}

/** The card move that gives `task` the step of `target`, or null when nothing should be sent. */
export function reorderMove(board: Pick<TaskBoard, "columns" | "tasks">, task: Task, target: Task): TaskMove | null {
  const readyId = readyColumnId(board);
  if (readyId === null || task.id === target.id || task.featureId !== target.featureId || !isMovableQueueTask(task) || !isMovableQueueTask(target)) return null;
  const place = placementOf(board, target.id);
  if (place?.columnId !== readyId || placementOf(board, task.id)?.columnId !== readyId) return null;
  return { id: task.id, columnId: readyId, position: place.index };
}

export function moveChoices(board: Pick<TaskBoard, "columns" | "tasks">, panel: QueueFeature, task: Task): { step: number; label: string }[] {
  return panel.steps.filter((candidate) => reorderMove(board, task, candidate.task) !== null).map((candidate) => ({ step: candidate.step, label: `Step ${candidate.step}` }));
}
