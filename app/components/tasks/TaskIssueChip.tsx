import type { Task } from "../../../shared/task-contract";
import { taskIssueNumber } from "./task-presentation";

/**
 * The `#N` chip of a task promoted from a GitHub issue: the shared outline chip with a circle-dot glyph and the issue
 * number in the data font. It names the source and is not a link: Pomegr never builds a URL for an issue. The glyph is
 * decorative, so the chip is one image-role element whose accessible name is the fixed phrase below.
 */
export function TaskIssueChip({ number }: { number: number }) {
  return <span className="commandChip taskIssueChip" role="img" aria-label={`GitHub issue #${number}`} title={`Promoted from GitHub issue ${number}`}>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
    </svg>
    {`#${number}`}
  </span>;
}

/** A card's identifiers: the task ID, then the issue chip right after it for a task that has a source (G36 to G38). */
export function TaskCardIds({ task }: { task: Pick<Task, "id" | "source"> }) {
  const issue = taskIssueNumber(task);
  return <span className="taskCardIds">
    <span className="taskCardId">{task.id}</span>
    {issue !== null && <TaskIssueChip number={issue} />}
  </span>;
}
