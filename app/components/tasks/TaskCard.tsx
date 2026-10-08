import type { Task } from "../../../shared/task-contract";
import { ProviderBadge } from "../ProviderBadge";
import { EFFORT_LABELS, PROVIDER_LABELS, doneWhenSummary } from "./task-fields";
import { taskCardTitle, taskChip } from "./task-presentation";

/** Planned model and effort, for example "opus · high"; each only when set. */
function plannedRunText(run: Task["run"]) {
  return [run.model, run.effort && EFFORT_LABELS[run.effort].toLowerCase()].filter(Boolean).join(" · ");
}

/**
 * One task: its ID, its state chip, its text (or its session's title once it has one), the planned run and the
 * Done when summary, each only when set. With `onOpen` the card opens the Task panel; without it the card is read-only.
 */
export function TaskCard({ task, onOpen }: { task: Task; onOpen?: (task: Task, opener: HTMLElement) => void }) {
  const chip = taskChip(task);
  const title = taskCardTitle(task);
  const planned = plannedRunText(task.run);
  const summary = doneWhenSummary(task.doneWhen);
  const className = ["taskCard", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone"].filter(Boolean).join(" ");
  return <li className={className} data-task-state={task.state}>
    <div className="taskCardTop">
      <span className="taskCardId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title} onClick={(event) => onOpen(task, event.currentTarget)}><span className="taskCardTitle">{title}</span></button>
      : <p className="taskCardTitle" title={title}>{title}</p>}
    {(task.run.provider || planned) && <div className="taskCardRun">
      {task.run.provider && <ProviderBadge source={PROVIDER_LABELS[task.run.provider]} />}
      {planned && <span className="taskCardPlanned">{planned}</span>}
    </div>}
    {summary && <p className="taskCardDetail">{summary}</p>}
  </li>;
}
