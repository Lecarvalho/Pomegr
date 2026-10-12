"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { CapacityStrip } from "./CapacityStrip";
import { QueueSettingsPanel } from "./QueueSettingsPanel";
import type { FeatureEntry } from "./FeatureActions";
import { FeatureFilter } from "./FeatureFilter";
import { QueueBanner } from "./QueueBanner";
import { NewTaskAction, type NewTaskEntry } from "./NewTaskAction";
import { ReadyNewStepZone, ReadyStepGroup } from "./ReadyStepGroup";
import { TaskCard, type TaskCardMove } from "./TaskCard";
import { TaskColumnHeader } from "./TaskColumnHeader";
import { cardMove, readyColumnId, type CardMoveKind } from "./task-board-model";
import { ALL_FEATURES, effectiveFeatureFilter, featureLines, matchesFeatureFilter, type FeatureFilterValue, type FeatureLine } from "./task-features";
import { waitingLine } from "./task-gates-model";
import { useMinuteClock } from "./task-panel-hooks";
import { taskColumns, type TaskColumnView } from "./task-presentation";
import { boardStepChoices, dropKey, isMovableQueueTask, newStepLabel, queueFeatures } from "./task-queue-model";
import { readySegments, type ReadySegment } from "./task-ready-groups";
import { useCardDrag, type CardDropLine, type ColumnDropHandlers } from "./use-card-drag";
import type { TaskBoardEdits } from "./use-task-board-edits";

type OpenTask = (task: Task, opener: HTMLElement) => void;

const FOOTNOTE = "Drag a card to move it. In Ready, drop a card on a step to run it in parallel with that step, or after its feature's last step to give it a step of its own.";

const KINDS: readonly CardMoveKind[] = ["up", "down", "left", "right"];

export function TaskBoardSkeleton() {
  return <div className="taskBoardSkeleton" aria-label="Loading tasks">
    {Array.from({ length: 5 }, (_, index) => <div className="taskBoardSkeletonColumn" key={index}><span /><span /></div>)}
  </div>;
}

type Restore = { find(): HTMLElement | null; settled: number };

export type TaskReveal = { id: string; turn: number };

/** A feature the board was asked to show, such as by a session's feature link: the filter chooses it. */
export type FeatureSelection = { id: string };

type BoardProps = { board: TaskBoard; onOpenTask?: OpenTask; edits?: TaskBoardEdits; newTask?: NewTaskEntry; features?: FeatureEntry; reveal?: TaskReveal | null; featureSelection?: FeatureSelection | null };

function ReadyBoard({ board, onOpenTask, edits, newTask, features, reveal, featureSelection }: BoardProps) {
  const [chosenFilter, setChosenFilter] = useState<FeatureFilterValue>(ALL_FEATURES);
  const [revealed, setRevealed] = useState(reveal ?? null);
  const [selection, setSelection] = useState<FeatureSelection | null>(null);
  if ((featureSelection ?? null) !== selection) { setSelection(featureSelection ?? null); if (featureSelection) setChosenFilter(featureSelection.id); }
  if ((reveal ?? null) !== revealed) { setRevealed(reveal ?? null); setChosenFilter(ALL_FEATURES); }
  // A filter hides cards, so positions drawn would not be positions on the monitor.
  const filter = effectiveFeatureFilter(board, chosenFilter);
  // A filter that named a feature the board no longer holds (it was deleted) returns to All, and stays there.
  if (filter !== chosenFilter) setChosenFilter(filter);
  const filtered = filter !== ALL_FEATURES;
  const allColumns = taskColumns(board);
  const columns = filtered ? allColumns.map((column) => ({ ...column, tasks: column.tasks.filter((task) => matchesFeatureFilter(task, filter)) })) : allColumns;
  const lines = useMemo(() => featureLines(board), [board]);
  const readyId = readyColumnId(board);
  const now = useMinuteClock();
  const scroller = useRef<HTMLDivElement>(null);
  const restore = useRef<Restore | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const panels = useMemo(() => queueFeatures(board), [board]);
  // A change of step is its own action: it moves no card.
  const moveStep = (id: string, step: number) => {
    setAnnouncement(`${id} moved to step ${step}.`);
    void edits?.reorderQueueTask(id, step);
  };
  const drag = useCardDrag(board, (move) => { void edits?.moveTask(move); }, { columnId: readyId, panels, onStep: moveStep });
  const signature = columns.map((column) => `${column.id}:${column.tasks.map((task) => task.id).join(",")}`).join("|");
  const settled = edits?.settled ?? 0;

  useLayoutEffect(() => {
    const request = restore.current;
    if (!request) return;
    const active = document.activeElement;
    if (active && active !== document.body && !scroller.current?.contains(active)) { restore.current = null; return; }
    const target = request.find();
    if (target && target !== active) target.focus();
    if (request.settled !== settled) restore.current = null;
  }, [signature, settled]);

  useEffect(() => {
    if (!reveal) return;
    const card = [...(scroller.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find((element) => element.getAttribute("data-task-id") === reveal.id);
    if (!card) return;
    card.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    const control = card.querySelector<HTMLElement>(".taskCardOpen");
    if (!control) card.tabIndex = -1;
    (control ?? card).focus({ preventScroll: true });
  }, [reveal]);

  const cardOf = (id: string) => [...(scroller.current?.querySelectorAll<HTMLElement>("[data-task-id]") ?? [])].find((element) => element.getAttribute("data-task-id") === id);
  const cardControl = (id: string, kind: CardMoveKind) => () => {
    const card = cardOf(id);
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
  const stepControl = (id: string) => () => {
    const card = cardOf(id);
    return card?.querySelector<HTMLElement>(".taskMoveStep [role='combobox']") ?? card?.querySelector<HTMLElement>(".taskCardOpen") ?? null;
  };
  const stepMoveFor = (task: Task): TaskCardMove["step"] => {
    const panel = isMovableQueueTask(task) ? panels.find((candidate) => candidate.feature.id === task.featureId) : undefined;
    if (!edits || !panel) return undefined;
    return { choices: boardStepChoices(panel, task), onMove: (step) => { restore.current = { find: stepControl(task.id), settled: edits.settled }; moveStep(task.id, step); } };
  };
  const cardMoveFor = (task: Task): TaskCardMove | undefined => edits && !filtered ? {
    drag: drag.cardHandlers(task.id),
    available: Object.fromEntries(KINDS.map((kind) => [kind, cardMove(board, task.id, kind) !== null])) as TaskCardMove["available"],
    onMove: (kind) => moveCard(task.id, kind),
    step: stepMoveFor(task),
  } : undefined;
  const zonePanel = panels.find((panel) => drag.overStep === dropKey(panel.feature.id, null));

  return <>
    {board.tasks.length === 0 && <p className="taskBoardEmpty">No tasks on this board yet.</p>}
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    <CapacityStrip queue={board.queue} settingsRef={settingsTrigger} onOpenSettings={() => setSettingsOpen(true)} />
    {settingsOpen && <QueueSettingsPanel queue={board.queue} edits={edits} returnFocus={settingsTrigger} onClose={() => setSettingsOpen(false)} />}
    {board.features.length > 0 && <FeatureFilter board={board} filter={filter} onFilter={setChosenFilter} edits={edits} entry={features} />}
    {columns.length > 0 && <div ref={scroller} className="taskBoardScroller" role="region" aria-label="Task board" tabIndex={0} aria-busy={edits?.busy || undefined}>
      <div className="taskBoardGrid" style={{ "--task-columns": columns.length } as CSSProperties}>
        {columns.map((column, index) => <TaskColumn key={column.id} column={column} onOpen={onOpenTask} lines={lines} nextId={board.queue.order[0] ?? null}
          ready={column.id === readyId ? { segments: readySegments(column.tasks, board), queue: board.queue, now, overStep: drag.overStep,
            newStep: zonePanel && { featureId: zonePanel.feature.id, label: newStepLabel(zonePanel) } } : undefined}
          dropTarget={drag.overColumn === column.id} dropLine={drag.dropLine?.columnId === column.id ? drag.dropLine : undefined} drop={edits && !filtered ? drag.columnHandlers(column.id) : undefined} cardMoveFor={cardMoveFor} newTask={index === 0 ? newTask : undefined} />)}
      </div>
    </div>}
    {edits && <p className="taskBoardFootnote">{FOOTNOTE}</p>}
    <span className="visuallyHidden" role="status">{announcement}</span>
  </>;
}

/** The Ready lane's step groups, the queue their Waiting line reads, and the clock of their Starts line. */
export type ReadyLane = {
  segments: ReadySegment[];
  queue: TaskBoard["queue"];
  now?: number;
  /** The step target under the dragged card, as a `dropKey`. */
  overStep?: string | null;
  /** The new-step zone, drawn after the last group of its feature while the dragged card is over that gap. */
  newStep?: { featureId: string; label: string };
};

export function TaskColumn({ column, lines, nextId, onOpen, dropTarget, dropLine, drop, cardMoveFor, newTask, ready }: {
  column: TaskColumnView;
  lines: ReadonlyMap<string, FeatureLine>;
  nextId: string | null;
  onOpen?: OpenTask;
  dropTarget: boolean;
  /** Where the dragged card would land in this lane: before a card, or after the last one when `beforeId` is null. */
  dropLine?: Pick<CardDropLine, "beforeId">;
  drop?: ColumnDropHandlers;
  cardMoveFor(task: Task): TaskCardMove | undefined;
  newTask?: NewTaskEntry;
  /** Set for the Ready lane only: no other lane groups its cards. */
  ready?: ReadyLane;
}) {
  const headingId = useId();
  const lastId = column.tasks.at(-1)?.id;
  const card = (task: Task, grouped = false) => <TaskCard key={task.id} task={task} grouped={grouped} now={ready?.now} waiting={grouped && ready ? waitingLine(ready.queue, task.id) : undefined}
    dropLine={!dropLine ? undefined : dropLine.beforeId === task.id ? "before" : dropLine.beforeId === null && task.id === lastId ? "after" : undefined}
    featureLine={lines.get(task.id)} nextQueued={task.id === nextId} onOpen={onOpen} move={cardMoveFor(task)} />;
  const zoneAfter = ready?.newStep && ready.segments.findLast((segment) => segment.kind === "step" && segment.feature.id === ready.newStep?.featureId)?.key;
  const group = (segment: Exclude<ReadySegment, { kind: "card" }>) => <Fragment key={segment.key}>
    <ReadyStepGroup group={segment} renderCard={(task) => card(task, true)} stepTarget={segment.kind === "step" && ready?.overStep === dropKey(segment.feature.id, segment.step)} />
    {ready?.newStep && segment.key === zoneAfter && <ReadyNewStepZone {...ready.newStep} />}
  </Fragment>;
  return <section className={`taskColumn${dropTarget ? " isDropTarget" : ""}`} data-column-id={column.id} aria-labelledby={headingId} {...drop}>
    <TaskColumnHeader column={column} headingId={headingId} taskCount={column.tasks.length} />
    {column.tasks.length > 0 && <ul className="taskColumnList">{ready
      ? ready.segments.map((segment) => segment.kind === "card" ? card(segment.task) : group(segment))
      : column.tasks.map((task) => card(task))}</ul>}
    {newTask && <NewTaskAction {...newTask} />}
  </section>;
}

export function TaskBoardView({ board, onOpenTask, edits, newTask, features, reveal, featureSelection }: BoardProps) {
  if (board.readiness === "loading") return <TaskBoardSkeleton />;
  if (board.readiness === "unavailable") return <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>;
  if (board.readiness === "desktop_only") return <section className="panel taskBoardNotice" aria-label="Tasks">
    <span className="commandChip">Desktop only</span>
    <p>The task board is available in the Pomegr desktop app on this computer.</p>
  </section>;
  return <>
    <QueueBanner board={board} onOpenTask={onOpenTask} edits={edits} />
    <ReadyBoard board={board} onOpenTask={onOpenTask} edits={edits} newTask={newTask} features={features} reveal={reveal} featureSelection={featureSelection} />
  </>;
}
