import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks">;

export type FeatureInput = { featureId?: string | null; step?: number | null };

export type FeatureDraft = { featureId: string | null; creating: boolean; name: string; step: number | null };

export const NO_FEATURE_DRAFT: FeatureDraft = { featureId: null, creating: false, name: "", step: null };

const NONE = "none";
const NEW = "new";

export function featureDraftFromTask(task: Pick<Task, "featureId" | "step">): FeatureDraft {
  return { featureId: task.featureId, creating: false, name: "", step: task.featureId === null ? null : task.step };
}

export function featureSelectValue(draft: FeatureDraft): string {
  return draft.creating ? NEW : draft.featureId === null ? NONE : `feature:${draft.featureId}`;
}

export function featureDraftFromSelect(value: string, current: FeatureDraft): FeatureDraft {
  if (value === NEW) return { featureId: null, creating: true, name: current.creating ? current.name : "", step: null };
  if (value.startsWith("feature:")) return { featureId: value.slice("feature:".length), creating: false, name: "", step: null };
  return NO_FEATURE_DRAFT;
}

export function featureSelectOptions(features: readonly TaskFeature[], currentFeatureId: string | null): CommandSelectOption[] {
  return [
    ...features.filter((feature) => !feature.done || feature.id === currentFeatureId).map((feature) => ({ value: `feature:${feature.id}`, label: feature.name })),
    { value: NONE, label: "No feature" },
    { value: NEW, label: "New feature…" },
  ];
}

function idNumber(id: string) {
  return Number(id.slice(2));
}

const byIdNumber = (left: Task, right: Task) => idNumber(left.id) - idNumber(right.id);

function stepsOf(tasks: readonly Task[], featureId: string) {
  const steps = new Map<number, Task[]>();
  for (const task of tasks) {
    if (task.featureId !== featureId || task.step === null) continue;
    steps.set(task.step, [...(steps.get(task.step) ?? []), task]);
  }
  return steps;
}

export function highestStep(tasks: readonly Task[], featureId: string): number {
  return Math.max(0, ...stepsOf(tasks, featureId).keys());
}

export function featureCreateInput(draft: FeatureDraft, createdId: string | null): FeatureInput | undefined {
  const featureId = draft.creating ? createdId : draft.featureId;
  if (featureId === null) return undefined;
  return { featureId, ...(!draft.creating && draft.step !== null && { step: draft.step }) };
}

export function featureUpdateInput(draft: FeatureDraft, createdId: string | null = null): FeatureInput {
  return featureCreateInput(draft, createdId) ?? { featureId: null };
}

function boardOrder(columns: BoardShape["columns"]) {
  const index = new Map([...columns].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)).map((column, at) => [column.id, at]));
  return (left: Task, right: Task) => (index.get(left.columnId) ?? Infinity) - (index.get(right.columnId) ?? Infinity) || left.position - right.position || byIdNumber(left, right);
}

export function featureTasks(board: Pick<BoardShape, "tasks">, featureId: string): Task[] {
  return board.tasks.filter((task) => task.featureId === featureId);
}

export function featureCounts(board: Pick<BoardShape, "tasks">, featureId: string) {
  const tasks = featureTasks(board, featureId);
  return { total: tasks.length, done: tasks.filter((task) => task.state === "done").length };
}

export function featureSiblings(board: BoardShape, featureId: string, selfId?: string): Task[] {
  const order = boardOrder(board.columns);
  return featureTasks(board, featureId).filter((task) => task.id !== selfId)
    .sort((left, right) => (left.step ?? Infinity) - (right.step ?? Infinity) || order(left, right));
}

/** A card's feature line: "<feature> · step k of n", and the other tasks of its step, in any lane, when it has any. */
export type FeatureLine = { text: string; parallelWith: string[] };

export function featureLines(board: Pick<BoardShape, "features" | "tasks">): ReadonlyMap<string, FeatureLine> {
  const lines = new Map<string, FeatureLine>();
  for (const feature of board.features) {
    const steps = stepsOf(board.tasks, feature.id);
    const last = Math.max(0, ...steps.keys());
    for (const [step, tasks] of steps) {
      const ids = [...tasks].sort(byIdNumber).map((task) => task.id);
      for (const task of tasks) lines.set(task.id, { text: `${feature.name} · step ${step} of ${last}`, parallelWith: ids.filter((id) => id !== task.id) });
    }
  }
  return lines;
}

export type FeatureFilterValue = string;
export const ALL_FEATURES = "all";
export const WITHOUT_FEATURE = "none";

export function matchesFeatureFilter(task: Task, filter: FeatureFilterValue) {
  return filter === ALL_FEATURES || (filter === WITHOUT_FEATURE ? task.featureId === null : task.featureId === filter);
}

export function effectiveFeatureFilter(board: Pick<BoardShape, "features">, filter: FeatureFilterValue): FeatureFilterValue {
  return filter === ALL_FEATURES || filter === WITHOUT_FEATURE || board.features.some((feature) => feature.id === filter) ? filter : ALL_FEATURES;
}
