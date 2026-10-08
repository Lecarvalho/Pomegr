import type { HTMLAttributes } from "react";
import type { Task } from "../../../shared/task-contract";
import { ProviderBadge } from "../ProviderBadge";
import { TaskMoveBar, type CardMoves } from "./TaskMoveBar";
import type { CardMoveKind } from "./task-board-model";
import { EFFORT_LABELS, PROVIDER_LABELS, doneWhenSummary } from "./task-fields";
import { taskCardTitle, taskChip } from "./task-presentation";

/** Planned model and effort, for example "opus · high"; each only when set. */
function plannedRunText(run: Task["run"]) {
  return [run.model, run.effort && EFFORT_LABELS[run.effort].toLowerCase()].filter(Boolean).join(" · ");
}

/** What makes a card movable in the desktop app: the drag handlers for the `li` and the keyboard move actions. */
export type TaskCardMove = {
  drag: Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragEnd" | "onDrop">;
  available: CardMoves;
  onMove(kind: CardMoveKind): void;
};

/**
 * One task: its ID, its state chip, its text (or its session's title once it has one), the planned run, the
 * Done when summary and, for a task in a feature, the feature line, each only when set. With `onOpen` the card opens the Task panel; with `move` it can be dragged
 * and moved from the keyboard. Without either the card is read-only.
 */
export function TaskCard({ task, featureLine, onOpen, move }: { task: Task; featureLine?: string | null; onOpen?: (task: Task, opener: HTMLElement) => void; move?: TaskCardMove }) {
  const chip = taskChip(task);
  const title = taskCardTitle(task);
  const planned = plannedRunText(task.run);
  const summary = doneWhenSummary(task.doneWhen);
  const className = ["taskCard", move && "isMovable", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone"].filter(Boolean).join(" ");
  return <li className={className} data-task-id={task.id} data-task-state={task.state} draggable={move ? true : undefined} {...move?.drag}>
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
    {featureLine && <p className="taskCardDetail taskCardFeature">{featureLine}</p>}
    {move && <TaskMoveBar id={task.id} available={move.available} onMove={move.onMove} />}
  </li>;
}
