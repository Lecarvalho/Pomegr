"use client";

import { useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { openDesktopTaskWorktree, startDesktopTask, taskDesktopBridge, useTaskDesktopAvailability, type TaskStartStatus, type TaskWorktreeOpenStatus } from "./task-desktop";
import { useMinuteClock } from "./task-panel-hooks";
import { worktreeOpenLine } from "./task-queue-banner";
import { scheduleLabel, waitsForOwnTime } from "./task-schedule";

// Start session for one task. The desktop shows the native confirmation; this only mirrors the committed board
// (pre-disabled reasons) and one fixed line per result. It never shows a running state: the card borrows the
// session state once the monitor links the session. After a `worktree_dirty` answer it also offers Open folder (the same
// fixed channel and result lines as the queue banner); the folder path stays in the desktop and never reaches the modal.
// After a `tree_dirty` answer (only the repository's uncommitted changes hold the start) it offers the same start in a
// worktree of the task's own, behind the desktop's own confirmation.

const LINES: Record<TaskStartStatus, string | null> = {
  started: "Session started in a new terminal window.",
  cancelled: null,
  unsupported_platform: "Starting sessions is available on Windows only.",
  cli_missing: "The provider's command-line tool was not found on this computer.",
  plugin_missing: "Install or update the Pomegr plugin in this repository to start sessions.",
  not_startable: "This task cannot be started right now.",
  unsupported_provider: "Sessions cannot be started on this provider.",
  not_found: "This task no longer exists.",
  busy: "Another session is being started.",
  invalid: "The session could not be started.",
  unavailable: "The session could not be started.",
  failed: "The session could not be started.",
  gate_held: "A start gate holds this task. See Start gates in the Queue view.",
  tree_dirty: "This repository has uncommitted changes. Commit or discard them, or start the task in a separate worktree, which leaves them out.",
  worktree_dirty: "This task's worktree has uncommitted changes. Pomegr never removes them. Open the folder to commit or discard them, then try again.",
};
/** A retry cannot succeed after these, or after `started`, for as long as the board shows the task unchanged. */
const FINAL = new Set<TaskStartStatus>(["started", "unsupported_platform", "cli_missing", "plugin_missing", "unsupported_provider"]);

/** What the board showed of the task when the start was made; a different mark means the task changed since. */
function taskMark(task: Task): string {
  return `${task.id}
${task.session?.id ?? ""}
${task.state}`;
}

function boardReason(task: Task, unsaved: boolean, now: number): string | null {
  // A done task keeps its session link, so done is read first.
  if (task.state === "done") return "This task is done.";
  if (task.session !== null) return "A session is already linked to this task.";
  if (task.state !== "not_queued" && task.state !== "queued" && task.state !== "scheduled") return "Resolve this task before starting it again.";
  if (unsaved) return "Save your changes first.";
  // A scheduled task is not startable before its own time; the monitor refuses it too.
  if (waitsForOwnTime(task, now)) return `This task starts ${scheduleLabel(task.scheduledAt ?? "") ?? "later"}. Clear its start time to start it now.`;
  return null;
}

export function useTaskStart(repositoryId: string, task: Task, unsaved: boolean, refresh: () => Promise<void>) {
  const available = useTaskDesktopAvailability() === "available";
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ status: TaskStartStatus; mark: string } | null>(null);
  const [folder, setFolder] = useState<TaskWorktreeOpenStatus | "opening" | null>(null);
  const inFlight = useRef(false);
  const now = useMinuteClock();
  const reason = boardReason(task, unsaved, now);
  // A result belongs to the task as it was when the start was made. Once the board shows a session linked, the link
  // cleared, or a new state, the result is dropped for good, so the line and the button follow the board again.
  const stale = answer !== null && answer.mark !== taskMark(task);
  if (stale) {
    setAnswer(null);
    setFolder(null);
  }
  const result = answer === null || stale ? null : answer.status;
  const locked = result !== null && FINAL.has(result);
  const run = async (separateWorktree = false) => {
    if (inFlight.current || locked || reason !== null) return;
    inFlight.current = true;
    setPending(true);
    setAnswer(null);
    setFolder(null);
    const mark = taskMark(task);
    const status = await startDesktopTask(repositoryId, task.id, separateWorktree);
    inFlight.current = false;
    setPending(false);
    // Cancelling the confirmation of the separate-worktree start leaves the offer it was made from in place.
    setAnswer({ status: separateWorktree && status === "cancelled" ? "tree_dirty" : status, mark });
    if (status === "started") await refresh().catch(() => {});
  };
  const line = pending ? null : locked ? LINES[result] : reason ?? (result ? LINES[result] : null);
  // Offered only while the dirty-worktree line is the one showing, and only where this desktop build can open a folder.
  const folderOffered = available && !pending && reason === null && result === "worktree_dirty" && typeof taskDesktopBridge()?.taskWorktreeOpen === "function";
  const openFolder = async () => {
    if (!folderOffered || folder === "opening") return;
    setFolder("opening");
    setFolder(await openDesktopTaskWorktree(repositoryId, task.id));
  };
  // Offered only while the dirty-repository line is the one showing.
  const separateOffered = available && !pending && reason === null && result === "tree_dirty";
  const folderLine = folderOffered && folder !== null && folder !== "opening" ? worktreeOpenLine(folder) : null;
  return {
    available, pending, disabled: pending || locked || reason !== null, line, run: () => run(),
    separate: { offered: separateOffered, run: () => run(true) },
    folder: { offered: folderOffered, opening: folder === "opening", line: folderLine, open: openFolder },
  };
}
