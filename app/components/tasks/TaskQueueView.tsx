"use client";

import { useMemo, useState } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { QueueBlockRules } from "./QueueBlockRules";
import { QueueFeaturePanel } from "./QueueFeaturePanel";
import { QueueSingleTasks } from "./QueueSingleTasks";
import { SchedulePanel } from "./SchedulePanel";
import { StartGatesPanel } from "./StartGatesPanel";
import { queueFeatures, reorderMove, singleQueueTasks } from "./task-queue-model";
import { useQueueDrag } from "./use-queue-drag";
import type { TaskBoardEdits } from "./use-task-board-edits";

const EMPTY_TEXT = "Nothing is in the queue yet. Open a task on the Board and choose Add to queue.";

export function TaskQueueView({ board, onOpenTask, edits }: { board: TaskBoard; onOpenTask?: (task: Task, opener: HTMLElement) => void; edits?: TaskBoardEdits }) {
  const panels = useMemo(() => queueFeatures(board), [board]);
  const singles = useMemo(() => singleQueueTasks(board), [board]);
  const nextId = board.queue.order[0] ?? null;
  const [announcement, setAnnouncement] = useState("");
  const reorder = (task: Task, target: Task) => {
    const move = reorderMove(board, task, target);
    if (!move) return;
    const step = panels.flatMap((panel) => panel.steps).find((candidate) => candidate.task.id === target.id)?.step;
    setAnnouncement(`${task.id} moved to step ${step}.`);
    void edits?.moveTask(move);
  };
  const drag = useQueueDrag(board, reorder);
  const empty = panels.length === 0 && singles.length === 0;
  return <div className="taskQueueRow">
    <div className="taskQueueView">
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    {empty && <p className="taskBoardEmpty">{EMPTY_TEXT}</p>}
    {panels.map((panel) => <QueueFeaturePanel key={panel.feature.id} panel={panel} board={board} nextId={nextId} queue={board.queue} onOpenTask={onOpenTask} drag={edits ? drag : undefined} onMove={edits ? reorder : undefined} />)}
    {!empty && <QueueSingleTasks tasks={singles} nextId={nextId} queue={board.queue} onOpenTask={onOpenTask} />}
    <QueueBlockRules />
    <span className="visuallyHidden" role="status">{announcement}</span>
    </div>
    <aside className="taskQueueAside" aria-label="Queue settings">
      <StartGatesPanel queue={board.queue} edits={edits} />
      <SchedulePanel queue={board.queue} edits={edits} />
    </aside>
  </div>;
}
