import { TASK_BOUNDS, type TaskBoard, type TaskRun } from "../../../shared/task-contract";
import type { TaskFieldsInput } from "./task-desktop";
import { isRunSet, toCompleteWhen, type CompleteWhenDraft } from "./task-fields";
import { featureCreateInput, type FeatureDraft } from "./task-features";
import type { TaskIssue, TaskIssueError } from "./task-issues-desktop";

export type TaskModalBoard = Pick<TaskBoard, "columns" | "features" | "tasks"> & {
  runModels?: NonNullable<TaskBoard["runModels"]>;
  queue?: Pick<TaskBoard["queue"], "order" | "gates" | "schedule" | "waits"> & Partial<Pick<TaskBoard["queue"], "status" | "blockedBy">>;
};

export function firstColumnName(columns: TaskBoard["columns"]): string | null {
  const first = [...columns].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))[0];
  return first?.name ?? null;
}

export function modalSubtitle(repositoryName: string | null, columnName: string | null): string | null {
  const parts = [repositoryName, columnName ? `in ${columnName}` : null].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

export type PromoteOutcome =
  | { kind: "conflict" | "limit" | "not_found" | "failed"; digest: string }
  | { kind: "unsaved"; taskId: string };

export function promoteOutcome(error: TaskIssueError, digest: string): PromoteOutcome {
  return { kind: error === "conflict" || error === "limit" || error === "not_found" ? error : "failed", digest };
}

export function shownOutcome(outcome: PromoteOutcome | null, issue: Pick<TaskIssue, "digest" | "taskId">): PromoteOutcome | null {
  if (outcome === null || outcome.kind === "unsaved") return outcome;
  if (outcome.digest !== issue.digest) return null;
  return outcome.kind === "conflict" && issue.taskId !== null ? null : outcome;
}

export const retryablePromote = (outcome: PromoteOutcome | null) => outcome === null || outcome.kind === "failed";

export const PROMOTE_MESSAGES = {
  conflict: "This issue changed on GitHub or was already promoted.",
  limit: `The task text would be longer than the ${new Intl.NumberFormat("en-US").format(TASK_BOUNDS.textLength)} characters a task holds. Shorten the issue, or write the task by hand.`,
  not_found: "This issue is no longer open.",
  failed: "The issue could not be promoted.",
} as const;

export const promoteUnsavedMessage = (taskId: string) => `The issue was promoted to ${taskId}, but the run settings could not be saved. Open the task to set them.`;

export function promotePatch(run: TaskRun, completeWhen: CompleteWhenDraft, feature: FeatureDraft): TaskFieldsInput | null {
  const patch: TaskFieldsInput = {};
  if (isRunSet(run)) patch.run = run;
  const done = toCompleteWhen(completeWhen);
  if (done.checks.length > 0 || done.own !== null) patch.completeWhen = done;
  Object.assign(patch, featureCreateInput(feature, null));
  return Object.keys(patch).length === 0 ? null : patch;
}
