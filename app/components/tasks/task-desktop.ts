"use client";

import { useSyncExternalStore } from "react";
import { TASK_BOUNDS, type TaskActionError, type TaskCheck, type TaskGateThreshold, type TaskQueueSchedule, type TaskRun } from "../../../shared/task-contract";
import type { FeatureInput } from "./task-features";

// The only way the renderer changes a task: the desktop preload's `taskAction` bridge (fixed IPC channel
// `pomegr:task-action`). A plain browser has no bridge, so it never mutates tasks and never POSTs.

/** Fixed result of one desktop task action. `unavailable` means the desktop could not reach the monitor. */
export type TaskActionResult = { ok: true; /** Only a create answers it: the new task's ID. */ taskId?: string } | { ok: false; error: TaskActionError | "unavailable" };

export type TaskDesktopBridge = {
  taskAction(repositoryId: string, action: string, payload: unknown): Promise<TaskActionResult>;
  /** Absent on an older desktop build; `startDesktopTask` then answers `unavailable`. */
  taskStart?: (repositoryId: string, taskId: string) => Promise<{ status: TaskStartStatus }>;
  /** Absent on an older desktop build; `openDesktopTaskWorktree` then answers `unavailable`. */
  taskWorktreeOpen?: (repositoryId: string, taskId: string) => Promise<{ status: TaskWorktreeOpenStatus }>;
};

/** Fixed outcome of opening a task's worktree folder; the folder path never reaches the renderer. */
export type TaskWorktreeOpenStatus = "opened" | "not_found" | "invalid" | "unavailable";
const OPEN_STATUSES = new Set<string>(["opened", "not_found", "invalid", "unavailable"]);

/** Fixed outcome of one desktop session start. */
export type TaskStartStatus = "started" | "cancelled" | "unsupported_platform" | "cli_missing" | "plugin_missing" | "not_startable"
  | "unsupported_provider" | "not_found" | "busy" | "invalid" | "unavailable" | "failed" | "gate_held" | "worktree_dirty";
const START_STATUSES = new Set<string>(["started", "cancelled", "unsupported_platform", "cli_missing", "plugin_missing", "not_startable",
  "unsupported_provider", "not_found", "busy", "invalid", "unavailable", "failed", "gate_held", "worktree_dirty"]);

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
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
type TaskActionName = "create" | "update" | "delete" | "move" | "feature_create" | "queue_add" | "queue_remove" | "queue_reorder" | "queue_settings" | "resolve_done" | "resolve_requeue";

/** Sends one fixed task action through the bridge. Never throws: an IPC failure is `unavailable`. */
async function sendTaskAction(repositoryId: string, action: TaskActionName, payload: unknown): Promise<TaskActionResult> {
  const bridge = taskDesktopBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  try {
    const result: unknown = await bridge.taskAction(repositoryId, action, payload);
    if (typeof result === "object" && result !== null) {
      if ((result as { ok?: unknown }).ok === true) {
        const taskId = (result as { taskId?: unknown }).taskId;
        return typeof taskId === "string" && TASK_ID.test(taskId) ? { ok: true, taskId } : { ok: true };
      }
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
export type CreateTaskResult = { ok: true; taskId: string | null } | { ok: false; error: TaskActionError | "unavailable" };

/** `taskId` is the new task's ID when the monitor answered one, else null. */
export async function createDesktopTask(repositoryId: string, input: { text: string } & TaskFieldsInput): Promise<CreateTaskResult> {
  const result = await sendTaskAction(repositoryId, "create", input);
  return result.ok ? { ok: true, taskId: result.taskId ?? null } : result;
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

/** Asks the desktop to open the folder of a task's worktree. Never throws; sends only the two IDs and gets a fixed status. */
export async function openDesktopTaskWorktree(repositoryId: string, id: string): Promise<TaskWorktreeOpenStatus> {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  if (typeof bridge?.taskWorktreeOpen !== "function") return "unavailable";
  try {
    const result: unknown = await bridge.taskWorktreeOpen(repositoryId, id);
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    return typeof status === "string" && OPEN_STATUSES.has(status) ? status as TaskWorktreeOpenStatus : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** `position` is the 0-based index in the destination column counted after the task leaves its place; past the end appends. */
export type TaskMove = { id: string; columnId: string; position: number };

export function moveDesktopTask(repositoryId: string, move: TaskMove): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "move", { id: move.id, columnId: move.columnId, position: move.position });
}

/** Creates a feature named `name` (one line, at most 80 characters). The new feature is read from the committed board. */
export function createDesktopFeature(repositoryId: string, name: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "feature_create", { name });
}

/** A `not_queued` task becomes `queued`; any other state answers `conflict`. */
export function addDesktopQueueTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", { id });
}

/**
 * Gives a task its own start time (`at`, an instant): it becomes `scheduled`, in the queue. `null` takes the time off a
 * scheduled task, which stays `queued`. The monitor answers `invalid` for a time behind the clock or over a year ahead.
 */
export function scheduleDesktopTask(repositoryId: string, id: string, at: string | null): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", at === null ? { id } : { id, at });
}

/** A `queued` or `scheduled` task becomes `not_queued` and loses its start time. */
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

/** Sets the queue's own start and stop times, each an instant or null. It never turns the queue on or off. */
export function setDesktopQueueSchedule(repositoryId: string, schedule: TaskQueueSchedule): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { schedule: { startAt: schedule.startAt, stopAfter: schedule.stopAfter } });
}

/** Accepts a task that needs review, is blocked, or stalled as done; a queue it was holding runs again. */
export function resolveDesktopTaskDone(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_done", { id });
}

/** Sends such a task back to the end of the queue for a new session; its report and session link are cleared. */
export function requeueDesktopTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_requeue", { id });
}

/** One short fixed message per failure; the monitor's own wording and any text never reach the modal. */
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
export const QUEUE_SCHEDULE_FAILURE_MESSAGE = "The schedule could not be changed.";
export const TASK_SCHEDULE_FAILURE_MESSAGE = "The start time could not be saved.";
export const TASK_SCHEDULE_INVALID_MESSAGE = "Choose a time from now up to a year ahead.";
export const QUEUE_ADD_FAILURE_MESSAGE = "The task could not be added to the queue.";
export const QUEUE_REMOVE_FAILURE_MESSAGE = "The task could not be removed from the queue.";
export const RESOLVE_DONE_FAILURE_MESSAGE = "The task could not be marked done.";
export const REQUEUE_FAILURE_MESSAGE = "The task could not be requeued.";
export const FEATURE_ATTACH_FAILURE_MESSAGE = "The task could not join that feature. It may be finished.";

/** One fixed message per feature failure; the monitor's own wording never reaches the modal. */
export function featureFailureMessage(error: TaskActionError | "unavailable"): string {
  if (error === "conflict") return "A feature with this name already exists.";
  if (error === "limit") return `The board holds ${TASK_BOUNDS.featuresPerRepository} features, the most it allows.`;
  return "The feature could not be created.";
}
