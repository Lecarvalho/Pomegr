import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks">;

export type FeatureInput = { featureId?: string | null; step?: number | null };

export type FeatureDraft = { featureId: string | null; creating: boolean; name: string; step: number | null };

export const NO_FEATURE_DRAFT: FeatureDraft = { featureId: null, creating: false, name: "", step: null };

const NONE = "none";
const NEW = "new";
const LAST = "last";

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

export function stepSelectValue(draft: FeatureDraft): string {
  if (draft.creating) return LAST;
  if (draft.featureId === null) return NONE;
  return draft.step === null ? LAST : `step:${draft.step}`;
}

export function stepFromSelect(value: string, current: FeatureDraft): FeatureDraft {
  return { ...current, step: value.startsWith("step:") ? Number(value.slice("step:".length)) : null };
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

function idList(ids: readonly string[]) {
  return ids.length > 3 ? `${ids.slice(0, 3).join(", ")} +${ids.length - 3}` : ids.join(", ");
}

export function stepSelectOptions(tasks: readonly Task[], draft: FeatureDraft, selfId?: string): { options: CommandSelectOption[]; disabled: boolean } {
  if (draft.creating) return { options: [{ value: LAST, label: "Last · new step 1" }], disabled: true };
  if (draft.featureId === null) return { options: [{ value: NONE, label: "None" }], disabled: true };
  const steps = stepsOf(tasks, draft.featureId);
  const highest = Math.max(0, ...steps.keys());
  const options: CommandSelectOption[] = [{ value: LAST, label: `Last · new step ${highest + 1}` }];
  for (let step = highest; step >= 1; step -= 1) {
    const others = (steps.get(step) ?? []).filter((task) => task.id !== selfId).sort(byIdNumber).map((task) => task.id);
    options.push({ value: `step:${step}`, label: others.length > 0 ? `Step ${step} · parallel with ${idList(others)}` : `Step ${step}` });
  }
  return { options, disabled: false };
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

export function featureLines(board: Pick<BoardShape, "features" | "tasks">): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  for (const feature of board.features) {
    const steps = stepsOf(board.tasks, feature.id);
    const last = Math.max(0, ...steps.keys());
    for (const [step, tasks] of steps) {
      for (const task of tasks) lines.set(task.id, `${feature.name} · step ${step} of ${last}${tasks.length > 1 ? " · parallel" : ""}`);
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
