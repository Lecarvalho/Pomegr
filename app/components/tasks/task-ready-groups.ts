import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";
import { waitsInQueue } from "./task-board-model";

// The Ready lane's step groups: a projection of the lane's card order and each task's feature and step. It never
// reorders a card and reads no stored value of its own.

/** The waiting cards of one feature step that sit next to each other in Ready. `size` counts the step's tasks in any lane. */
export type ReadyStepGroup = { kind: "step"; key: string; feature: TaskFeature; step: number; last: number; size: number; tasks: Task[] };
/** The waiting cards without a feature step that sit next to each other in Ready. */
export type ReadySingleGroup = { kind: "single"; key: string; tasks: Task[] };
/** A card that does not wait in the queue: it is drawn as a plain board card where it is. */
export type ReadyCard = { kind: "card"; key: string; task: Task };
export type ReadySegment = ReadyStepGroup | ReadySingleGroup | ReadyCard;

export function readySegments(cards: readonly Task[], board: Pick<TaskBoard, "features" | "tasks">): ReadySegment[] {
  const features = new Map(board.features.map((feature) => [feature.id, feature]));
  const sizes = new Map<string, number>();
  const stepKey = (featureId: string, step: number) => `${featureId}:${step}`;
  const lastStep = new Map<string, number>();
  for (const task of board.tasks) {
    if (task.featureId === null || task.step === null) continue;
    const key = stepKey(task.featureId, task.step);
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
    lastStep.set(task.featureId, Math.max(lastStep.get(task.featureId) ?? 0, task.step));
  }
  const segments: ReadySegment[] = [];
  for (const task of cards) {
    if (!waitsInQueue(task)) { segments.push({ kind: "card", key: task.id, task }); continue; }
    const feature = task.featureId === null || task.step === null ? undefined : features.get(task.featureId);
    const open = segments.at(-1);
    if (!feature || task.step === null) {
      if (open?.kind === "single") open.tasks.push(task);
      else segments.push({ kind: "single", key: `single:${task.id}`, tasks: [task] });
      continue;
    }
    if (open?.kind === "step" && open.feature.id === feature.id && open.step === task.step) { open.tasks.push(task); continue; }
    segments.push({ kind: "step", key: `${stepKey(feature.id, task.step)}:${task.id}`, feature, step: task.step, last: lastStep.get(feature.id) ?? task.step,
      size: sizes.get(stepKey(feature.id, task.step)) ?? 1, tasks: [task] });
  }
  return segments;
}

/** A frame is drawn around two or more waiting cards of one step. */
export function isFramed(segment: ReadySegment) {
  return segment.kind === "step" && segment.tasks.length > 1;
}
