import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";

// Pure grouping for the Queue view (design contract D117-D155, D446-D449). The monitor owns the start order
// (`queue.order`); this module only groups the committed tasks into feature panels and steps and answers which steps
// accept a dragged task. Steps are drawn with the number the monitor stored, which it keeps dense.

export type QueueStep = { step: number; tasks: Task[]; allDone: boolean };
export type QueueFeature = { feature: TaskFeature; steps: QueueStep[]; total: number; done: number; highest: number };

function idNumber(id: string) {
  return Number(id.slice(2));
}

const byTaskNumber = (left: Task, right: Task) => idNumber(left.id) - idNumber(right.id);

/** Feature panels: every feature that is not done and holds at least one task, in board order. */
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

/**
 * Tasks outside any feature that are in the queue's hands: those waiting to start now first, in start order (queued
 * ones, and a scheduled one whose time has come), then every other state except Not queued and Done by task number.
 */
export function singleQueueTasks(board: Pick<TaskBoard, "tasks" | "queue">): Task[] {
  const order = new Map(board.queue.order.map((id, index) => [id, index]));
  const listed = board.tasks.filter((task) => task.featureId === null && task.state !== "not_queued" && task.state !== "done");
  const waits = (task: Task) => task.state === "queued" || (task.state === "scheduled" && order.has(task.id));
  const queued = listed.filter(waits).sort((left, right) => (order.get(left.id) ?? Infinity) - (order.get(right.id) ?? Infinity) || byTaskNumber(left, right));
  return [...queued, ...listed.filter((task) => !waits(task)).sort(byTaskNumber)];
}

/** Only a queued task of a feature can be moved between steps. */
export function isMovableQueueTask(task: Task) {
  return task.state === "queued" && task.featureId !== null && task.step !== null;
}

/**
 * The step a drop would send, or null when nothing should be sent: the step refuses (all done), or the task is
 * already there. `null` for `step` is the new-step zone, which sends the highest step + 1 unless the task already
 * is alone in the last step.
 */
export function reorderTarget(panel: QueueFeature, task: Task, step: number | null): number | null {
  if (!isMovableQueueTask(task) || task.featureId !== panel.feature.id) return null;
  if (step === null) {
    const last = panel.steps.at(-1);
    return last && last.step === task.step && last.tasks.length === 1 ? null : panel.highest + 1;
  }
  const target = panel.steps.find((candidate) => candidate.step === step);
  return !target || target.allDone || task.step === step ? null : step;
}

/** The keyboard alternative's choices: every step that accepts the task, in order, then a new last step. */
export function moveChoices(panel: QueueFeature, task: Task): { step: number; label: string }[] {
  const choices = panel.steps.filter((candidate) => reorderTarget(panel, task, candidate.step) !== null).map((candidate) => ({ step: candidate.step, label: `Step ${candidate.step}` }));
  const fresh = reorderTarget(panel, task, null);
  return fresh === null ? choices : [...choices, { step: fresh, label: "New last step" }];
}

export function stepModeLabel(step: QueueStep) {
  return step.tasks.length > 1 ? `Parallel · ${step.tasks.length}` : "One task";
}
