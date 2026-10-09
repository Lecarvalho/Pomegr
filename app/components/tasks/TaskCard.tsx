import type { Task } from "../../../shared/task-contract";
import { taskCardTitle, taskChip } from "./task-presentation";

/** One task: its ID, its state chip, and its text (or its session's title once it has one). */
export function TaskCard({ task }: { task: Task }) {
  const chip = taskChip(task);
  const title = taskCardTitle(task);
  const className = ["taskCard", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone"].filter(Boolean).join(" ");
  return <li className={className} data-task-state={task.state}>
    <div className="taskCardTop">
      <span className="taskCardId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    <p className="taskCardTitle" title={title}>{title}</p>
  </li>;
}
