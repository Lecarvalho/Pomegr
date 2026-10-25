"use client";

import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { CapacityStrip } from "./CapacityStrip";
import { TaskLogDialog } from "./TaskLogPanel";
import type { TaskLogAnswer } from "./task-desktop";
import { ScorecardDialog } from "./ScorecardPanel";
import type { ScorecardAnswer } from "./scorecard-model";
import { QueueSettingsPanel } from "./QueueSettingsPanel";
import type { FeatureEntry } from "./FeatureActions";
import { FeatureFilter } from "./FeatureFilter";
import { QueueBanner } from "./QueueBanner";
import { NewTaskAction, type NewTaskEntry } from "./NewTaskAction";
import { ReadyGroup, ReadyLink, type ReadyGroupActions } from "./ReadyGroup";
import { TaskCard, type TaskCardMove } from "./TaskCard";
import { TaskColumnHeader } from "./TaskColumnHeader";
import { cardMove, notStarted, planLaneIds, readyUnits, waitsInQueue, type CardMoveKind } from "./task-board-model";
import { afterCardLine } from "./task-after-model";
import { ALL_FEATURES, effectiveFeatureFilter, featureLines, matchesFeatureFilter, type FeatureFilterValue } from "./task-features";
import { waitCardLine } from "./task-wait-model";
import { useMinuteClock } from "./task-panel-hooks";
import { taskColumns, type TaskColumnView } from "./task-presentation";
import { idList, linkIds, plannedIds, readySegments, type ReadyParallelGroup, type ReadySegment } from "./task-ready-groups";
import { useCardDrag, type CardDropLine, type ColumnDropHandlers } from "./use-card-drag";
import type { TaskBoardEdits } from "./use-task-board-edits";

type OpenTask = (task: Task, opener: HTMLElement, focus?: "after") => void;

const FOOTNOTE = "Drag a card to move it. Ready starts from the top, one card at a time. To run cards together, in Backlog or Ready, choose Run in parallel between them or drop a card on a group. Drag a card out of a group to take it out.";

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

type BoardProps = { board: TaskBoard; readTaskLog?: () => Promise<TaskLogAnswer>; /** Desktop app only: reads the repository's scorecard when its panel opens. */ readScorecard?: () => Promise<ScorecardAnswer>; onOpenTask?: OpenTask; edits?: TaskBoardEdits; newTask?: NewTaskEntry; features?: FeatureEntry; reveal?: TaskReveal | null; featureSelection?: FeatureSelection | null };

function ReadyBoard({ board, readTaskLog, readScorecard, onOpenTask, edits, newTask, features, reveal, featureSelection }: BoardProps) {
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
  const afterLines = useMemo(() => new Map(board.tasks.map((task) => [task.id, afterCardLine(task, board.tasks)])), [board]);
  const laneIds = planLaneIds(board);
  const now = useMinuteClock();
  const scroller = useRef<HTMLDivElement>(null);
  const restore = useRef<Restore | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const [logOpen, setLogOpen] = useState(false);
  const logTrigger = useRef<HTMLButtonElement>(null);
  const [scorecardOpen, setScorecardOpen] = useState(false);
  const scorecardTrigger = useRef<HTMLButtonElement>(null);
  // A group change is its own action: the board reads the new groups from the monitor.
  const groupCards = (ids: readonly string[]) => {
    setAnnouncement(`${idList(ids)} run in parallel.`);
    void edits?.groupTasks(ids);
  };
  const ungroupCards = (ids: readonly string[], announcement: string) => {
    setAnnouncement(announcement);
    void edits?.ungroupTasks(ids);
  };
  const drag = useCardDrag(board, (move) => { void edits?.moveTask(move); }, { columnIds: laneIds, onJoin: (id, memberId) => groupCards([memberId, id]) });
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
  const openControl = (id: string) => () => cardOf(id)?.querySelector<HTMLElement>(".taskCardOpen") ?? null;
  const groupMoveFor = (task: Task): TaskCardMove["group"] => {
    if (!edits || task.group === null || !notStarted(task)) return undefined;
    return { onLeave: () => { restore.current = { find: openControl(task.id), settled: edits.settled }; ungroupCards([task.id], `${task.id} taken out of its parallel group.`); } };
  };
  const groupControl = (memberId: string, kind: string) => () => {
    const frame = cardOf(memberId)?.closest<HTMLElement>("[data-ready-group]");
    return frame?.querySelector<HTMLElement>(`[data-group-move="${kind}"]:not(:disabled)`) ?? frame?.querySelector<HTMLElement>("[data-group-move]:not(:disabled)") ?? frame?.querySelector<HTMLElement>(".taskReadyUngroup") ?? null;
  };
  /** The move of a whole group one place up or down in its lane, past the card or the group beside it. */
  const groupMove = (group: ReadyParallelGroup, kind: "up" | "down") => {
    const lane = columns.find((column) => column.tasks.some((task) => task.id === group.tasks[0].id));
    if (!lane) return null;
    const units = readyUnits(lane.tasks);
    const at = units.findIndex((unit) => unit.group === group.group && unit.tasks[0]?.id === group.tasks[0].id);
    const beside = units[at + (kind === "up" ? -1 : 1)];
    if (at < 0 || !beside) return null;
    const start = lane.tasks.findIndex((task) => task.id === group.tasks[0].id);
    return { id: group.tasks[0].id, columnId: lane.id, position: kind === "up" ? start - beside.tasks.length : start + beside.tasks.length, group: "block" as const };
  };
  const groupActionsFor = (group: ReadyParallelGroup): ReadyGroupActions | undefined => edits && !filtered ? {
    drag: drag.groupHandlers(group.tasks[0].id),
    canMove: { up: groupMove(group, "up") !== null, down: groupMove(group, "down") !== null },
    onMove: (kind) => {
      const move = groupMove(group, kind);
      if (!move) return;
      restore.current = { find: groupControl(group.tasks[0].id, kind), settled: edits.settled };
      setAnnouncement(`The parallel group of ${idList(group.tasks.map((task) => task.id))} moved ${kind}.`);
      void edits.moveTask(move);
    },
    ...(plannedIds(group).length > 0 ? { onQueue: () => {
      restore.current = { find: openControl(group.tasks[0].id), settled: edits.settled };
      setAnnouncement(`${idList(plannedIds(group))} added to the queue with their parallel group.`);
      void edits.queueGroup(group.tasks[0].id);
    } } : {}),
    onUngroup: () => {
      restore.current = { find: openControl(group.tasks[0].id), settled: edits.settled };
      ungroupCards(group.tasks.map((task) => task.id), `${idList(group.tasks.map((task) => task.id))} no longer run in parallel.`);
    },
  } : undefined;
  const cardMoveFor = (task: Task): TaskCardMove | undefined => edits && !filtered ? {
    drag: drag.cardHandlers(task.id),
    available: Object.fromEntries(KINDS.map((kind) => [kind, cardMove(board, task.id, kind) !== null])) as TaskCardMove["available"],
    onMove: (kind) => moveCard(task.id, kind),
    group: groupMoveFor(task),
    ...(onOpenTask && notStarted(task) ? { onAfter: (opener: HTMLElement) => onOpenTask(task, opener, "after") } : {}),
  } : undefined;

  return <>
    {board.tasks.length === 0 && <p className="taskBoardEmpty">No tasks on this board yet.</p>}
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    <CapacityStrip queue={board.queue} settingsRef={settingsTrigger} onOpenSettings={() => setSettingsOpen(true)}
      {...(readTaskLog ? { logRef: logTrigger, onOpenLog: () => setLogOpen(true) } : {})}
      {...(readScorecard ? { scorecardRef: scorecardTrigger, onOpenScorecard: () => setScorecardOpen(true) } : {})} />
    {readTaskLog && logOpen && <TaskLogDialog readTaskLog={readTaskLog} returnFocus={logTrigger} onClose={() => setLogOpen(false)} />}
    {readScorecard && scorecardOpen && <ScorecardDialog readScorecard={readScorecard} returnFocus={scorecardTrigger} onClose={() => setScorecardOpen(false)} />}
    {settingsOpen && <QueueSettingsPanel queue={board.queue} edits={edits} returnFocus={settingsTrigger} onClose={() => setSettingsOpen(false)} />}
    {board.features.length > 0 && <FeatureFilter board={board} filter={filter} onFilter={setChosenFilter} edits={edits} entry={features} />}
    {columns.length > 0 && <div ref={scroller} className="taskBoardScroller" role="region" aria-label="Task board" tabIndex={0} aria-busy={edits?.busy || undefined}>
      <div className="taskBoardGrid" style={{ "--task-columns": columns.length } as CSSProperties}>
        {columns.map((column, index) => <TaskColumn key={column.id} column={column} onOpen={onOpenTask} lines={lines} afterLines={afterLines} nextId={board.queue.gates?.next?.taskId ?? board.queue.order[0] ?? null}
          ready={laneIds.includes(column.id) ? { segments: readySegments(column.tasks, board), queue: board.queue, tasks: board.tasks, now, overGroup: drag.overGroup,
            groupActionsFor, onLink: edits && !filtered ? groupCards : undefined } : undefined}
          dropTarget={drag.overColumn === column.id} dropLine={drag.dropLine?.columnId === column.id ? drag.dropLine : undefined} drop={edits && !filtered ? drag.columnHandlers(column.id) : undefined} cardMoveFor={cardMoveFor} newTask={index === 0 ? newTask : undefined} />)}
      </div>
    </div>}
    {edits && <p className="taskBoardFootnote">{FOOTNOTE}</p>}
    <span className="visuallyHidden" role="status">{announcement}</span>
  </>;
}

/** The Ready lane's parallel groups, the queue their Waiting line reads, and the clock of their Starts line. */
export type ReadyLane = {
  segments: ReadySegment[];
  queue: TaskBoard["queue"];
  /** The board's tasks: a Waiting line reads which card the monitor lists first belongs to which group. */
  tasks?: readonly Task[];
  now?: number;
  /** The group the dragged card would join. */
  overGroup?: string | null;
  /** The whole-group actions, in the desktop app or on a paired device. */
  groupActionsFor?(group: ReadyParallelGroup): ReadyGroupActions | undefined;
  /** Puts the waiting cards in one parallel group. Without it no "Run in parallel" is drawn. */
  onLink?(ids: readonly string[]): void;
};

export function TaskColumn({ column, lines, afterLines, nextId, onOpen, dropTarget, dropLine, drop, cardMoveFor, newTask, ready }: {
  column: TaskColumnView;
  lines: ReadonlyMap<string, string>;
  /** The Runs after line of each card that still runs after an unfinished task. */
  afterLines?: ReadonlyMap<string, string | null>;
  nextId: string | null;
  onOpen?: OpenTask;
  dropTarget: boolean;
  /** Where the dragged card would land in this lane: before a card, or after the last one when `beforeId` is null. */
  dropLine?: Pick<CardDropLine, "beforeId">;
  drop?: ColumnDropHandlers;
  cardMoveFor(task: Task): TaskCardMove | undefined;
  newTask?: NewTaskEntry;
  /** Set for the Backlog and Ready lanes, where the owner plans and queues: no other lane groups its cards. */
  ready?: ReadyLane;
}) {
  const headingId = useId();
  const lastId = column.tasks.at(-1)?.id;
  // A held card of a group whose siblings started says so: the group keeps its turn until this card starts too.
  const waiting = (task: Task, started: readonly string[]) => {
    const line = ready && waitsInQueue(task) ? waitCardLine(ready.queue, task) : null;
    return line && started.length > 0 && line.includes("Waiting:") ? `${line} · ${idList(started)} started` : line;
  };
  const card = (task: Task, started: readonly string[] = []) => <TaskCard key={task.id} task={task} lane={column.lane} compact={ready !== undefined && waitsInQueue(task)} now={ready?.now} waiting={waiting(task, started)}
    dropLine={!dropLine ? undefined : dropLine.beforeId === task.id ? "before" : dropLine.beforeId === null && task.id === lastId ? "after" : undefined}
    featureLine={lines.get(task.id)} after={afterLines?.get(task.id)} nextQueued={task.id === nextId} onOpen={onOpen} move={cardMoveFor(task)} />;
  // Between two waiting cards, or groups, that sit next to each other: the action that makes them one group.
  const segment = (current: ReadySegment, index: number) => {
    const ids = ready?.onLink ? linkIds(ready.segments[index - 1], current) : null;
    return <Fragment key={current.key}>
      {ids && <ReadyLink ids={ids} onLink={() => ready?.onLink?.(ids)} />}
      {current.kind === "card" ? card(current.task)
        : <ReadyGroup group={current} renderCard={(task) => card(task, current.started)} joinTarget={ready?.overGroup === current.group} actions={ready?.groupActionsFor?.(current)} />}
    </Fragment>;
  };
  return <section className={`taskColumn${dropTarget ? " isDropTarget" : ""}`} data-column-id={column.id} aria-labelledby={headingId} {...drop}>
    <TaskColumnHeader column={column} headingId={headingId} taskCount={column.tasks.length} />
    {column.tasks.length > 0 && <ul className="taskColumnList">{ready
      ? ready.segments.map(segment)
      : column.tasks.map((task) => card(task))}</ul>}
    {newTask && <NewTaskAction {...newTask} />}
  </section>;
}

export function TaskBoardView({ board, readTaskLog, readScorecard, onOpenTask, edits, newTask, features, reveal, featureSelection }: BoardProps) {
  if (board.readiness === "loading") return <TaskBoardSkeleton />;
  if (board.readiness === "unavailable") return <section className="panel taskBoardNotice" role="status"><p>Tasks are unavailable. Pomegr will retry the local monitor automatically.</p></section>;
  if (board.readiness === "desktop_only") return <section className="panel taskBoardNotice" aria-label="Tasks">
    <span className="commandChip">Desktop only</span>
    <p>The task board is available in the Pomegr desktop app on this computer.</p>
  </section>;
  return <>
    <QueueBanner board={board} onOpenTask={onOpenTask} edits={edits} />
    <ReadyBoard board={board} readTaskLog={readTaskLog} readScorecard={readScorecard} onOpenTask={onOpenTask} edits={edits} newTask={newTask} features={features} reveal={reveal} featureSelection={featureSelection} />
  </>;
}
