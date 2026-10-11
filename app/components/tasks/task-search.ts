import { plainTaskText, type TaskBoard } from "../../../shared/task-contract";
import type { PaletteScopeItem } from "../command-center/palette-scope";
import { taskCardTitle, taskChip, taskColumns, taskIssueNumber } from "./task-presentation";

function firstLine(title: string) {
  return title.split(/\r?\n/u).map((line) => line.replace(/\s+/gu, " ").trim()).find(Boolean) ?? "";
}

export function taskSearchItems(board: Pick<TaskBoard, "columns" | "tasks" | "features" | "queue">): PaletteScopeItem[] {
  const features = new Map(board.features.map((feature) => [feature.id, feature.name]));
  const nextId = board.queue.order[0] ?? null;
  return taskColumns(board).flatMap((column) => column.tasks.map((task) => {
    const chip = taskChip(task, task.id === nextId).label;
    const feature = task.featureId === null ? null : features.get(task.featureId) ?? null;
    const issue = taskIssueNumber(task);
    const issueLabel = issue === null ? null : `#${issue}`;
    return {
      id: task.id,
      label: firstLine(taskCardTitle(task)) || task.id,
      detail: [task.id, issueLabel, column.name, chip, feature].filter(Boolean).join(" · "),
      terms: [task.id, issueLabel, plainTaskText(task.text), task.session?.title, column.name, chip, feature].filter(Boolean).join("\n").toLowerCase(),
    };
  }));
}
