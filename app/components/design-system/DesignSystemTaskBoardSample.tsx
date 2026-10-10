"use client";

import { createRef, useState, type CSSProperties, type ReactNode } from "react";
import { createEmptyTaskBoard, type Task } from "../../../shared/task-contract";
import { CapacityStrip } from "../tasks/CapacityStrip";
import { FeatureFilter } from "../tasks/FeatureFilter";
import type { NewTaskEntry } from "../tasks/NewTaskAction";
import { TaskBoardView, TaskColumn } from "../tasks/TaskBoardView";
import { TaskCard, type TaskCardMove } from "../tasks/TaskCard";
import { TaskColumnHeader } from "../tasks/TaskColumnHeader";
import { ALL_FEATURES, featureLines, type FeatureFilterValue } from "../tasks/task-features";
import { taskColumns } from "../tasks/task-presentation";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_BLOCKED, BOARD_RUNNING, SAMPLE_REPOSITORY_ID, T1_DONE, T2_BLOCKED, T2_REVIEW, T2_STALLED, T3_QUEUED, T6_WORKING, T7_SCHEDULED, T8_IDLE, inertEdits,
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

// What the desktop app adds to a card: drag handlers and the four keyboard move actions (the first column cannot move left).
const MOVE: TaskCardMove = { drag: {}, available: { up: false, down: true, left: false, right: true }, onMove: noop };

const CARD_STATES: { label: string; note: string; task: Task; next?: boolean }[] = [
  { label: "Not queued", note: "Task text only; nothing else is set.", task: T8_IDLE },
  { label: "Queued · next", note: "The first task the monitor would start. Queued reads in ink on the raised fill.", task: T3_QUEUED, next: true },
  { label: "Scheduled", note: "Info tone, plus the muted Starts line until a session is linked.", task: T7_SCHEDULED },
  { label: "Session working", note: "The chip is the bound session's state, borrowed from the Sessions list, with a green border. A differing model is one amber line.", task: T6_WORKING },
  { label: "Needs review", note: "Amber border and chip: a check did not pass.", task: T2_REVIEW },
  { label: "Stalled", note: "The session ended with no report.", task: T2_STALLED },
  { label: "Blocked by agent", note: "The agent reported it cannot continue.", task: T2_BLOCKED },
  { label: "Done", note: "Muted title and Open session.", task: T1_DONE },
];

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

function FilterSample({ desktop }: { desktop: boolean }) {
  const [filter, setFilter] = useState<FeatureFilterValue>(ALL_FEATURES);
  return <Frame><FeatureFilter board={BOARD_RUNNING} filter={filter} onFilter={setFilter} edits={desktop ? EDITS : undefined} /></Frame>;
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
      <Sample label="Lane, drop target" note="The raised fill is the lane itself, so the lane under a dragged card takes the strong line on its border instead.">
        <Frame><div className="taskBoardGrid" style={{ "--task-columns": 1 } as CSSProperties}><TaskColumn column={COLUMNS[2]} lines={LINES} nextId={null} dropTarget cardMoveFor={noMove} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Feature filter" note="Toggle chips with a data-font count: All first, No feature last. Filtering is client state only.">
        <FilterSample desktop={false} />
      </Sample>
      <Sample label="Feature filter, desktop app" note="Adds the Quiet + New feature action. Choose a feature to see the line that says moving cards is off.">
        <FilterSample desktop />
      </Sample>
      <Sample label="Capacity strip" note="The same two readings as Start gates, above the board; omitted when the board sends no gates.">
        <Frame><CapacityStrip queue={BOARD_RUNNING.queue} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, browser (blocked queue)" note="Read-only: no draggable card, no control. The Queue banner sits above the capacity strip, the feature filter and the columns; columns scroll sideways instead of shrinking below 220px.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_BLOCKED} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (queue on)" note="Cards open the Task modal and move by drag or keyboard, and the footnote explains dragging. The first lane ends with + New task, shown while the lane is hovered or focused.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_RUNNING} edits={EDITS} onOpenTask={noop} newTask={BOARD_ENTRY} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (blocked queue)" note="The Board banner adds one secondary Open T-n; Mark done and Requeue appear on the Queue view only.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_BLOCKED} edits={EDITS_BLOCKED} onOpenTask={noop} newTask={newTaskEntry()} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, loading" note="Five placeholder lanes hold the layout the first answer fills."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "loading")} /></Frame></Sample>
      <Sample label="Board, unavailable"><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "unavailable")} /></Frame></Sample>
      <Sample label="Board, desktop only" note="Served to a client that is not on this computer, with no task content."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "desktop_only")} /></Frame></Sample>
      <Sample label="Board, no tasks"><Frame><div className="tasksPageBody"><TaskBoardView board={{ ...BOARD_RUNNING, features: [], tasks: [] }} /></div></Frame></Sample>
    </div>
    <p className="designSystemNote">Not rendered here because they need the desktop bridge or a live store: the New task and Task modals (native dialogs that save through the desktop), the Start at field of the Task modal, and the Tasks page header, whose repository switcher is the shared CommandSelect and whose other controls are shown above and in the Task queue section.</p>
  </Section>;
}
