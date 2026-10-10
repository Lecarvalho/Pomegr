"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { CapacityStrip } from "./CapacityStrip";
import { FeatureFilter } from "./FeatureFilter";
import { QueueBanner } from "./QueueBanner";
import { NewTaskAction, type NewTaskEntry } from "./NewTaskAction";
import { TaskCard, type TaskCardMove } from "./TaskCard";
import { TaskQueueView } from "./TaskQueueView";
import { TaskColumnHeader } from "./TaskColumnHeader";
import { cardMove, type CardMoveKind } from "./task-board-model";
import { ALL_FEATURES, effectiveFeatureFilter, featureLines, matchesFeatureFilter, type FeatureFilterValue } from "./task-features";
import { taskColumns, type TaskColumnView } from "./task-presentation";
import { useCardDrag, type ColumnDropHandlers } from "./use-card-drag";
import type { TaskBoardEdits } from "./use-task-board-edits";

type OpenTask = (task: Task, opener: HTMLElement) => void;

/** Design contract D87, shown where cards can be dragged. */
const FOOTNOTE = "Drag a card to another column, or onto a card to place it before that card. Pomegr moves a card when its session starts, when it needs review, and when it is done. Moving a card never changes its chip. While a session works on a task, the chip is that session's state.";

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];

// Five default columns, so the placeholder holds the layout the first answer will fill.
export function TaskBoardSkeleton() {
  return <div className="taskBoardSkeleton" aria-label="Loading tasks">
    {Array.from({ length: 5 }, (_, index) => <div className="taskBoardSkeletonColumn" key={index}><span /><span /></div>)}
  </div>;
}

/** A focus the board restores after a keyboard action re-draws the card control, until that action has settled. */
type Restore = { find(): HTMLElement | null; settled: number };

function ReadyBoard({ board, onOpenTask, edits, newTask }: { board: TaskBoard; onOpenTask?: OpenTask; edits?: TaskBoardEdits; newTask?: NewTaskEntry }) {
  const [chosenFilter, setChosenFilter] = useState<FeatureFilterValue>(ALL_FEATURES);
  // A filter hides cards, so positions drawn would not be positions on the monitor: nothing can move while one is on.
  const filter = effectiveFeatureFilter(board, chosenFilter);
  const filtered = filter !== ALL_FEATURES;
  const allColumns = taskColumns(board);
  const columns = filtered ? allColumns.map((column) => ({ ...column, tasks: column.tasks.filter((task) => matchesFeatureFilter(task, filter)) })) : allColumns;
  const lines = useMemo(() => featureLines(board), [board]);
  const scroller = useRef<HTMLDivElement>(null);
  const restore = useRef<Restore | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const drag = useCardDrag(board, (move) => { void edits?.moveTask(move); });
  const signature = columns.map((column) => `${column.id}:${column.tasks.map((task) => task.id).join(",")}`).join("|");
  const settled = edits?.settled ?? 0;

  // A card that changes column is a new element: put focus back on the control that was used, then let go once the monitor has answered (a rolled-back move re-draws it once more).
  useLayoutEffect(() => {
    const request = restore.current;
    if (!request) return;
    const active = document.activeElement;
    if (active && active !== document.body && !scroller.current?.contains(active)) { restore.current = null; return; }
    const target = request.find();
    if (target && target !== active) target.focus();
    if (request.settled !== settled) restore.current = null;
  }, [signature, settled]);

  const cardControl = (id: string, kind: CardMoveKind) => () => {
    const card = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find((element) => element.getAttribute("data-task-id") === id);
    return card?.querySelector<HTMLElement>(`[data-move="${kind}"]:not(:disabled)`) ?? card?.querySelector<HTMLElement>("[data-move]:not(:disabled)") ?? card?.querySelector<HTMLElement>(".taskCardOpen") ?? null;
  };

  const moveCard = (id: string, kind: CardMoveKind) => {
    const move = cardMove(board, id, kind);
    if (!edits || !move) return;
    restore.current = { find: cardControl(id, kind), settled: edits.settled };
    const column = columns.find((candidate) => candidate.id === move.columnId);
    setAnnouncement(column ? `${id} moved to ${column.name}, position ${Math.min(move.position, column.tasks.length) + 1}.` : "");
    void edits.moveTask(move);
  };
  const cardMoveFor = (task: Task): TaskCardMove | undefined => edits && !filtered ? {
    drag: drag.cardHandlers(task.id),
    available: Object.fromEntries(KINDS.map((kind) => [kind, cardMove(board, task.id, kind) !== null])) as TaskCardMove["available"],
    onMove: (kind) => moveCard(task.id, kind),
  } : undefined;

  return <>
    {board.tasks.length === 0 && <p className="taskBoardEmpty">No tasks on this board yet.</p>}
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    <CapacityStrip queue={board.queue} />
    {board.features.length > 0 && <FeatureFilter board={board} filter={filter} onFilter={setChosenFilter} edits={edits} />}
    {columns.length > 0 && <div ref={scroller} className="taskBoardScroller" role="region" aria-label="Task board" tabIndex={0} aria-busy={edits?.busy || undefined}>
      <div className="taskBoardGrid" style={{ "--task-columns": columns.length } as CSSProperties}>
        {columns.map((column, index) => <TaskColumn key={column.id} column={column} onOpen={onOpenTask} lines={lines} nextId={board.queue.order[0] ?? null}
          dropTarget={drag.overColumn === column.id} drop={edits && !filtered ? drag.columnHandlers(column.id) : undefined} cardMoveFor={cardMoveFor} newTask={index === 0 ? newTask : undefined} />)}
      </div>
    </div>}
    {edits && <p className="taskBoardFootnote">{FOOTNOTE}</p>}
    <span className="visuallyHidden" role="status">{announcement}</span>
  </>;
}

/** One lane of the Board: header, cards, and for the first lane the + New task action. Exported for `/design-system`. */
export function TaskColumn({ column, lines, nextId, onOpen, dropTarget, drop, cardMoveFor, newTask }: {
  column: TaskColumnView;
  lines: ReadonlyMap<string, string>;
  /** The queued task the monitor lists first: its chip reads "Queued · next". */
  nextId: string | null;
  onOpen?: OpenTask;
  dropTarget: boolean;
  drop?: ColumnDropHandlers;
  cardMoveFor(task: Task): TaskCardMove | undefined;
  /** Given to the first column only: a new task always lands there. */
  newTask?: NewTaskEntry;
}) {
  const headingId = useId();
  return <section className={`taskColumn${dropTarget ? " isDropTarget" : ""}`} data-column-id={column.id} aria-labelledby={headingId} {...drop}>
    <TaskColumnHeader column={column} headingId={headingId} taskCount={column.tasks.length} />
    {column.tasks.length > 0 && <ul className="taskColumnList">{column.tasks.map((task) => <TaskCard key={task.id} task={task} featureLine={lines.get(task.id)} nextQueued={task.id === nextId} onOpen={onOpen} move={cardMoveFor(task)} />)}</ul>}
    {newTask && <NewTaskAction {...newTask} />}
  </section>;
}

export type TaskView = "board" | "queue";

/**
 * Lanes with a name and a count, each holding its task cards, or with `view="queue"` the Queue view of the same
 * data, both under the Queue banner while the queue is blocked or paused. Cards open the Task panel only when `onOpenTask` is given. With `edits` (the desktop app) cards can be dragged or moved from the keyboard;
 * without it the board is read-only: no draggable card, no control, no mutation. `newTask` (the desktop app) adds the
 * + New task action to the first lane of the Board; the Queue view has no lanes and so no such entry.
 */
export function TaskBoardView({ board, onOpenTask, edits, view = "board", newTask }: { board: TaskBoard; onOpenTask?: OpenTask; edits?: TaskBoardEdits; view?: TaskView; newTask?: NewTaskEntry }) {
  if (board.readiness === "loading") return <TaskBoardSkeleton />;
  if (board.readiness === "unavailable") return <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>;
  if (board.readiness === "desktop_only") return <section className="panel taskBoardNotice" aria-label="Tasks">
    <span className="commandChip">Desktop only</span>
    <p>The task board is available in the Pomegr desktop app on this computer.</p>
  </section>;
  return <>
    <QueueBanner board={board} view={view} onOpenTask={onOpenTask} edits={edits} />
    {view === "queue" ? <TaskQueueView board={board} onOpenTask={onOpenTask} edits={edits} /> : <ReadyBoard board={board} onOpenTask={onOpenTask} edits={edits} newTask={newTask} />}
  </>;
}
