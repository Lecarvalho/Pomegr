import { TASK_BOUNDS, type TaskBoard, type TaskRun } from "../../../shared/task-contract";
import type { TaskFieldsInput } from "./task-desktop";
import { isRunSet, toDoneWhen, type DoneWhenDraft } from "./task-fields";
import { featureCreateInput, type FeatureDraft } from "./task-features";
import type { TaskIssue, TaskIssueError } from "./task-issues-desktop";

/** What both modal forms read from the committed board: its columns, features and tasks, the Codex model catalog and the queue order. */
export type TaskModalBoard = Pick<TaskBoard, "columns" | "features" | "tasks"> & {
  runModels?: NonNullable<TaskBoard["runModels"]>;
  queue?: Pick<TaskBoard["queue"], "order">;
};

/** The column's name by position: the first column is where a new task lands. */
export function firstColumnName(columns: TaskBoard["columns"]): string | null {
  const first = [...columns].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))[0];
  return first?.name ?? null;
}

/** `{repository} · in {column}`; either part is dropped when it is unknown, and an empty result is null. */
export function modalSubtitle(repositoryName: string | null, columnName: string | null): string | null {
  const parts = [repositoryName, columnName ? `in ${columnName}` : null].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

// Mode issue (the Promote form): what a promote can answer, the fixed words for it, and the one update that follows.

/**
 * What the last promote attempt left. A failure belongs to the version of the issue it was answered for (`digest`), so
 * a new version clears it; `unsaved` belongs to the task that was made and stays.
 */
export type PromoteOutcome =
  | { kind: "conflict" | "limit" | "not_found" | "failed"; digest: string }
  | { kind: "unsaved"; taskId: string };

export function promoteOutcome(error: TaskIssueError, digest: string): PromoteOutcome {
  return { kind: error === "conflict" || error === "limit" || error === "not_found" ? error : "failed", digest };
}

/** The outcome that still holds for the issue as shown: a conflict is also cleared once the issue is known to be a task. */
export function shownOutcome(outcome: PromoteOutcome | null, issue: Pick<TaskIssue, "digest" | "taskId">): PromoteOutcome | null {
  if (outcome === null || outcome.kind === "unsaved") return outcome;
  if (outcome.digest !== issue.digest) return null;
  return outcome.kind === "conflict" && issue.taskId !== null ? null : outcome;
}

/** A failed promote the same click may try again; every other outcome needs a new version, or an end. */
export const retryablePromote = (outcome: PromoteOutcome | null) => outcome === null || outcome.kind === "failed";

export const PROMOTE_MESSAGES = {
  conflict: "This issue changed on GitHub or was already promoted.",
  limit: `The task text would be longer than the ${new Intl.NumberFormat("en-US").format(TASK_BOUNDS.textLength)} characters a task holds. Shorten the issue, or write the task by hand.`,
  not_found: "This issue is no longer open.",
  failed: "The issue could not be promoted.",
} as const;

export const promoteUnsavedMessage = (taskId: string) => `The issue was promoted to ${taskId}, but the run settings could not be saved. Open the task to set them.`;

/**
 * The one update after a promote, holding only what differs from the task the monitor made: no feature, nothing planned
 * to run, and no done-when condition. Null when nothing was chosen, which sends no update.
 */
export function promotePatch(run: TaskRun, doneWhen: DoneWhenDraft, feature: FeatureDraft): TaskFieldsInput | null {
  const patch: TaskFieldsInput = {};
  if (isRunSet(run)) patch.run = run;
  const done = toDoneWhen(doneWhen);
  if (done.checks.length > 0 || done.own !== null) patch.doneWhen = done;
  Object.assign(patch, featureCreateInput(feature, null));
  return Object.keys(patch).length === 0 ? null : patch;
}
