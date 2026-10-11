"use client";

import { useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { openDesktopTaskWorktree, startDesktopTask, taskDesktopBridge, useTaskDesktopAvailability, type TaskStartStatus, type TaskWorktreeOpenStatus } from "./task-desktop";
import { heldStartLine } from "./task-gates-model";
import type { TaskModalBoard } from "./task-modal-types";
import { useMinuteClock } from "./task-panel-hooks";
import { worktreeOpenLine } from "./task-queue-banner";
import { scheduleLabel, waitsForOwnTime } from "./task-schedule";

// Start session for one task.

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
const FINAL = new Set<TaskStartStatus>(["started", "unsupported_platform", "cli_missing", "plugin_missing", "unsupported_provider"]);

function taskMark(task: Task): string {
  return `${task.id}
${task.session?.id ?? ""}
${task.state}`;
}

function boardReason(task: Task, unsaved: boolean, now: number): string | null {
  if (task.state === "done") return "This task is done.";
  if (task.session !== null) return "A session is already linked to this task.";
  if (task.state !== "not_queued" && task.state !== "queued" && task.state !== "scheduled") return "Resolve this task before starting it again.";
  if (unsaved) return "Save your changes first.";
  if (waitsForOwnTime(task, now)) return `This task starts ${scheduleLabel(task.scheduledAt ?? "") ?? "later"}. Clear its start time to start it now.`;
  return null;
}

export function useTaskStart(repositoryId: string, task: Task, board: TaskModalBoard, unsaved: boolean, refresh: () => Promise<void>) {
  const available = useTaskDesktopAvailability() === "available";
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ status: TaskStartStatus; mark: string } | null>(null);
  const [folder, setFolder] = useState<TaskWorktreeOpenStatus | "opening" | null>(null);
  const inFlight = useRef(false);
  const now = useMinuteClock();
  const reason = boardReason(task, unsaved, now);
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
    setAnswer({ status: separateWorktree && status === "cancelled" ? "tree_dirty" : status, mark });
    // A held start is named from the board's gate readings, so the line is drawn from fresh ones.
    if (status === "started" || status === "gate_held") await refresh().catch(() => {});
  };
  const resultLine = result === null ? null : (result === "gate_held" ? heldStartLine(task, board.queue) : null) ?? LINES[result];
  const line = pending ? null : locked ? resultLine : reason ?? resultLine;
  const folderOffered = available && !pending && reason === null && result === "worktree_dirty" && typeof taskDesktopBridge()?.taskWorktreeOpen === "function";
  const openFolder = async () => {
    if (!folderOffered || folder === "opening") return;
    setFolder("opening");
    setFolder(await openDesktopTaskWorktree(repositoryId, task.id));
  };
  const separateOffered = available && !pending && reason === null && result === "tree_dirty";
  const folderLine = folderOffered && folder !== null && folder !== "opening" ? worktreeOpenLine(folder) : null;
  return {
    available, pending, disabled: pending || locked || reason !== null, line, run: () => run(),
    separate: { offered: separateOffered, run: () => run(true) },
    folder: { offered: folderOffered, opening: folder === "opening", line: folderLine, open: openFolder },
  };
}
