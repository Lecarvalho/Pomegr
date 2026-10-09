"use client";

import { useState, type ReactNode } from "react";
import { createEmptyTaskBoard, type Task } from "../../../shared/task-contract";
import { AddColumnAction } from "../tasks/AddColumnAction";
import { CapacityStrip } from "../tasks/CapacityStrip";
import { FeatureFilter } from "../tasks/FeatureFilter";
import { TaskBoardView } from "../tasks/TaskBoardView";
import { TaskCard, type TaskCardMove } from "../tasks/TaskCard";
import { TaskColumnHeader } from "../tasks/TaskColumnHeader";
import { ALL_FEATURES, featureLines, type FeatureFilterValue } from "../tasks/task-features";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_BLOCKED, BOARD_RUNNING, SAMPLE_REPOSITORY_ID, T1_DONE, T2_BLOCKED, T2_REVIEW, T2_STALLED, T3_QUEUED, T6_WORKING, T7_SCHEDULED, T8_IDLE, inertEdits,
} from "./DesignSystemTaskSampleData";

const LINES = featureLines(BOARD_BLOCKED);
const EDITS = inertEdits(BOARD_RUNNING);
const EDITS_BLOCKED = inertEdits(BOARD_BLOCKED);
const noop = () => undefined;

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
  return <Section id="task-board" title="Task cards and board" lede="The repository Tasks tab composes these pieces from the shipped components: the task card and its state chip, column headers, the feature filter row, the capacity strip and the Queue banner above the board, and the board itself. Everything below is the real component with synthetic tasks; actions that exist only in the desktop app are drawn with every action answered no.">
    <div className="designSystemGrid">
      {CARD_STATES.map(({ label, note, task, next }) => <Sample key={label} label={label} note={note}>
        <Frame><ul className="taskColumnList"><TaskCard task={task} nextQueued={next} featureLine={LINES.get(task.id)} /></ul></Frame>
      </Sample>)}
    </div>
    <div className="designSystemGrid">
      <Sample label="Card, desktop app" note="The title opens the Task panel, and the card can be dragged. Tab into the card to draw the four move actions (one toolbar, one tab stop, arrow keys inside); a coarse pointer always draws them.">
        <Frame><ul className="taskColumnList"><TaskCard task={T3_QUEUED} nextQueued featureLine={LINES.get("T-3")} onOpen={noop} move={MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Column header" note="The name and a data-font count. Read-only in a browser.">
        <Frame><TaskColumnHeader column={{ id: "col-progress", name: "In progress" }} headingId="design-system-column-readonly" index={2} columnCount={5} taskCount={1} onMove={noop} onDeleted={noop} /></Frame>
      </Sample>
      <Sample label="Column header, desktop app" note="One Icon-role action opens the inline editor: rename, move left or right, and Delete column, unavailable with its reason while the column holds tasks.">
        <Frame><TaskColumnHeader column={{ id: "col-progress", name: "In progress" }} headingId="design-system-column-desktop" index={2} columnCount={5} taskCount={1} edits={EDITS} onMove={noop} onDeleted={noop} /></Frame>
      </Sample>
      <Sample label="Add column" note="Secondary role in the pane head, beside the queue switch and New task. It swaps in a one-line form.">
        <Frame><AddColumnAction edits={EDITS} full={false} /></Frame>
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
        <Frame><div className="repositoryTasksTab"><TaskBoardView board={BOARD_BLOCKED} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (queue on)" note="Cards open the Task panel and move by drag or keyboard, columns have their editor, and the footnote explains dragging.">
        <Frame><div className="repositoryTasksTab"><TaskBoardView board={BOARD_RUNNING} edits={EDITS} onOpenTask={noop} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app (blocked queue)" note="The Board banner adds one secondary Open T-n; Mark done and Requeue appear on the Queue view only.">
        <Frame><div className="repositoryTasksTab"><TaskBoardView board={BOARD_BLOCKED} edits={EDITS_BLOCKED} onOpenTask={noop} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, loading" note="Five placeholder columns hold the layout the first answer fills."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "loading")} /></Frame></Sample>
      <Sample label="Board, unavailable"><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "unavailable")} /></Frame></Sample>
      <Sample label="Board, desktop only" note="Served to a client that is not on this computer, with no task content."><Frame><TaskBoardView board={createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "desktop_only")} /></Frame></Sample>
      <Sample label="Board, no tasks"><Frame><div className="repositoryTasksTab"><TaskBoardView board={{ ...BOARD_RUNNING, features: [], tasks: [] }} /></div></Frame></Sample>
    </div>
    <p className="designSystemNote">Not rendered here because they need the desktop bridge or a live store: the New task and Task panels (fixed drawers that save through the desktop), the Start at field of the Task panel, and the Tasks tab pane head, whose controls are shown above and in the Task queue section.</p>
  </Section>;
}
