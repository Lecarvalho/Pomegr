"use client";

import { useSyncExternalStore } from "react";
import { TASK_BOUNDS, type TaskActionError, type TaskCheck, type TaskRun } from "../../../shared/task-contract";

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

/** Sends one fixed task action through the bridge. Never throws: an IPC failure is `unavailable`. */
async function sendTaskAction(repositoryId: string, action: "create" | "update" | "delete", payload: unknown): Promise<TaskActionResult> {
  const bridge = taskDesktopBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  try {
    const result: unknown = await bridge.taskAction(repositoryId, action, payload);
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

/** A `run` or `doneWhen` key that is present replaces the whole stored field; an absent key leaves it unchanged. */
export type TaskFieldsInput = { run?: TaskRun; doneWhen?: { checks: TaskCheck[]; own: string | null } };

/** Creates a task in the repository's first column. Omitted `run` or `doneWhen` means nothing set. */
export function createDesktopTask(repositoryId: string, input: { text: string } & TaskFieldsInput): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "create", input);
}

/** Updates the given fields of one task; at least one of text, run and doneWhen is present. */
export function updateDesktopTask(repositoryId: string, id: string, patch: { text?: string } & TaskFieldsInput): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "update", { id, ...patch });
}

export function deleteDesktopTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "delete", { id });
}

/** One short fixed message per failure; the monitor's own wording and any text never reach the panel. */
export function createFailureMessage(error: TaskActionError | "unavailable"): string {
  return error === "limit"
    ? `The board is full: it holds ${TASK_BOUNDS.tasksPerRepository} tasks.`
    : "The task could not be saved.";
}

export const UPDATE_FAILURE_MESSAGE = "The change could not be saved.";
export const DELETE_FAILURE_MESSAGE = "The task could not be deleted.";
