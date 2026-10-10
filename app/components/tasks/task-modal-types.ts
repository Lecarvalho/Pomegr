import type { TaskBoard } from "../../../shared/task-contract";

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
