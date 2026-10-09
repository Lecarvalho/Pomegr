"use client";

import { useId } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { TaskRunLine } from "./TaskRunLine";
import { waitingLine } from "./task-gates-model";
import { taskCardTitle, taskChip } from "./task-presentation";
import { scheduleLabel } from "./task-schedule";

/** A single task's state chip; a scheduled one carries its time (D155) when it has one. */
function chipOf(task: Task, nextQueued: boolean) {
  const chip = taskChip(task, nextQueued);
  const when = task.state === "scheduled" && task.scheduledAt ? scheduleLabel(task.scheduledAt) : null;
  return { ...chip, label: when && chip.label === "Scheduled" ? `Scheduled · ${when}` : chip.label };
}

/**
 * Tasks with no feature that are queued or further along (design contract D147-D155). They run after the features, one
 * at a time: queued ones in the order the monitor lists them, then the rest by task number.
 */
export function QueueSingleTasks({ tasks, nextId, queue, onOpenTask }: { tasks: Task[]; nextId: string | null; queue: TaskBoard["queue"]; onOpenTask?: (task: Task, opener: HTMLElement) => void }) {
  const headingId = useId();
  return <section className="panel taskQueuePanel" aria-labelledby={headingId}>
    <div className="taskQueueHead">
      <h3 id={headingId} className="taskQueueHeading">Single tasks</h3>
      <span className="taskQueueCaption">Run after features, one at a time</span>
    </div>
    {tasks.length === 0
      ? <p className="taskQueueNote">No single task is queued.</p>
      : <ul className="taskQueueSingles" aria-label="Single tasks in the queue">
        {tasks.map((task) => {
          const chip = chipOf(task, task.id === nextId);
          const title = taskCardTitle(task);
          const waiting = waitingLine(queue, task.id);
          return <li key={task.id} className="taskQueueSingle" data-task-id={task.id} data-task-state={task.state}>
            <span className="taskCardId">{task.id}</span>
            {onOpenTask
              ? <button type="button" className="commandQuietAction taskCardOpen taskQueueSingleTitle" aria-haspopup="dialog" title={title} onClick={(event) => onOpenTask(task, event.currentTarget)}><span className="taskCardTitle">{title}</span></button>
              : <p className="taskCardTitle taskQueueSingleTitle" title={title}>{title}</p>}
            <TaskRunLine run={task.run} />
            <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
            {waiting && <p className="taskCardWaiting taskQueueSingleWaiting">{waiting}</p>}
          </li>;
        })}
      </ul>}
  </section>;
}
