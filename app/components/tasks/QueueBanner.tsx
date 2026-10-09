"use client";

import { useState } from "react";
import type { Task, TaskBoard } from "../../../shared/task-contract";
import { openDesktopTaskWorktree, taskDesktopBridge, useTaskDesktopAvailability, type TaskWorktreeOpenStatus } from "./task-desktop";
import { queueBanner, worktreeOpenLine, type QueueBannerView } from "./task-queue-banner";
import type { TaskBoardEdits } from "./use-task-board-edits";

/**
 * Why the queue is not starting tasks (design contract D30-D34, D108-D114): drawn above the Board and above the Queue
 * only while the committed status is blocked or paused. It words the monitor's answer and decides nothing itself.
 * Open needs a task opener (the desktop app); Mark done and Requeue need `edits` and appear on the Queue view only.
 * Open folder appears only for a dirty task worktree and only where the desktop can open it; the path stays in the
 * desktop, so the banner shows one fixed line per result.
 */
export function QueueBanner({ board, view, onOpenTask, edits }: {
  board: Pick<TaskBoard, "queue" | "tasks"> & { repositoryId?: string };
  view: QueueBannerView;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  edits?: TaskBoardEdits;
}) {
  const desktop = useTaskDesktopAvailability();
  const [folder, setFolder] = useState<{ taskId: string; status: TaskWorktreeOpenStatus | "opening" } | null>(null);
  const banner = queueBanner(board, view);
  if (!banner) return null;
  const { task } = banner;
  const { repositoryId } = board;
  const folderTaskId = desktop === "available" && repositoryId && typeof taskDesktopBridge()?.taskWorktreeOpen === "function" ? banner.dirtyWorktreeTaskId : null;
  const folderLine = folder !== null && folder.taskId === folderTaskId && folder.status !== "opening" ? worktreeOpenLine(folder.status) : null;
  const openFolder = async (id: string) => {
    if (!repositoryId || folder?.status === "opening") return;
    setFolder({ taskId: id, status: "opening" });
    setFolder({ taskId: id, status: await openDesktopTaskWorktree(repositoryId, id) });
  };
  const resolve = view === "queue" && edits && task !== null && banner.resolvable ? edits : null;
  return <section className="taskQueueBanner" aria-label="Queue status" data-view={view} data-queue-status={board.queue.status}>
    <div className="taskQueueBannerText">
      <p className="taskQueueBannerTitle">{banner.title}</p>
      <p className="taskQueueBannerBody">{banner.body}</p>
      {folderLine && <p className="taskQueueBannerBody" role="status">{folderLine}</p>}
    </div>
    {(folderTaskId || (task && (onOpenTask || resolve))) && <div className="taskQueueBannerActions">
      {folderTaskId && <button type="button" className="commandSecondaryAction" disabled={folder?.status === "opening"} onClick={() => void openFolder(folderTaskId)}>Open folder</button>}
      {task && onOpenTask && <button type="button" className="commandSecondaryAction" aria-haspopup="dialog" onClick={(event) => onOpenTask(task, event.currentTarget)}>Open {task.id}</button>}
      {task && resolve && <>
        <button type="button" className="commandSecondaryAction" disabled={resolve.busy} onClick={() => void resolve.resolveTask(task.id, true)}>Mark done and resume</button>
        <button type="button" className="commandQuietAction" disabled={resolve.busy} onClick={() => void resolve.resolveTask(task.id, false)}>Requeue {task.id}</button>
      </>}
    </div>}
  </section>;
}
