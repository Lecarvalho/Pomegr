"use client";

import { useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { startDesktopTask, useTaskDesktopAvailability, type TaskStartStatus } from "./task-desktop";

// Start session for one task. The desktop shows the native confirmation; this only mirrors the committed board
// (pre-disabled reasons) and one fixed line per result. It never shows a running state: the card borrows the
// session state once the monitor links the session.

const LINES: Record<TaskStartStatus, string | null> = {
  started: "Session started in a new terminal window.",
  cancelled: null,
  unsupported_platform: "Starting sessions is available on Windows only.",
  cli_missing: "The provider's command-line tool was not found on this computer.",
  plugin_missing: "Install the Pomegr plugin in this repository to start sessions.",
  not_startable: "This task cannot be started right now.",
  unsupported_provider: "Sessions cannot be started on this provider.",
  not_found: "This task no longer exists.",
  busy: "Another session is being started.",
  invalid: "The session could not be started.",
  unavailable: "The session could not be started.",
  failed: "The session could not be started.",
};
/** A retry cannot succeed after these, or after `started`, for as long as the panel stays open. */
const FINAL = new Set<TaskStartStatus>(["started", "unsupported_platform", "cli_missing", "plugin_missing", "unsupported_provider"]);

function boardReason(task: Task, unsaved: boolean): string | null {
  if (task.session !== null) return "A session is already linked to this task.";
  if (task.state === "done") return "This task is done.";
  if (task.state !== "not_queued" && task.state !== "queued" && task.state !== "scheduled") return "Resolve this task before starting it again.";
  if (unsaved) return "Save your changes first.";
  return null;
}

export function useTaskStart(repositoryId: string, task: Task, unsaved: boolean, refresh: () => Promise<void>) {
  const available = useTaskDesktopAvailability() === "available";
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<TaskStartStatus | null>(null);
  const inFlight = useRef(false);
  const reason = boardReason(task, unsaved);
  const locked = result !== null && FINAL.has(result);
  const run = async () => {
    if (inFlight.current || locked || reason !== null) return;
    inFlight.current = true;
    setPending(true);
    setResult(null);
    const status = await startDesktopTask(repositoryId, task.id);
    inFlight.current = false;
    setPending(false);
    setResult(status);
    if (status === "started") await refresh().catch(() => {});
  };
  const line = pending ? null : locked ? LINES[result] : reason ?? (result ? LINES[result] : null);
  return { available, pending, disabled: pending || locked || reason !== null, line, run };
}
