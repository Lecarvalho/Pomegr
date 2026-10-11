import type { HTMLAttributes } from "react";
import type { Task } from "../../../shared/task-contract";
import { TaskMoveBar, type CardMoves } from "./TaskMoveBar";
import type { CardMoveKind } from "./task-board-model";
import { TaskCardIds } from "./TaskIssueChip";
import { TaskRunLine } from "./TaskRunLine";
import { TaskSessionLink } from "./TaskSessionLink";
import { completeWhenSummary } from "./task-fields";
import { taskCardTitle, taskChip } from "./task-presentation";
import { startsLine } from "./task-schedule";

export type TaskCardMove = {
  drag: Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragEnd" | "onDrop">;
  available: CardMoves;
  onMove(kind: CardMoveKind): void;
};

export function TaskCard({ task, featureLine, nextQueued = false, onOpen, move }: { task: Task; featureLine?: string | null; nextQueued?: boolean; onOpen?: (task: Task, opener: HTMLElement) => void; move?: TaskCardMove }) {
  const chip = taskChip(task, nextQueued);
  const title = taskCardTitle(task);
  const starts = startsLine(task);
  const summary = completeWhenSummary(task.completeWhen);
  const className = ["taskCard", move && "isMovable", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone"].filter(Boolean).join(" ");
  return <li className={className} data-task-id={task.id} data-task-state={task.state} draggable={move ? true : undefined} {...move?.drag}>
    <div className="taskCardTop">
      <TaskCardIds task={task} />
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title} onClick={(event) => onOpen(task, event.currentTarget)}><span className="taskCardTitle">{title}</span></button>
      : <p className="taskCardTitle" title={title}>{title}</p>}
    <TaskRunLine run={task.run} observedModel={task.session?.observedModel} />
    {starts && <p className="taskCardDetail taskCardStarts">{starts}</p>}
    {summary && <p className="taskCardDetail">{summary}</p>}
    {featureLine && <p className="taskCardDetail taskCardFeature">{featureLine}</p>}
    {task.session && <TaskSessionLink sessionId={task.session.id} className="taskCardLink" />}
    {move && <TaskMoveBar id={task.id} available={move.available} onMove={move.onMove} />}
  </li>;
}
