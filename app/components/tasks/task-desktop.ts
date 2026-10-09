"use client";

import { useSyncExternalStore } from "react";
import { TASK_BOUNDS, type TaskActionError } from "../../../shared/task-contract";

// The only way the renderer changes a task: the desktop preload's `taskAction` bridge (fixed IPC channel
// `pomegr:task-action`). A plain browser has no bridge, so it never mutates tasks and never POSTs.

/** Fixed result of one desktop task action. `unavailable` means the desktop could not reach the monitor. */
export type TaskActionResult = { ok: true } | { ok: false; error: TaskActionError | "unavailable" };

export type TaskDesktopBridge = {
  taskAction(repositoryId: string, action: string, payload: unknown): Promise<TaskActionResult>;
};

const FAILURES = new Set<string>(["invalid", "not_found", "limit", "conflict", "unsupported", "unavailable"]);

export function taskDesktopBridge(): TaskDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  return typeof bridge?.taskAction === "function" ? bridge as TaskDesktopBridge : undefined;
}

/** `pending` is only the server and hydration pass: the first client render already knows which of the other two applies. */
export type TaskDesktopAvailability = "pending" | "available" | "absent";

const subscribeBridge = () => () => {};

export function useTaskDesktopAvailability(): TaskDesktopAvailability {
  return useSyncExternalStore<TaskDesktopAvailability>(subscribeBridge, () => taskDesktopBridge() ? "available" : "absent", () => "pending");
}

/** Creates a task in the repository's first column. Never throws: an IPC failure is `unavailable`. */
export async function createDesktopTask(repositoryId: string, text: string): Promise<TaskActionResult> {
  const bridge = taskDesktopBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  try {
    const result: unknown = await bridge.taskAction(repositoryId, "create", { text });
    if (typeof result === "object" && result !== null) {
      if ((result as { ok?: unknown }).ok === true) return { ok: true };
      const error = (result as { error?: unknown }).error;
      if (typeof error === "string" && FAILURES.has(error)) return { ok: false, error: error as TaskActionError | "unavailable" };
    }
  } catch {
    // Falls through to the fixed unavailable result.
  }
  return { ok: false, error: "unavailable" };
}

/** One short fixed message per failure; the monitor's own wording and any text never reach the panel. */
export function createFailureMessage(error: TaskActionError | "unavailable"): string {
  return error === "limit"
    ? `The board is full: it holds ${TASK_BOUNDS.tasksPerRepository} tasks.`
    : "The task could not be saved.";
}
