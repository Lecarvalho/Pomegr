import type { HTMLAttributes } from "react";
import type { Task } from "../../../shared/task-contract";
import { ParallelGlyph } from "./ParallelGlyph";
import { TaskMoveBar, type CardMoves, type CardStepMove } from "./TaskMoveBar";
import type { CardMoveKind } from "./task-board-model";
import type { FeatureLine } from "./task-features";
import { TaskCardIds } from "./TaskIssueChip";
import { TaskRunLine } from "./TaskRunLine";
import { TaskSessionLink } from "./TaskSessionLink";
import { completeWhenSummary } from "./task-fields";
import { TaskInlineText } from "./TaskInlineText";
import { taskCardTitle, taskChip, taskSessionTitle, taskTextPreview } from "./task-presentation";
import { startsParts } from "./task-schedule";

export type TaskCardMove = {
  drag: Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragEnd">;
  available: CardMoves;
  onMove(kind: CardMoveKind): void;
  step?: CardStepMove;
};

export function TaskCard({ task, featureLine, nextQueued = false, onOpen, move, dropLine, grouped = false, waiting, now }: {
  task: Task;
  featureLine?: FeatureLine | null;
  nextQueued?: boolean;
  onOpen?: (task: Task, opener: HTMLElement) => void;
  move?: TaskCardMove;
  dropLine?: "before" | "after";
  /** A card inside a Ready group: compact, with no Complete when line and no feature line, which its caption carries. */
  grouped?: boolean;
  waiting?: string | null;
  /** The clock the Starts line names "today" from. */
  now?: number;
}) {
  const chip = taskChip(task, nextQueued);
  const title = taskCardTitle(task);
  // The task text reads as its first sentence and a muted excerpt; a session title stands alone.
  const preview = taskSessionTitle(task) === null ? taskTextPreview(task.text) : null;
  const heading = preview ? <TaskInlineText text={preview.lead} /> : title;
  const starts = startsParts(task, now);
  const summary = grouped ? null : completeWhenSummary(task.completeWhen);
  const feature = grouped ? null : featureLine;
  // The started session leads; the assigned sessions follow in the order they were assigned.
  const sessions = [...(task.session ? [task.session] : []), ...(task.assigned ?? [])];
  const className = ["taskCard", grouped && "taskReadyCard", move && "isMovable", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone", dropLine === "before" && "isDropBefore", dropLine === "after" && "isDropAfter"].filter(Boolean).join(" ");
  return <li className={className} data-task-id={task.id} data-task-state={task.state} draggable={move ? true : undefined} {...move?.drag}>
    <div className="taskCardTop">
      <TaskCardIds task={task} />
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title} onClick={(event) => onOpen(task, event.currentTarget)}><span className="taskCardTitle">{heading}</span></button>
      : <p className="taskCardTitle" title={title}>{heading}</p>}
    {preview && preview.rest !== "" && !grouped && <p className="taskCardExcerpt"><TaskInlineText text={preview.rest} /></p>}
    <TaskRunLine run={task.run} observedModel={task.session?.observedModel} />
    {starts && <p className="taskCardDetail taskCardStarts">Starts {starts.day} <span className="taskCardStartsTime">{starts.time}</span></p>}
    {waiting && <p className="taskCardWaiting">{waiting}</p>}
    {summary && <p className="taskCardDetail">{summary}</p>}
    {feature && <p className="taskCardDetail taskCardFeature">
      {feature.parallelWith.length > 0 && <ParallelGlyph label="Parallel" />}
      <span>{feature.text}{feature.parallelWith.length > 0 && <> · parallel with <span className="taskCardFeatureIds">{feature.parallelWith.join(", ")}</span></>}</span>
    </p>}
    {sessions.length > 0 && <p className="taskCardDetail taskCardSessions">
      <TaskSessionLink sessionId={sessions[0].id} className="taskCardLink" />
      {sessions.length > 1 && <span>+{sessions.length - 1} more</span>}
      {task.session === null && <span>Assigned</span>}
    </p>}
    {move && <TaskMoveBar id={task.id} available={move.available} onMove={move.onMove} step={move.step} />}
  </li>;
}
