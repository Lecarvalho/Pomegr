import type { CommandSelectOption } from "../command-center/CommandSelect";
import type { Task, TaskBoard, TaskFeature } from "../../../shared/task-contract";

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks">;

export type FeatureInput = { featureId?: string | null };

export type FeatureDraft = { featureId: string | null; creating: boolean; name: string };

export const NO_FEATURE_DRAFT: FeatureDraft = { featureId: null, creating: false, name: "" };

const NONE = "none";
const NEW = "new";

export function featureDraftFromTask(task: Pick<Task, "featureId">): FeatureDraft {
  return { featureId: task.featureId, creating: false, name: "" };
}

export function featureSelectValue(draft: FeatureDraft): string {
  return draft.creating ? NEW : draft.featureId === null ? NONE : `feature:${draft.featureId}`;
}

export function featureDraftFromSelect(value: string, current: FeatureDraft): FeatureDraft {
  if (value === NEW) return { featureId: null, creating: true, name: current.creating ? current.name : "" };
  if (value.startsWith("feature:")) return { featureId: value.slice("feature:".length), creating: false, name: "" };
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

export function featureCreateInput(draft: FeatureDraft, createdId: string | null): FeatureInput | undefined {
  const featureId = draft.creating ? createdId : draft.featureId;
  return featureId === null ? undefined : { featureId };
}

export function featureUpdateInput(draft: FeatureDraft, createdId: string | null = null): FeatureInput {
  return featureCreateInput(draft, createdId) ?? { featureId: null };
}

// A feature's tasks run in the order of their cards: the column furthest along first (Done back to Backlog), top to
// bottom inside a column. No task holds a step number; its step is its place in this order.
function runOrder(columns: BoardShape["columns"]) {
  const index = new Map([...columns].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id)).map((column, at) => [column.id, at]));
  return (left: Task, right: Task) => (index.get(right.columnId) ?? -1) - (index.get(left.columnId) ?? -1) || left.position - right.position || byIdNumber(left, right);
}

export function featureTasks(board: Pick<BoardShape, "tasks">, featureId: string): Task[] {
  return board.tasks.filter((task) => task.featureId === featureId);
}

export function featureCounts(board: Pick<BoardShape, "tasks">, featureId: string) {
  const tasks = featureTasks(board, featureId);
  return { total: tasks.length, done: tasks.filter((task) => task.state === "done").length };
}

/** The feature's tasks in the order they run, one step each. */
export function featureSteps(board: Pick<BoardShape, "columns" | "tasks">, featureId: string): Task[] {
  return featureTasks(board, featureId).sort(runOrder(board.columns));
}

export function featureLines(board: BoardShape): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  for (const feature of board.features) {
    const steps = featureSteps(board, feature.id);
    steps.forEach((task, index) => lines.set(task.id, `${feature.name} · step ${index + 1} of ${steps.length}`));
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
