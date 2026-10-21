"use client";

import type { CSSProperties, ReactNode } from "react";
import type { ReadyGroupActions } from "../tasks/ReadyGroup";
import { TaskAfterField } from "../tasks/TaskAfterField";
import { TaskColumn, type ReadyLane } from "../tasks/TaskBoardView";
import { TaskCard, type TaskCardMove } from "../tasks/TaskCard";
import { AFTER_LOOP_MESSAGE, afterCardLine } from "../tasks/task-after-model";
import { taskColumns } from "../tasks/task-presentation";
import { readySegments } from "../tasks/task-ready-groups";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_PLAN, P15_AFTER } from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const COLUMNS = taskColumns(BOARD_PLAN);
const NO_LINES = new Map<string, string>();
const AFTER_LINES = new Map(BOARD_PLAN.tasks.map((task) => [task.id, afterCardLine(task, BOARD_PLAN.tasks)]));
const GROUP_ACTIONS: ReadyGroupActions = { drag: { onDragStart: noop, onDragEnd: noop }, canMove: { up: true, down: true }, onMove: noop, onQueue: noop, onUngroup: noop };
const lane = (index: number, desktop: boolean): ReadyLane => ({
  segments: readySegments(COLUMNS[index].tasks, BOARD_PLAN), queue: BOARD_PLAN.queue, tasks: BOARD_PLAN.tasks,
  ...(desktop ? { groupActionsFor: () => GROUP_ACTIONS, onLink: noop } : {}),
});
const MOVE: TaskCardMove = { drag: {}, available: { up: true, down: true, left: false, right: true }, onMove: noop, onAfter: noop };
const columnName = (columnId: string) => COLUMNS.find((column) => column.id === columnId)?.name ?? null;

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

function Lane({ index, desktop = false }: { index: number; desktop?: boolean }) {
  return <Frame><div className={`taskBoardGrid${desktop ? " designSystemRevealLink designSystemRevealGroup" : ""}`} style={{ "--task-columns": 1 } as CSSProperties}>
    <TaskColumn column={COLUMNS[index]} lines={NO_LINES} afterLines={AFTER_LINES} nextId={BOARD_PLAN.queue.order[0]} dropTarget={false} cardMoveFor={() => undefined} ready={lane(index, desktop)} />
  </div></Frame>;
}

export function TaskPlanSection() {
  return <Section id="task-plan" title="Planning and runs after" lede="The owner arranges cards in Backlog the way Ready reads: card order one after another, and an explicit parallel group to run together. A task can also run after other tasks of the board: it never starts until each of them is Done or deleted. Everything below is the real component with synthetic tasks.">
    <div className="designSystemGrid">
      <Sample label="Backlog lane, a plan" note="T-13 and T-14 are a parallel group of cards that are not queued yet: the same frame, caption, and count as in Ready. Cards that only sit next to each other draw no frame. T-15 runs after both and says so in the muted wait line.">
        <Lane index={0} />
      </Sample>
      <Sample label="Backlog lane, desktop app" note="Run in parallel shows between two cards that have not started, also in Backlog. A plan's caption adds the Quiet Queue group, which queues its cards and takes them to the end of Ready in their order. Here the hover actions are forced visible.">
        <Lane index={0} desktop />
      </Sample>
      <Sample label="Ready lane, a card that runs after another" note="T-9 runs after T-21, which is not done. It is out of the start order, like a scheduled task before its time: the queue passes it and T-10 is next. It keeps its place and starts there when T-21 is Done.">
        <Lane index={1} />
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Card, desktop app, Runs after…" note="The move toolbar of a card that has not started ends with the Quiet Runs after…, in underlined ink at 32px. It opens the Task modal with focus on the Runs after select. Tab into the card to draw it.">
        <Frame><ul className="taskColumnList"><TaskCard task={P15_AFTER} lane="backlog" after={AFTER_LINES.get("T-15")} onOpen={noop} move={MOVE} /></ul></Frame>
      </Sample>
      <Sample label="Task modal, Runs after" note="One fieldset after Complete when, built like Sessions: a ruled row for each task with its title, ID, column, state chip, and the Quiet Remove; then a select and the Secondary Add. It saves by itself.">
        <Frame><TaskAfterField task={P15_AFTER} tasks={BOARD_PLAN.tasks} columnName={columnName} editable onChange={noop} /></Frame>
      </Sample>
      <Sample label="Task modal, a loop refused" note="A list that would make tasks wait for each other is refused with one fixed line, and nothing changes.">
        <Frame><TaskAfterField task={P15_AFTER} tasks={BOARD_PLAN.tasks} columnName={columnName} editable error={AFTER_LOOP_MESSAGE} onChange={noop} /></Frame>
      </Sample>
      <Sample label="Task modal, started task" note="A task that has started shows its rows read-only, with no select and no Remove.">
        <Frame><TaskAfterField task={P15_AFTER} tasks={BOARD_PLAN.tasks} columnName={columnName} editable={false} /></Frame>
      </Sample>
    </div>
  </Section>;
}
