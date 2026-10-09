"use client";

import type { Task, TaskBoard } from "../../../shared/task-contract";
import { queueBanner, type QueueBannerView } from "./task-queue-banner";
import type { TaskBoardEdits } from "./use-task-board-edits";

/**
 * Why the queue is not starting tasks (design contract D30-D34, D108-D114): drawn above the Board and above the Queue
 * only while the committed status is blocked or paused. It words the monitor's answer and decides nothing itself.
 * Open needs a task opener (the desktop app); Mark done and Requeue need `edits` and appear on the Queue view only.
 */
export function QueueBanner({ board, view, onOpenTask, edits }: {
  board: Pick<TaskBoard, "queue" | "tasks">;
  view: QueueBannerView;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  edits?: TaskBoardEdits;
}) {
  const banner = queueBanner(board, view);
  if (!banner) return null;
  const { task } = banner;
  const resolve = view === "queue" && edits && task !== null && banner.resolvable ? edits : null;
  return <section className="taskQueueBanner" aria-label="Queue status" data-view={view} data-queue-status={board.queue.status}>
    <div className="taskQueueBannerText">
      <p className="taskQueueBannerTitle">{banner.title}</p>
      <p className="taskQueueBannerBody">{banner.body}</p>
    </div>
    {task && (onOpenTask || resolve) && <div className="taskQueueBannerActions">
      {onOpenTask && <button type="button" className="commandSecondaryAction" aria-haspopup="dialog" onClick={(event) => onOpenTask(task, event.currentTarget)}>Open {task.id}</button>}
      {resolve && <>
        <button type="button" className="commandSecondaryAction" disabled={resolve.busy} onClick={() => void resolve.resolveTask(task.id, true)}>Mark done and resume</button>
        <button type="button" className="commandQuietAction" disabled={resolve.busy} onClick={() => void resolve.resolveTask(task.id, false)}>Requeue {task.id}</button>
      </>}
    </div>}
  </section>;
}
