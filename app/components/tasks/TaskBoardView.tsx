"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { CapacityStrip } from "./CapacityStrip";
import { FeatureFilter } from "./FeatureFilter";
import { QueueBanner } from "./QueueBanner";
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
const FOOTNOTE = "Drag a card to another column, or onto a card to place it before that card. Pomegr moves a card when its session starts, when it needs review, and when it is done, to the column set for that in the column's menu. Moving a card never changes its chip. While a session works on a task, the chip is that session's state.";

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];

// Five default columns, so the placeholder holds the layout the first answer will fill.
function TaskBoardSkeleton() {
  return <div className="taskBoardSkeleton" aria-label="Loading tasks">
    {Array.from({ length: 5 }, (_, index) => <div className="taskBoardSkeletonColumn" key={index}><span /><span /></div>)}
  </div>;
}

/** A focus the board restores after a keyboard action re-draws the control, until that action has settled. */
type Restore = { find(): HTMLElement | null; settled: number };

function ReadyBoard({ board, onOpenTask, edits }: { board: TaskBoard; onOpenTask?: OpenTask; edits?: TaskBoardEdits }) {
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

  // A card that changes column is a new element, and a moved column can lose focus too: put focus back on the
  // control that was used, then let go once the monitor has answered (a rolled-back move re-draws it once more).
  useLayoutEffect(() => {
    const request = restore.current;
    if (!request) return;
    const active = document.activeElement;
    if (active && active !== document.body && !scroller.current?.contains(active)) { restore.current = null; return; }
    const target = request.find();
    if (target && target !== active) target.focus();
    if (request.settled !== settled) restore.current = null;
  }, [signature, settled]);

  const findByAttribute = (attribute: string, id: string) => [...(scroller.current?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? [])].find((element) => element.getAttribute(attribute) === id);
  const cardControl = (id: string, kind: CardMoveKind) => () => {
    const card = findByAttribute("data-task-id", id);
    return card?.querySelector<HTMLElement>(`[data-move="${kind}"]:not(:disabled)`) ?? card?.querySelector<HTMLElement>("[data-move]:not(:disabled)") ?? card?.querySelector<HTMLElement>(".taskCardOpen") ?? null;
  };
  const columnControl = (id: string, side: "left" | "right") => () => {
    const column = findByAttribute("data-column-id", id);
    return column?.querySelector<HTMLElement>(`[data-column-move="${side}"]:not(:disabled)`) ?? column?.querySelector<HTMLElement>("[data-column-move]:not(:disabled)") ?? column?.querySelector<HTMLElement>("[data-column-edit]") ?? null;
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
  const moveColumn = (id: string, position: number, side: "left" | "right") => {
    if (!edits) return;
    restore.current = { find: columnControl(id, side), settled: edits.settled };
    void edits.moveColumn(id, position);
  };

  return <>
    {board.tasks.length === 0 && <p className="taskBoardEmpty">No tasks on this board yet.</p>}
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    <CapacityStrip queue={board.queue} />
    {board.features.length > 0 && <FeatureFilter board={board} filter={filter} onFilter={setChosenFilter} edits={edits} />}
    {columns.length > 0 && <div ref={scroller} className="taskBoardScroller" role="region" aria-label="Task board" tabIndex={0} aria-busy={edits?.busy || undefined}>
      <div className="taskBoardGrid" style={{ "--task-columns": columns.length } as CSSProperties}>
        {columns.map((column, index) => <TaskColumn key={column.id} column={column} index={index} columnCount={columns.length} onOpen={onOpenTask} edits={edits}
          hiddenCount={(allColumns[index]?.tasks.length ?? 0) - column.tasks.length} lines={lines} nextId={board.queue.order[0] ?? null}
          dropTarget={drag.overColumn === column.id} drop={edits && !filtered ? drag.columnHandlers(column.id) : undefined} cardMoveFor={cardMoveFor}
          onMoveColumn={moveColumn} onDeleted={() => scroller.current?.focus({ preventScroll: true })} />)}
      </div>
    </div>}
    {edits && <p className="taskBoardFootnote">{FOOTNOTE}</p>}
    <span className="visuallyHidden" role="status">{announcement}</span>
  </>;
}

function TaskColumn({ column, index, columnCount, hiddenCount, lines, nextId, onOpen, edits, dropTarget, drop, cardMoveFor, onMoveColumn, onDeleted }: {
  column: TaskColumnView;
  hiddenCount: number;
  lines: ReadonlyMap<string, string>;
  /** The queued task the monitor lists first: its chip reads "Queued · next". */
  nextId: string | null;
  index: number;
  columnCount: number;
  onOpen?: OpenTask;
  edits?: TaskBoardEdits;
  dropTarget: boolean;
  drop?: ColumnDropHandlers;
  cardMoveFor(task: Task): TaskCardMove | undefined;
  onMoveColumn(id: string, index: number, side: "left" | "right"): void;
  onDeleted(): void;
}) {
  const headingId = useId();
  return <section className={`taskColumn${dropTarget ? " isDropTarget" : ""}`} data-column-id={column.id} aria-labelledby={headingId} {...drop}>
    <TaskColumnHeader column={column} headingId={headingId} index={index} columnCount={columnCount} taskCount={column.tasks.length} hiddenCount={hiddenCount} edits={edits}
      onMove={(side) => onMoveColumn(column.id, side === "left" ? index - 1 : index + 1, side)} onDeleted={onDeleted} />
    {column.tasks.length > 0 && <ul className="taskColumnList">{column.tasks.map((task) => <TaskCard key={task.id} task={task} featureLine={lines.get(task.id)} nextQueued={task.id === nextId} onOpen={onOpen} move={cardMoveFor(task)} />)}</ul>}
  </section>;
}

export type TaskView = "board" | "queue";

/**
 * Columns with a name and a count, each holding its task cards, or with `view="queue"` the Queue view of the same
 * data, both under the Queue banner while the queue is blocked or paused. Cards open the Task panel only when `onOpenTask` is given. With `edits` (the desktop app) cards can be dragged or moved from the keyboard and columns can be managed;
 * without it the board is read-only: no draggable card, no control, no mutation.
 */
export function TaskBoardView({ board, onOpenTask, edits, view = "board" }: { board: TaskBoard; onOpenTask?: OpenTask; edits?: TaskBoardEdits; view?: TaskView }) {
  if (board.readiness === "loading") return <TaskBoardSkeleton />;
  if (board.readiness === "unavailable") return <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>;
  if (board.readiness === "desktop_only") return <section className="panel taskBoardNotice" aria-label="Tasks">
    <span className="commandChip">Desktop only</span>
    <p>The task board is available in the Pomegr desktop app on this computer.</p>
  </section>;
  return <>
    <QueueBanner board={board} view={view} onOpenTask={onOpenTask} edits={edits} />
    {view === "queue" ? <TaskQueueView board={board} onOpenTask={onOpenTask} edits={edits} /> : <ReadyBoard board={board} onOpenTask={onOpenTask} edits={edits} />}
  </>;
}
