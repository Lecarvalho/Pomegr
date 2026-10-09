"use client";

import { useMemo, useState } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { QueueBlockRules } from "./QueueBlockRules";
import { QueueFeaturePanel } from "./QueueFeaturePanel";
import { QueueSingleTasks } from "./QueueSingleTasks";
import { StartGatesPanel } from "./StartGatesPanel";
import { queueFeatures, singleQueueTasks } from "./task-queue-model";
import { useQueueDrag } from "./use-queue-drag";
import type { TaskBoardEdits } from "./use-task-board-edits";

const EMPTY_TEXT = "Nothing is in the queue yet. Open a task on the Board and choose Add to queue.";

/**
 * The Queue view of a ready board (design contract D101-D155): one panel per unfinished feature with its steps, then
 * the single tasks, then the fixed rules for when the queue blocks (D178-D183). The monitor owns the start order; this view draws it and, with `edits` (the desktop app), lets a
 * queued task move to another step by drag or from the keyboard. Without `edits` it is read-only.
 */
export function TaskQueueView({ board, onOpenTask, edits }: { board: TaskBoard; onOpenTask?: (task: Task, opener: HTMLElement) => void; edits?: TaskBoardEdits }) {
  const panels = useMemo(() => queueFeatures(board), [board]);
  const singles = useMemo(() => singleQueueTasks(board), [board]);
  const nextId = board.queue.order[0] ?? null;
  const [announcement, setAnnouncement] = useState("");
  const reorder = (id: string, step: number) => {
    setAnnouncement(`${id} moved to step ${step}.`);
    void edits?.reorderQueueTask(id, step);
  };
  const drag = useQueueDrag(board.tasks, reorder);
  const empty = panels.length === 0 && singles.length === 0;
  return <div className="taskQueueRow">
    <div className="taskQueueView">
    {edits?.failure && <p className="newTaskError taskBoardError" role="alert">{edits.failure}</p>}
    {empty && <p className="taskBoardEmpty">{EMPTY_TEXT}</p>}
    {panels.map((panel) => <QueueFeaturePanel key={panel.feature.id} panel={panel} nextId={nextId} queue={board.queue} onOpenTask={onOpenTask} drag={edits ? drag : undefined} onMove={edits ? reorder : undefined} />)}
    {!empty && <QueueSingleTasks tasks={singles} nextId={nextId} queue={board.queue} onOpenTask={onOpenTask} />}
    <QueueBlockRules />
    <span className="visuallyHidden" role="status">{announcement}</span>
    </div>
    <StartGatesPanel queue={board.queue} edits={edits} />
  </div>;
}
