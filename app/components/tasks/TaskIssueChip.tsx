import type { Task } from "../../../shared/task-contract";
import { taskIssueNumber } from "./task-presentation";

/** The `#N` chip of a task promoted from a GitHub issue. */
export function TaskIssueChip({ number }: { number: number }) {
  return <span className="commandChip taskIssueChip" role="img" aria-label={`GitHub issue #${number}`} title={`Promoted from GitHub issue ${number}`}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </svg>
    {`#${number}`}
  </span>;
}

export function TaskCardIds({ task }: { task: Pick<Task, "id" | "source"> }) {
  const issue = taskIssueNumber(task);
  return <span className="taskCardIds">
    <span className="taskCardId">{task.id}</span>
    {issue !== null && <TaskIssueChip number={issue} />}
  </span>;
}
