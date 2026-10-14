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
import { taskColumns } from "../tasks/task-presentation";
import { readySegments } from "../tasks/task-ready-groups";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_BLOCKED, BOARD_HELD_MEMBER, BOARD_RUNNING, SAMPLE_FEATURE_ID, SAMPLE_GROUP_ID, SAMPLE_FUTURE, SAMPLE_FUTURE_STOP, SAMPLE_REPOSITORY_ID, T1_DONE, T11_LONG, T2_BLOCKED, T2_REVIEW, T2_STALLED, T3_QUEUED, T6_WORKING, T7_SCHEDULED, T8_IDLE, T9_ISSUE, inertEdits,
} from "./DesignSystemTaskSampleData";

const LINES = featureLines(BOARD_BLOCKED);
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

const CARD_STATES: { label: string; note: string; task: Task; next?: boolean }[] = [
  { label: "Not queued", note: "Task text only; nothing else is set.", task: T8_IDLE },
  { label: "Long text", note: "The title is the first sentence of the text, clamped to three lines. The rest follows as a muted excerpt of two lines. A backtick span is code in the data font. The whole text is the tooltip.", task: T11_LONG },
  { label: "Queued · next", note: "The first task the monitor would start. Queued reads in ink on the raised fill.", task: T3_QUEUED, next: true },
  { label: "Scheduled", note: "Info tone, plus the muted Starts line until a session is linked.", task: T7_SCHEDULED },
  { label: "Session working", note: "The chip is the bound session's state, borrowed from the Sessions list, with a green border. A differing model is one amber line.", task: T6_WORKING },
  { label: "Needs review", note: "Amber border and chip: the agent reported the task complete, and the owner marks it done.", task: T2_REVIEW },
  { label: "Stalled", note: "The session ended with no report.", task: T2_STALLED },
  { label: "Blocked by agent", note: "The agent reported it cannot continue.", task: T2_BLOCKED },
  { label: "Done", note: "Muted title and Open session.", task: T1_DONE },
  { label: "From a GitHub issue", note: "A task promoted from an issue carries its #N chip right after the task ID: the outline chip in the data font with a circle-dot glyph. It is a label, not a link.", task: T9_ISSUE },
];

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

const FEATURE_ENTRY: FeatureEntry = { onNew: noop, onEdit: noop };

function FilterSample({ desktop, initial = ALL_FEATURES }: { desktop: boolean; initial?: FeatureFilterValue }) {
  const [filter, setFilter] = useState<FeatureFilterValue>(initial);
  return <Frame><FeatureFilter board={BOARD_RUNNING} filter={filter} onFilter={setFilter} edits={desktop ? EDITS : undefined} entry={desktop ? FEATURE_ENTRY : undefined} /></Frame>;
}

export function TaskBoardSection() {
  return <Section id="task-board" title="Task cards and board" lede="The Tasks page composes these pieces from the shipped components: the task card and its state chip, lanes with their headers, the feature filter row, the capacity strip and the Queue banner above the board, and the board itself. Everything below is the real component with synthetic tasks; actions that exist only in the desktop app are drawn with every action answered no.">
    <div className="designSystemGrid">
      {CARD_STATES.map(({ label, note, task, next }) => <Sample key={label} label={label} note={note}>
        <Frame><ul className="taskColumnList"><TaskCard task={task} nextQueued={next} featureLine={LINES.get(task.id)} /></ul></Frame>
      </Sample>)}
    </div>
    <div className="designSystemGrid">
      <Sample label="Card, desktop app" note="The title opens the Task modal, and the card can be dragged. Tab into the card to draw the four move actions (one toolbar, one tab stop, arrow keys inside); a coarse pointer always draws them.">
        <Frame><ul className="taskColumnList"><TaskCard task={T3_QUEUED} nextQueued featureLine={LINES.get("T-3")} onOpen={noop} move={MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Card, desktop app, in a parallel group" note="A waiting card of a parallel group adds the Quiet Take out of group after the four arrows, in underlined ink at 32px. The card then starts on its own, at its place in Ready or right after the group.">
        <Frame><ul className="taskColumnList"><TaskCard task={T3_QUEUED} compact featureLine={LINES.get("T-3")} onOpen={noop} move={GROUP_MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Column header" note="The name and a data-font count over a one-pixel rule, with no control: the board has five fixed columns, in the desktop app and in a browser alike.">
        <Frame><TaskColumnHeader column={{ id: "col-progress", name: "In progress" }} headingId="design-system-column-header" taskCount={1} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Lane, + New task revealed" note="A column is a lane: the raised fill with a one-pixel rule, cards on the panel fill. The first lane alone ends with the Quiet + New task, invisible until the lane is hovered or holds focus (always shown on a coarse pointer). Here it is forced visible.">
        <Frame><div className="designSystemRevealAdd taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[0]} lines={LINES} nextId={null} dropTarget={false} cardMoveFor={noMove} newTask={REVEALED_ENTRY} /></div></Frame>
      </Sample>
      <Sample label="Lane, empty" note="The action is still the lane's last item when it holds no card.">
        <Frame><div className="designSystemRevealAdd taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={{ ...COLUMNS[0], tasks: [] }} lines={LINES} nextId={null} dropTarget={false} cardMoveFor={noMove} newTask={newTaskEntry()} /></div></Frame>
      </Sample>
      <Sample label="Lane, drop target" note="The raised fill is the lane itself, so the lane under a dragged card takes the strong line on its border instead. The two-pixel ink drop line shows where the card will land, here under the last card.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[2]} lines={LINES} nextId={null} dropTarget dropLine={{ beforeId: null }} cardMoveFor={noMove} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Ready lane, parallel group" note="Ready is the queue's lane: its waiting cards start from the top, one at a time, whatever their feature. Only the cards the owner put in a parallel group run together. The group is a strong-line frame under the parallel glyph and the count of its members that still wait. Two cards that only sit next to each other draw no frame. A waiting card is compact and names its feature.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={READY_LANE} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, desktop app" note="The caption adds the two Icon arrows that move the whole group and the Quiet Ungroup. Between two waiting cards, the Quiet Run in parallel puts them in one group. It is drawn while the lane is hovered or the action holds focus, and always on a coarse pointer. Here it is forced visible.">
        <Frame><div className="designSystemRevealLink taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={READY_LANE_DESKTOP} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, join target" note="While a waiting card is dragged over a group it is not in, the group takes the panel fill and the lane's two-pixel strong-line border. Dropping puts the card in that group. No drop line is drawn over a join target.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[1]} lines={LINES} nextId={BOARD_RUNNING.queue.order[0]} dropTarget cardMoveFor={noMove} ready={JOIN_TARGET_LANE} /></div></Frame>
      </Sample>
      <Sample label="Ready lane, a member held" note="A start gate holds one member while its sibling started. The caption counts the one card that still waits and names the member that started. The held card says why it waits and that its sibling started. The next card of Ready waits for the whole group.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={HELD_COLUMNS[1]} lines={LINES} nextId={BOARD_HELD_MEMBER.queue.order[0]} dropTarget={false} cardMoveFor={noMove} ready={HELD_LANE} /></div></Frame>
      </Sample>
      <Sample label="Card outside Ready, feature line" note="The feature line is the feature's name. A feature gives a task context only, so the line names no step and no other task.">
        <Frame><ul className="taskColumnList"><TaskCard task={T2_REVIEW} featureLine={LINES.get("T-2")} /><TaskCard task={T1_DONE} featureLine={LINES.get("T-1")} /></ul></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Feature filter" note="One select whose options carry a task count: All first, No feature last. Filtering is client state only.">
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
