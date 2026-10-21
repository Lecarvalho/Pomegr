"use client";

import { createRef, useState, type CSSProperties, type ReactNode } from "react";
import { createEmptyTaskBoard, type Task } from "../../../shared/task-contract";
import { CapacityStrip } from "../tasks/CapacityStrip";
import { FeatureFilter } from "../tasks/FeatureFilter";
import type { FeatureEntry } from "../tasks/FeatureActions";
import type { NewTaskEntry } from "../tasks/NewTaskAction";
import type { ReadyGroupActions } from "../tasks/ReadyGroup";
import { TaskBoardView, TaskColumn, type ReadyLane } from "../tasks/TaskBoardView";
import { TaskCard, type TaskCardMove } from "../tasks/TaskCard";
import { TaskColumnHeader } from "../tasks/TaskColumnHeader";
import { ALL_FEATURES, featureLines, type FeatureFilterValue } from "../tasks/task-features";
import { taskColumns, type TaskLane } from "../tasks/task-presentation";
import { readySegments } from "../tasks/task-ready-groups";
import { waitCardLine } from "../tasks/task-wait-model";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_BLOCKED, BOARD_HELD_MEMBER, BOARD_RUNNING, SAMPLE_FEATURE_ID, SAMPLE_GROUP_ID, SAMPLE_FUTURE, SAMPLE_FUTURE_STOP, SAMPLE_REPOSITORY_ID, T1_DONE, T11_LONG, T17_TAGGED, T18_PLANNED, T19_NEEDS_INPUT, T2_BLOCKED, T2_REVIEW, T2_STALLED, T3_QUEUED, T4_QUEUED, T5_IDLE, T6_WORKING, T7_SCHEDULED, T9_ISSUE, inertEdits,
} from "./DesignSystemTaskSampleData";

const LINES = featureLines({ ...BOARD_BLOCKED, tasks: [...BOARD_BLOCKED.tasks, T17_TAGGED] });
const EDITS = inertEdits(BOARD_RUNNING);
const EDITS_BLOCKED = inertEdits(BOARD_BLOCKED);
const noop = () => undefined;
const newTaskEntry = (): NewTaskEntry => ({ triggerRef: createRef<HTMLButtonElement>(), onOpen: noop });
const BOARD_ENTRY = newTaskEntry();
const REVEALED_ENTRY = newTaskEntry();
const COLUMNS = taskColumns(BOARD_RUNNING);
const noMove = () => undefined;
const QUEUE_WITH_STOP = { ...BOARD_RUNNING.queue, schedule: { startAt: null, stopAfter: SAMPLE_FUTURE_STOP } };
// The Ready lane of the running board, read on the scheduled task's own day so its Starts line says "today".
const READY_LANE: ReadyLane = { segments: readySegments(COLUMNS[1].tasks, BOARD_RUNNING), queue: BOARD_RUNNING.queue, tasks: BOARD_RUNNING.tasks, now: Date.parse(SAMPLE_FUTURE) };
const GROUP_ACTIONS: ReadyGroupActions = { drag: { onDragStart: noop, onDragEnd: noop }, canMove: { up: false, down: true }, onMove: noop, onUngroup: noop };
// The lane as the desktop app draws it: Run in parallel between waiting cards, and the whole-group actions on a caption.
const READY_LANE_DESKTOP: ReadyLane = { ...READY_LANE, groupActionsFor: () => GROUP_ACTIONS, onLink: noop };
const HELD_COLUMNS = taskColumns(BOARD_HELD_MEMBER);
const HELD_LANE: ReadyLane = { segments: readySegments(HELD_COLUMNS[1].tasks, BOARD_HELD_MEMBER), queue: BOARD_HELD_MEMBER.queue, tasks: BOARD_HELD_MEMBER.tasks, now: Date.parse(SAMPLE_FUTURE) };

const MOVE: TaskCardMove = { drag: {}, available: { up: false, down: true, left: false, right: true }, onMove: noop };
// A waiting card of a parallel group adds Take out of group after the four arrows.
const GROUP_MOVE: TaskCardMove = { ...MOVE, group: { onLeave: noop } };
const JOIN_TARGET_LANE: ReadyLane = { ...READY_LANE, overGroup: SAMPLE_GROUP_ID };

type CardState = { label: string; note: string; task: Task; lane: TaskLane; next?: boolean; compact?: boolean; waiting?: string | null; narrow?: boolean };

// One card for each state a lane can draw, with the chip the lane leaves out: the lane already says it.
const CARD_STATES: CardState[] = [
  { label: "Backlog, Not queued", lane: "backlog", note: "The lane already says Not queued, so the card draws no chip. The meta row holds the ID and the feature's name, which gives way first with an ellipsis.", task: T5_IDLE },
  { label: "Backlog, tags", lane: "backlog", note: "The tags at the start of the first line are drawn as neutral chips under the title and left out of the title. They are display only: the stored text keeps its brackets. The card draws no excerpt of the rest of the text.", task: T17_TAGGED },
  { label: "Backlog, long text", lane: "backlog", note: "The title is the first sentence of the text, clamped to three lines. A backtick span is code in the data font. The whole text is the tooltip.", task: T11_LONG },
  { label: "Ready, Queued", lane: "ready", compact: true, waiting: waitCardLine(BOARD_RUNNING.queue, T4_QUEUED), note: "The lane already says Queued, so the card draws no chip and relies on its place in the lane and its wait line. A task on its provider's default model names the provider in the run line.", task: T4_QUEUED },
  { label: "Ready, Next", lane: "ready", compact: true, next: true, note: "The one task the monitor names as next keeps a chip: Next on the board, in ink on the raised fill. Other surfaces keep Queued · next.", task: T3_QUEUED },
  { label: "Ready, Scheduled", lane: "ready", compact: true, note: "Info tone, plus the muted Starts line until a session is linked.", task: T7_SCHEDULED },
  { label: "Ready, Not queued", lane: "ready", compact: true, note: "A planned card in Ready: the lane says Queued, so the Not queued chip stays.", task: T18_PLANNED },
  { label: "In progress, Working", lane: "in_progress", note: "The lane already says In progress, so the card draws no chip. The green border shows that the bound session works. A differing model is one amber line.", task: T6_WORKING },
  { label: "In progress, Needs input", lane: "in_progress", note: "The bound session waits for the owner: the Needs input chip and an amber border.", task: T19_NEEDS_INPUT },
  { label: "In progress, Stalled", lane: "in_progress", note: "The session ended with no report. A stalled card stays where it is.", task: { ...T2_STALLED, columnId: "col-progress" } },
  { label: "In progress, Blocked by agent", lane: "in_progress", note: "The agent reported it cannot continue.", task: { ...T2_BLOCKED, columnId: "col-progress" } },
  { label: "Review, Needs review", lane: "review", note: "The lane already says Needs review, so the card draws no chip. The amber border shows that the owner marks the task done.", task: T2_REVIEW },
  { label: "Done", lane: "done", note: "Muted title and Open session, and no chip: the lane says Done.", task: T1_DONE },
  { label: "From a GitHub issue, needs attention", lane: "review", narrow: true, note: "A promoted card in the narrowest lane (220px). The ID, the #N chip and the feature name keep the first line, and the Blocked by agent chip wraps to a second line at the end. The border is amber.", task: { ...T2_BLOCKED, source: T9_ISSUE.source } },
  { label: "From a GitHub issue", lane: "backlog", note: "A task promoted from an issue carries its #N chip right after the task ID: the outline chip in the data font with a circle-dot glyph. It is a label, not a link.", task: T9_ISSUE },
];

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

const FEATURE_ENTRY: FeatureEntry = { onNew: noop, onEdit: noop };
const FILTER_BOARD = { ...BOARD_RUNNING, features: [...BOARD_RUNNING.features, { id: "feature-archive", name: "Archive export", done: true }] };

function FilterSample({ desktop, initial = ALL_FEATURES }: { desktop: boolean; initial?: FeatureFilterValue }) {
  const [filter, setFilter] = useState<FeatureFilterValue>(initial);
  return <Frame><FeatureFilter board={FILTER_BOARD} filter={filter} onFilter={setFilter} edits={desktop ? EDITS : undefined} entry={desktop ? FEATURE_ENTRY : undefined} /></Frame>;
}

export function TaskBoardSection() {
  return <Section id="task-board" title="Task cards and board" lede="The Tasks page composes these pieces from the shipped components: the task card and its state chip, lanes with their headers, the feature filter row, the capacity strip and the Queue banner above the board, and the board itself. Everything below is the real component with synthetic tasks; actions that exist only in the desktop app are drawn with every action answered no.">
    <div className="designSystemGrid">
      {CARD_STATES.map(({ label, note, task, lane, next, compact, waiting, narrow }) => <Sample key={label} label={label} note={note}>
        <Frame><ul className={narrow ? "taskColumnList designSystemNarrowLane" : "taskColumnList"}><TaskCard task={task} lane={lane} compact={compact} waiting={waiting} nextQueued={next} featureLine={LINES.get(task.id)} /></ul></Frame>
      </Sample>)}
    </div>
    <div className="designSystemGrid">
      <Sample label="Card, desktop app" note="The title opens the Task modal, and the card can be dragged. Tab into the card to draw the four move actions (one toolbar, one tab stop, arrow keys inside); a coarse pointer always draws them.">
        <Frame><ul className="taskColumnList"><TaskCard task={T3_QUEUED} lane="ready" nextQueued featureLine={LINES.get("T-3")} onOpen={noop} move={MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Card, desktop app, in a parallel group" note="A waiting card of a parallel group adds the Quiet Take out of group after the four arrows, in underlined ink at 32px. The card then starts on its own, at its place in Ready or right after the group.">
        <Frame><ul className="taskColumnList"><TaskCard task={T3_QUEUED} lane="ready" compact featureLine={LINES.get("T-3")} onOpen={noop} move={GROUP_MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Column header" note="The name and a data-font count over a one-pixel rule, with no control: the board has five fixed columns, in the desktop app and in a browser alike.">
        <Frame><TaskColumnHeader column={{ id: "col-progress", name: "In progress" }} headingId="design-system-column-header" taskCount={1} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Lane, + New task revealed" note="A column is a lane: no fill and no border at rest, only the header over its rule and the cards on the panel fill. The first lane alone ends with the Quiet + New task, invisible until the lane is hovered or holds focus (always shown on a coarse pointer). Here it is forced visible.">
        <Frame><div className="designSystemRevealAdd taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[0]} lines={LINES} nextId={null} dropTarget={false} cardMoveFor={noMove} newTask={REVEALED_ENTRY} /></div></Frame>
      </Sample>
      <Sample label="Lane, empty" note="The action is still the lane's last item when it holds no card.">
        <Frame><div className="designSystemRevealAdd taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={{ ...COLUMNS[0], tasks: [] }} lines={LINES} nextId={null} dropTarget={false} cardMoveFor={noMove} newTask={newTaskEntry()} /></div></Frame>
      </Sample>
      <Sample label="Lane, drop target" note="A lane has no border at rest, so the lane under a dragged card takes the raised fill and a two-pixel strong-line ring. The two-pixel ink drop line shows where the card will land, here under the last card.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[2]} lines={LINES} nextId={null} dropTarget dropLine={{ beforeId: null }} cardMoveFor={noMove} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Ready lane, parallel group" note="Ready is the queue's lane: its waiting cards start from the top, one at a time, whatever their feature. Only the cards the owner put in a parallel group run together. The group is a frame in the plain line under the parallel glyph and the count of its members that still wait. Two cards that only sit next to each other draw no frame. A waiting card is compact and names its feature. It adds one muted line: its place in the start order past the first, then Waiting with each reason it has not started.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={READY_LANE} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, desktop app" note="The caption's end adds the two Icon arrows that move the whole group and the Quiet Ungroup. They are invisible until the group is hovered or holds focus, and always drawn on a coarse pointer and at 760px and narrower, at 44px. Between two waiting cards, the Quiet Run in parallel puts them in one group. It is drawn while the lane is hovered or the action holds focus. Here both are forced visible.">
        <Frame><div className="designSystemRevealLink designSystemRevealGroup taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={READY_LANE_DESKTOP} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, group at rest, desktop app" note="With the group neither hovered nor focused, the caption holds only the parallel glyph and the count. The toolbar is still in the tab order and the accessibility tree.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={{ ...READY_LANE, groupActionsFor: () => GROUP_ACTIONS }} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, join target" note="While a waiting card is dragged over a group it is not in, the group takes the panel fill and the lane's two-pixel strong-line border. Dropping puts the card in that group. No drop line is drawn over a join target.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget cardMoveFor={noMove} ready={JOIN_TARGET_LANE} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, a member held" note="A start gate holds one member while its sibling started. The caption counts the one card that still waits and names the member that started. The held card says why it waits and that its sibling started. The next card of Ready waits for the whole group.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={HELD_COLUMNS[1]} lines={LINES} nextId={BOARD_HELD_MEMBER.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={HELD_LANE} /></div></Frame>
      </Sample>
      <Sample label="Card outside Ready, feature name" note="The feature's name follows the ID in the meta row, after a dot. A feature gives a task context only, so it names no step and no other task.">
        <Frame><ul className="taskColumnList"><TaskCard task={T2_REVIEW} lane="review" featureLine={LINES.get("T-2")} /><TaskCard task={T1_DONE} lane="done" featureLine={LINES.get("T-1")} /></ul></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Feature filter" note="One select whose options carry a task count: All first, then the open features and No feature. Done features come last, in muted text. Filtering is client state only.">
        <FilterSample desktop={false} />
      </Sample>
      <Sample label="Feature filter, desktop app" note="With All or No feature chosen the row adds only the Quiet + New feature, which opens the Feature modal in mode New feature. Choose a feature to see the row below.">
        <FilterSample desktop />
      </Sample>
      <Sample label="Feature filter, desktop app, a feature chosen" note="While one feature is chosen the row adds a Quiet Edit feature before + New feature, which opens the Feature modal in mode Feature. Then come the feature's progress, with the counts in the data font and the number of its tasks that run when one does, and the line that says moving cards is off.">
        <FilterSample desktop initial={SAMPLE_FEATURE_ID} />
      </Sample>
      <Sample label="Capacity strip" note="The same two readings as Start gates, above the board; omitted when the board sends no gates.">
        <Frame><CapacityStrip queue={BOARD_RUNNING.queue} /></Frame>
      </Sample>
      <Sample label="Capacity strip, on the Board" note="On the Board the strip ends with the threshold and, only when a stop time is set, that time, with both values in the data font and ink. Queue settings is last: the Quiet role, 32px high, in underlined ink. It opens the Queue settings panel.">
        <Frame><CapacityStrip queue={QUEUE_WITH_STOP} onOpenSettings={noop} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, browser (blocked queue)" note="Read-only: no draggable card and no control but Queue settings. The Queue banner sits above the capacity strip, the feature filter and the columns; columns scroll sideways instead of shrinking below 220px.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_BLOCKED} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (queue on)" note="Cards open the Task modal and move by drag or keyboard, waiting cards of Ready join and leave a parallel group, and the footnote explains dragging. The first lane ends with + New task, shown while the lane is hovered or focused.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_RUNNING} edits={EDITS} onOpenTask={noop} newTask={BOARD_ENTRY} features={FEATURE_ENTRY} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (blocked queue)" note="The Board banner carries every action: the secondary Open T-n and Mark done and resume, and the quiet Requeue T-n in ink. A paused queue keeps only Open T-n.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_BLOCKED} edits={EDITS_BLOCKED} onOpenTask={noop} newTask={newTaskEntry()} features={FEATURE_ENTRY} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, loading" note="Five placeholder lanes hold the layout the first answer fills."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "loading")} /></Frame></Sample>
      <Sample label="Board, unavailable"><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "unavailable")} /></Frame></Sample>
      <Sample label="Board, desktop only" note="Served to a client that is not on this computer, with no task content."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "desktop_only")} /></Frame></Sample>
      <Sample label="Board, no tasks"><Frame><div className="tasksPageBody"><TaskBoardView board={{ ...BOARD_RUNNING, features: [], tasks: [] }} /></div></Frame></Sample>
    </div>
    <p className="designSystemNote">Not rendered here because they need the desktop bridge or a live store: the New task and Task modals (native dialogs that save through the desktop), the Start at field of the Task modal, and the Tasks page itself, whose header actions are shown in the Queue controls section.</p>
  </Section>;
}
