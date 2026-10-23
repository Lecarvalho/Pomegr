import type { HTMLAttributes, MouseEvent } from "react";
import type { Task } from "../../../shared/task-contract";
import { TaskMoveBar, type CardGroupMove, type CardMoves } from "./TaskMoveBar";
import type { CardMoveKind } from "./task-board-model";
import { TaskCardIds } from "./TaskIssueChip";
import { TaskRunLine } from "./TaskRunLine";
import { TaskSessionLink } from "./TaskSessionLink";
import { TaskInlineText } from "./TaskInlineText";
import { TaskTagChips } from "./TaskTagChips";
import { BOARD_NEXT_LABEL, laneSaysChip, taskCardTitle, taskChip, taskSessionTitle, taskTextPreview, type TaskLane } from "./task-presentation";
import { startsParts } from "./task-schedule";

export type TaskCardMove = {
  drag: Pick<HTMLAttributes<HTMLLIElement>, "onDragStart" | "onDragEnd">;
  available: CardMoves;
  onMove(kind: CardMoveKind): void;
  group?: CardGroupMove;
  onAfter?(opener: HTMLElement): void;
};

/** The controls of a card that keep their own click: a click on one of them never opens the card. */
const CARD_CONTROLS = "a, button, input, select, textarea, [role='combobox'], [role='listbox'], [role='option']";

export function TaskCard({ task, lane, featureLine, nextQueued = false, onOpen, move, dropLine, compact = false, waiting, after, now }: {
  task: Task;
  /** The lane the card sits in on the board. The state chip is drawn only when the lane does not already say that state. Without it the card always draws its chip. */
  lane?: TaskLane | null;
  /** The name of the task's feature. */
  featureLine?: string | null;
  nextQueued?: boolean;
  onOpen?: (task: Task, opener: HTMLElement) => void;
  move?: TaskCardMove;
  dropLine?: "before" | "after";
  /** A card that waits in Ready: the compact padding. */
  compact?: boolean;
  waiting?: string | null;
  /** The muted line of a card that is not waiting in the queue and still runs after an unfinished task. */
  after?: string | null;
  /** The clock the Starts line names "today" from. */
  now?: number;
}) {
  // The chip names the state the lane does not say: the border still follows the state when the chip is left out.
  const chip = taskChip(task, nextQueued, lane ? BOARD_NEXT_LABEL : undefined);
  const showChip = !lane || !laneSaysChip(lane, chip);
  const title = taskCardTitle(task);
  // The title is the session title, else the first sentence of the task text after its tags. The tags are drawn as chips under it.
  const { lead, tags } = taskTextPreview(task.text);
  const heading = taskSessionTitle(task) === null ? <TaskInlineText text={lead} /> : title;
  const starts = startsParts(task, now);
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
      {featureLine && <span className="taskCardFeature" title={featureLine}><span aria-hidden="true">· </span>{featureLine}</span>}
      {showChip && <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>}
    </div>
    {onOpen
      ? <button type="button" className="commandQuietAction taskCardOpen" aria-haspopup="dialog" title={title}><span className="taskCardTitle">{heading}</span></button>
      : <p className="taskCardTitle" title={title}>{heading}</p>}
    <TaskTagChips tags={tags} />
    <TaskRunLine run={task.run} observedModel={task.session?.observedModel} observedEffort={task.session?.observedEffort} />
    {starts && <p className="taskCardDetail taskCardStarts">Starts {starts.day} <span className="taskCardStartsTime">{starts.time}</span></p>}
    {waiting && <p className="taskCardWaiting">{waiting}</p>}
    {!waiting && after && <p className="taskCardWaiting taskCardAfter">{after}</p>}
    {sessions.length > 0 && <p className="taskCardDetail taskCardSessions">
      <TaskSessionLink sessionId={sessions[0].id} className="taskCardLink" arrow />
      {sessions.length > 1 && <span>+{sessions.length - 1} more</span>}
      {task.session === null && <span>Assigned</span>}
    </p>}
    {move && <TaskMoveBar id={task.id} available={move.available} onMove={move.onMove} group={move.group} onAfter={move.onAfter} />}
  </li>;
}
