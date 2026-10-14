import type { HTMLAttributes, MouseEvent } from "react";
import type { Task } from "../../../shared/task-contract";
import { TaskMoveBar, type CardGroupMove, type CardMoves } from "./TaskMoveBar";
import type { CardMoveKind } from "./task-board-model";
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
  group?: CardGroupMove;
};

/** The controls of a card that keep their own click: a click on one of them never opens the card. */
const CARD_CONTROLS = "a, button, input, select, textarea, [role='combobox'], [role='listbox'], [role='option']";

export function TaskCard({ task, featureLine, nextQueued = false, onOpen, move, dropLine, compact = false, waiting, now }: {
  task: Task;
  /** The name of the task's feature. */
  featureLine?: string | null;
  nextQueued?: boolean;
  onOpen?: (task: Task, opener: HTMLElement) => void;
  move?: TaskCardMove;
  dropLine?: "before" | "after";
  /** A card that waits in Ready: compact, with no excerpt and no Complete when line. */
  compact?: boolean;
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
  const summary = compact ? null : completeWhenSummary(task.completeWhen);
  // The started session leads; the assigned sessions follow in the order they were assigned.
  const sessions = [...(task.session ? [task.session] : []), ...(task.assigned ?? [])];
  const className = ["taskCard", compact && "taskReadyCard", onOpen && "isOpenable", move && "isMovable", chip.border === "live" && "isLive", chip.border === "attention" && "isAttention", task.state === "done" && "isDone", dropLine === "before" && "isDropBefore", dropLine === "after" && "isDropAfter"].filter(Boolean).join(" ");
  // A click anywhere on the card opens it, as its title does; the title stays the opener that focus returns to. A press
  // that moves is the browser's drag, which sends no click.
  const openFromCard = onOpen && ((event: MouseEvent<HTMLLIElement>) => {
    const card = event.currentTarget;
    const opener = card.querySelector<HTMLElement>(".taskCardOpen");
    // A list that a control of the card draws outside it still sends its clicks here.
    if (!opener || !(event.target instanceof Element) || !card.contains(event.target)) return;
    const control = event.target.closest(CARD_CONTROLS);
    if (control && control !== opener) return;
    onOpen(task, opener);
  });
  return <li className={className} data-task-id={task.id} data-task-state={task.state} draggable={move ? true : undefined} {...move?.drag} onClick={openFromCard}>
    <div className="taskCardTop">
      <TaskCardIds task={task} />
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title}><span className="taskCardTitle">{heading}</span></button>
      : <p className="taskCardTitle" title={title}>{heading}</p>}
    {preview && preview.rest !== "" && !compact && <p className="taskCardExcerpt"><TaskInlineText text={preview.rest} /></p>}
    <TaskRunLine run={task.run} observedModel={task.session?.observedModel} />
    {starts && <p className="taskCardDetail taskCardStarts">Starts {starts.day} <span className="taskCardStartsTime">{starts.time}</span></p>}
    {waiting && <p className="taskCardWaiting">{waiting}</p>}
    {summary && <p className="taskCardDetail">{summary}</p>}
    {featureLine && <p className="taskCardDetail taskCardFeature">{featureLine}</p>}
    {sessions.length > 0 && <p className="taskCardDetail taskCardSessions">
      <TaskSessionLink sessionId={sessions[0].id} className="taskCardLink" />
      {sessions.length > 1 && <span>+{sessions.length - 1} more</span>}
      {task.session === null && <span>Assigned</span>}
    </p>}
    {move && <TaskMoveBar id={task.id} available={move.available} onMove={move.onMove} group={move.group} />}
  </li>;
}
