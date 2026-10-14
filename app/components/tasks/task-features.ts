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
  if (featureId === null) return undefined;
  return { featureId };
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

/** The filter row's line for a selected feature. A task is running while it has a session and no outcome. */
export type FeatureProgress = { total: number; done: number; running: number };

export function featureProgress(board: Pick<BoardShape, "features" | "tasks">, featureId: string): FeatureProgress | null {
  if (!board.features.some((feature) => feature.id === featureId)) return null;
  const running = featureTasks(board, featureId).filter((task) => task.session !== null && (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled")).length;
  return { ...featureCounts(board, featureId), running };
}

export function featureSiblings(board: BoardShape, featureId: string, selfId?: string): Task[] {
  const order = boardOrder(board.columns);
  return featureTasks(board, featureId).filter((task) => task.id !== selfId).sort(order);
}

/** A card's feature line: the name of its feature. A feature gives a task context only, so the line holds nothing else. */
export function featureLines(board: Pick<BoardShape, "features" | "tasks">): ReadonlyMap<string, string> {
  const names = new Map(board.features.map((feature) => [feature.id, feature.name]));
  const lines = new Map<string, string>();
  for (const task of board.tasks) {
    const name = task.featureId === null ? undefined : names.get(task.featureId);
    if (name !== undefined) lines.set(task.id, name);
  }
  return lines;
}

const FEATURE_ID_PATTERN = /^feat-[0-9a-f]{12}$/u;

/** The `feature` parameter of the Tasks route: an opaque feature ID, or nothing. */
export function featureRouteId(value: unknown) {
  return typeof value === "string" && FEATURE_ID_PATTERN.test(value) ? value : undefined;
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
