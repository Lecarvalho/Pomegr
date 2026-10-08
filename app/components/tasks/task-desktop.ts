"use client";

import { useSyncExternalStore } from "react";
import { TASK_BOUNDS, type TaskActionError, type TaskCheck, type TaskGateThreshold, type TaskRun } from "../../../shared/task-contract";
import type { FeatureInput } from "./task-features";

// The only way the renderer changes a task: the desktop preload's `taskAction` bridge (fixed IPC channel
// `pomegr:task-action`). A plain browser has no bridge, so it never mutates tasks and never POSTs.

/** Fixed result of one desktop task action. `unavailable` means the desktop could not reach the monitor. */
export type TaskActionResult = { ok: true } | { ok: false; error: TaskActionError | "unavailable" };

export type TaskDesktopBridge = {
  taskAction(repositoryId: string, action: string, payload: unknown): Promise<TaskActionResult>;
  /** Absent on an older desktop build; `startDesktopTask` then answers `unavailable`. */
  taskStart?: (repositoryId: string, taskId: string) => Promise<{ status: TaskStartStatus }>;
};

/** Fixed outcome of one desktop session start. */
export type TaskStartStatus = "started" | "cancelled" | "unsupported_platform" | "cli_missing" | "plugin_missing" | "not_startable"
  | "unsupported_provider" | "not_found" | "busy" | "invalid" | "unavailable" | "failed" | "gate_held";
const START_STATUSES = new Set<string>(["started", "cancelled", "unsupported_platform", "cli_missing", "plugin_missing", "not_startable",
  "unsupported_provider", "not_found", "busy", "invalid", "unavailable", "failed", "gate_held"]);

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

/** The fixed actions this surface sends; the monitor validates each record. */
type TaskActionName = "create" | "update" | "delete" | "move" | "column_create" | "column_rename" | "column_reorder" | "column_delete" | "feature_create" | "queue_add" | "queue_remove" | "queue_reorder" | "queue_settings" | "resolve_done" | "resolve_requeue";

/** Sends one fixed task action through the bridge. Never throws: an IPC failure is `unavailable`. */
async function sendTaskAction(repositoryId: string, action: TaskActionName, payload: unknown): Promise<TaskActionResult> {
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

/**
 * A `run` or `doneWhen` key that is present replaces the whole stored field; an absent key leaves it unchanged.
 * `featureId` with no `step` is a new last step, and `featureId: null` detaches the task.
 */
export type TaskFieldsInput = { run?: TaskRun; doneWhen?: { checks: TaskCheck[]; own: string | null } } & FeatureInput;

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

/** Asks the desktop to confirm and start a session for one task. Never throws; sends only the two IDs. */
export async function startDesktopTask(repositoryId: string, id: string): Promise<TaskStartStatus> {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  if (typeof bridge?.taskStart !== "function") return "unavailable";
  try {
    const result: unknown = await bridge.taskStart(repositoryId, id);
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    if (typeof status !== "string") return "unavailable";
    return START_STATUSES.has(status) ? status as TaskStartStatus : "failed";
  } catch {
    return "unavailable";
  }
}

/** `position` is the 0-based index in the destination column counted after the task leaves its place; past the end appends. */
export type TaskMove = { id: string; columnId: string; position: number };

export function moveDesktopTask(repositoryId: string, move: TaskMove): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "move", { id: move.id, columnId: move.columnId, position: move.position });
}

/** Appends a column named `name` (at most 40 characters) after the last one. */
export function createDesktopColumn(repositoryId: string, name: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "column_create", { name });
}

export function renameDesktopColumn(repositoryId: string, id: string, name: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "column_rename", { id, name });
}

/** `position` is the 0-based target index among the columns. */
export function reorderDesktopColumn(repositoryId: string, id: string, position: number): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "column_reorder", { id, position });
}

/** The monitor refuses while the column holds tasks and for the last column. */
export function deleteDesktopColumn(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "column_delete", { id });
}

/** Creates a feature named `name` (one line, at most 80 characters). The new feature is read from the committed board. */
export function createDesktopFeature(repositoryId: string, name: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "feature_create", { name });
}

/** A `not_queued` task becomes `queued`; any other state answers `conflict`. */
export function addDesktopQueueTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", { id });
}

/** A `queued` task becomes `not_queued`. */
export function removeDesktopQueueTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_remove", { id });
}

/**
 * Moves a queued task of a feature to `step`, from 1 to the feature's highest step + 1 (a new last step). The
 * monitor renumbers steps densely and answers `conflict` for a step whose tasks are all done.
 */
export function reorderDesktopQueueTask(repositoryId: string, id: string, step: number): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_reorder", { id, step });
}

/**
 * Turns the repository's queue on or off. Turning it on again while it is paused retries the start that failed; the
 * monitor holds the status, so the board only shows it once it has committed.
 */
export function setDesktopQueue(repositoryId: string, on: boolean): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { on });
}

/** Sets the usage, in percent of the five-hour window, above which no new session starts. The monitor holds the value. */
export function setDesktopGateThreshold(repositoryId: string, threshold: TaskGateThreshold): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { threshold });
}

/** Accepts a task that needs review, is blocked, or stalled as done; a queue it was holding runs again. */
export function resolveDesktopTaskDone(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_done", { id });
}

/** Sends such a task back to the end of the queue for a new session; its report and session link are cleared. */
export function requeueDesktopTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_requeue", { id });
}

/** One short fixed message per failure; the monitor's own wording and any text never reach the panel. */
export function createFailureMessage(error: TaskActionError | "unavailable"): string {
  return error === "limit"
    ? `The board is full: it holds ${TASK_BOUNDS.tasksPerRepository} tasks.`
    : "The task could not be saved.";
}

export const UPDATE_FAILURE_MESSAGE = "The change could not be saved.";
export const DELETE_FAILURE_MESSAGE = "The task could not be deleted.";
export const MOVE_FAILURE_MESSAGE = "The card could not be moved.";
export const QUEUE_REORDER_FAILURE_MESSAGE = "The task could not be moved to that step.";
export const QUEUE_SETTINGS_FAILURE_MESSAGE = "The queue setting could not be changed.";
export const GATE_THRESHOLD_FAILURE_MESSAGE = "The start threshold could not be changed.";
export const QUEUE_ADD_FAILURE_MESSAGE = "The task could not be added to the queue.";
export const QUEUE_REMOVE_FAILURE_MESSAGE = "The task could not be removed from the queue.";
export const RESOLVE_DONE_FAILURE_MESSAGE = "The task could not be marked done.";
export const REQUEUE_FAILURE_MESSAGE = "The task could not be requeued.";
export const FEATURE_ATTACH_FAILURE_MESSAGE = "The task could not join that feature. It may be finished.";
export const COLUMN_NAME_REQUIRED_MESSAGE = "The column needs a name.";

export type ColumnAction = "create" | "rename" | "reorder" | "delete";

/** One fixed message per column action; the monitor's own wording never reaches the board. */
export function columnFailureMessage(action: ColumnAction, error: TaskActionError | "unavailable"): string {
  if (action === "create") return error === "limit" ? `The board is full: it holds ${TASK_BOUNDS.columnsPerRepository} columns.` : "The column could not be added.";
  if (action === "rename") return "The column could not be renamed.";
  if (action === "reorder") return "The column could not be moved.";
  return error === "conflict" ? "The column could not be deleted. It must be empty, and a board keeps one column." : "The column could not be deleted.";
}

/** One fixed message per feature failure; the monitor's own wording never reaches the panel. */
export function featureFailureMessage(error: TaskActionError | "unavailable"): string {
  if (error === "conflict") return "A feature with this name already exists.";
  if (error === "limit") return `The board holds ${TASK_BOUNDS.featuresPerRepository} features, the most it allows.`;
  return "The feature could not be created.";
}
