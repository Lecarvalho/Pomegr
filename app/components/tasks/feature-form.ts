import { TASK_BOUNDS, type Task, type TaskActionError } from "../../../shared/task-contract";
import type { FeatureDetails, FeaturePatch } from "./task-desktop";
import { taskStarted } from "./task-presentation";

// The Feature modal's draft, its bounds, and its fixed words.

export type FeatureFormDraft = { name: string; description: string; appVersion: string };

export const EMPTY_FEATURE_DRAFT: FeatureFormDraft = { name: "", description: "", appVersion: "" };

export const FEATURE_DUPLICATE_MESSAGE = "Another feature already has this title.";
export const FEATURE_SAVE_FAILURE_MESSAGE = "The feature could not be saved.";
export const FEATURE_LIMIT_MESSAGE = `This board already holds ${TASK_BOUNDS.featuresPerRepository} features. Delete one first.`;
export const FEATURE_READ_FAILURE_MESSAGE = "The description and app version could not be read.";

/** Which fixed line a failed create, update or delete shows (a failed delete is the "delete" line, whatever the error): the duplicate title sits under the Title field, the others under the fields. */
export type FeatureFailure = "duplicate" | "limit" | "failed" | "delete";

export function featureFailure(error: TaskActionError | "unavailable"): FeatureFailure {
  return error === "conflict" ? "duplicate" : error === "limit" ? "limit" : "failed";
}

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export const featureCount = (length: number, bound: number) => `${COUNT_FORMAT.format(length)} / ${COUNT_FORMAT.format(bound)}`;

export const featureDescriptionOver = (draft: FeatureFormDraft) => draft.description.length > TASK_BOUNDS.featureDescriptionLength;

/** A stored detail is nothing or text; a draft one is its trimmed text, and blank is nothing. */
const detail = (value: string) => value.trim();

/** What an edit changed in the title, the description and the app version. Empty when the draft equals the stored feature. */
export function featurePatch(stored: FeatureFormDraft, draft: FeatureFormDraft, details: FeatureDetails | null): FeaturePatch {
  const patch: FeaturePatch = {};
  if (draft.name.trim() !== stored.name) patch.name = draft.name.trim();
  // Until the read answers the two fields are disabled, so nothing in them can differ.
  if (details !== null) {
    if (detail(draft.description) !== (details.description ?? "")) patch.description = detail(draft.description) === "" ? null : detail(draft.description);
    if (detail(draft.appVersion) !== (details.appVersion ?? "")) patch.appVersion = detail(draft.appVersion) === "" ? null : detail(draft.appVersion);
  }
  return patch;
}

/** What a create sends beyond the title: only a detail that holds text. */
export function featureCreateDetails(draft: FeatureFormDraft): { description?: string; appVersion?: string } {
  return { ...(detail(draft.description) !== "" && { description: detail(draft.description) }), ...(detail(draft.appVersion) !== "" && { appVersion: detail(draft.appVersion) }) };
}

export const FEATURE_DELETE_FAILURE_MESSAGE = "The feature could not be deleted.";

/** The confirmation line of Delete feature: what happens to the feature's tasks, every one of them, done ones included. */
export function featureDeleteLine(taskCount: number): string {
  if (taskCount === 0) return "Delete this feature? This cannot be undone.";
  const tasks = taskCount === 1 ? "Its 1 task stays" : `Its ${taskCount} tasks stay`;
  return `Delete this feature? ${tasks} on the board with no feature. This cannot be undone.`;
}

/** The task that blocks Delete feature, named by the line that disables it. */
export function featureRunningLine(taskId: string): string {
  return `${taskId} is running. Delete the feature after its tasks finish.`;
}

/** The first task of the feature, by ID, that has started and is not done: the monitor refuses the delete while one exists. */
export function featureBlocker(tasks: readonly Task[], featureId: string): Task | null {
  const number = (task: Task) => Number(task.id.slice(2));
  return tasks.filter((task) => task.featureId === featureId && task.state !== "done" && taskStarted(task)).toSorted((a, b) => number(a) - number(b))[0] ?? null;
}
