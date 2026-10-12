import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";
import { waitsInQueue } from "./task-board-model";

export type QueueStep = { step: number; tasks: Task[]; allDone: boolean };
export type QueueFeature = { feature: TaskFeature; steps: QueueStep[]; total: number; done: number; highest: number };

function idNumber(id: string) {
  return Number(id.slice(2));
}

const byTaskNumber = (left: Task, right: Task) => idNumber(left.id) - idNumber(right.id);

export function queueFeatures(board: Pick<TaskBoard, "features" | "tasks">): QueueFeature[] {
  const panels: QueueFeature[] = [];
  for (const feature of board.features) {
    if (feature.done) continue;
    const own = board.tasks.filter((task) => task.featureId === feature.id);
    if (own.length === 0) continue;
    const byStep = new Map<number, Task[]>();
    for (const task of own) {
      if (task.step === null) continue;
      byStep.set(task.step, [...(byStep.get(task.step) ?? []), task]);
    }
    const steps = [...byStep.entries()].sort((left, right) => left[0] - right[0])
      .map(([step, tasks]) => ({ step, tasks: tasks.sort(byTaskNumber), allDone: tasks.every((task) => task.state === "done") }));
    panels.push({ feature, steps, total: own.length, done: own.filter((task) => task.state === "done").length, highest: steps.at(-1)?.step ?? 0 });
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

export function isMovableQueueTask(task: Task) {
  return (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled") && task.session === null && task.featureId !== null && task.step !== null;
}

/** The step a drop would send, or null when nothing should be sent. */
export function reorderTarget(panel: QueueFeature, task: Task, step: number | null): number | null {
  if (!isMovableQueueTask(task) || task.featureId !== panel.feature.id) return null;
  if (step === null) {
    const last = panel.steps.at(-1);
    return last && last.step === task.step && last.tasks.length === 1 ? null : panel.highest + 1;
  }
  const target = panel.steps.find((candidate) => candidate.step === step);
  return !target || target.allDone || task.step === step ? null : step;
}

export function moveChoices(panel: QueueFeature, task: Task): { step: number; label: string }[] {
  const choices = panel.steps.filter((candidate) => reorderTarget(panel, task, candidate.step) !== null).map((candidate) => ({ step: candidate.step, label: `Step ${candidate.step}` }));
  const fresh = reorderTarget(panel, task, null);
  return fresh === null ? choices : [...choices, { step: fresh, label: "New last step" }];
}

/** A card the Board gives a step: a waiting card of a feature. The Board uses the Queue view's own rule, `reorderTarget`. */
export function isBoardStepTask(task: Task) {
  return waitsInQueue(task) && isMovableQueueTask(task);
}

export type BoardStepChoice = { step: number; label: string; disabled?: boolean };

/** The Board's "Move to step…" options: each unfinished step but the task's own, then the new last step. A step that started is listed and cannot be chosen. */
export function boardStepChoices(panel: QueueFeature, task: Task): BoardStepChoice[] {
  const choices: BoardStepChoice[] = [];
  for (const candidate of panel.steps) {
    if (reorderTarget(panel, task, candidate.step) === null) continue;
    const running = candidate.tasks.some((other) => other.state !== "done" && other.session !== null);
    choices.push(running ? { step: candidate.step, label: `Step ${candidate.step} · running`, disabled: true }
      : { step: candidate.step, label: `Step ${candidate.step} · parallel with ${candidate.tasks.map((other) => other.id).join(", ")}` });
  }
  const fresh = reorderTarget(panel, task, null);
  return fresh === null ? choices : [...choices, { step: fresh, label: "New last step" }];
}

/** The text of the Board's new-step zone, in the step numbers drawn now. */
export function newStepLabel(panel: QueueFeature) {
  return `New step ${panel.highest + 1} · after step ${panel.highest}`;
}

export function stepModeLabel(step: QueueStep) {
  return step.tasks.length > 1 ? `Parallel · ${step.tasks.length}` : "One task";
}
