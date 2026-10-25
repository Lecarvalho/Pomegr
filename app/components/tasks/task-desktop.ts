"use client";

import { useSyncExternalStore } from "react";
import { TASK_BOUNDS, type TaskActionError, type TaskCheck, type TaskGateThreshold, type TaskQueueSchedule, type TaskRun } from "../../../shared/task-contract";
import { clientAccessMode, useClientAccess } from "../../hooks/ClientAccessContext";
import type { FeatureInput } from "./task-features";
import { parseScorecard, type ScorecardAnswer } from "./scorecard-model";
import { postPairedTaskAction, postPairedTaskLog, postPairedTaskStart } from "./task-paired";

// The two ways a client changes a task.

export type TaskActionResult = { ok: true; /** Only a create answers it: the new task's ID. */ taskId?: string } | { ok: false; error: TaskActionError | "unavailable" };

export type TaskDesktopBridge = {
  taskAction(repositoryId: string, action: string, payload: unknown): Promise<TaskActionResult>;
  taskStart?: (repositoryId: string, taskId: string, separateWorktree?: true) => Promise<{ status: TaskStartStatus }>;
  taskReviewStart?: (repositoryId: string, taskId: string) => Promise<{ status: TaskStartStatus }>;
  taskWorktreeOpen?: (repositoryId: string, taskId: string) => Promise<{ status: TaskWorktreeOpenStatus }>;
  taskFeature?: (repositoryId: string, featureId: string) => Promise<unknown>;
  taskScorecard?: (repositoryId: string) => Promise<unknown>;
  taskLog?: (repositoryId: string) => Promise<unknown>;
};

/** Fixed outcome of opening a task's worktree folder. */
export type TaskWorktreeOpenStatus = "opened" | "not_found" | "invalid" | "unavailable";
const OPEN_STATUSES = new Set<string>(["opened", "not_found", "invalid", "unavailable"]);

export type TaskStartStatus = "started" | "cancelled" | "unsupported_platform" | "cli_missing" | "plugin_missing" | "not_startable"
  | "unsupported_provider" | "not_found" | "busy" | "invalid" | "unavailable" | "failed" | "gate_held" | "worktree_dirty" | "tree_dirty";
const START_STATUSES = new Set<string>(["started", "cancelled", "unsupported_platform", "cli_missing", "plugin_missing", "not_startable",
  "unsupported_provider", "not_found", "busy", "invalid", "unavailable", "failed", "gate_held", "worktree_dirty", "tree_dirty"]);

const TASK_ID = /^T-[1-9][0-9]{0,8}$/u;
const FAILURES = new Set<string>(["invalid", "not_found", "limit", "conflict", "unsupported", "unavailable"]);

export function taskDesktopBridge(): TaskDesktopBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  return typeof bridge?.taskAction === "function" ? bridge as TaskDesktopBridge : undefined;
}

export type TaskDesktopAvailability = "pending" | "available" | "absent";

const subscribeBridge = () => () => {};

export function useTaskDesktopAvailability(): TaskDesktopAvailability {
  return useSyncExternalStore<TaskDesktopAvailability>(subscribeBridge, () => taskDesktopBridge() ? "available" : "absent", () => "pending");
}

/** Only the desktop app reads the scorecard; decided at first render, like the other desktop-only actions. */
export function useScorecardAvailability(): TaskDesktopAvailability {
  return useSyncExternalStore<TaskDesktopAvailability>(subscribeBridge, () => typeof taskDesktopBridge()?.taskScorecard === "function" ? "available" : "absent", () => "pending");
}

export function useTaskLogAvailability(): "desktop" | "paired" | "absent" {
  const desktop = useSyncExternalStore(subscribeBridge, () => typeof taskDesktopBridge()?.taskLog === "function", () => false);
  const { mode } = useClientAccess();
  return desktop ? "desktop" : mode === "lan" ? "paired" : "absent";
}

export type TaskEditAvailability = "pending" | "desktop" | "paired" | "absent";

export function useTaskEditAvailability(): TaskEditAvailability {
  const desktop = useTaskDesktopAvailability();
  const { mode } = useClientAccess();
  if (desktop === "available") return "desktop";
  if (desktop === "pending" || mode === "unknown") return "pending";
  return mode === "lan" ? "paired" : "absent";
}

type TaskActionName = "create" | "update" | "delete" | "move" | "feature_create" | "feature_update" | "feature_delete" | "queue_add" | "queue_remove" | "queue_group" | "queue_ungroup" | "queue_settings" | "resolve_done" | "resolve_requeue" | "session_assign" | "session_unassign" | "after_set";

/** Sends one fixed task action through the bridge, or from a paired device through its route. */
async function sendTaskAction(repositoryId: string, action: TaskActionName, payload: unknown): Promise<TaskActionResult> {
  const bridge = taskDesktopBridge();
  // A paired device may create a feature from a name but never edits or deletes one: neither has a paired route.
  if (!bridge && (action === "feature_update" || action === "feature_delete" || clientAccessMode() !== "lan")) return { ok: false, error: "unavailable" };
  try {
    const result: unknown = bridge ? await bridge.taskAction(repositoryId, action, payload) : await postPairedTaskAction(repositoryId, action, payload);
    if (typeof result === "object" && result !== null) {
      if ((result as { ok?: unknown }).ok === true) {
        const taskId = (result as { taskId?: unknown }).taskId;
        return typeof taskId === "string" && TASK_ID.test(taskId) ? { ok: true, taskId } : { ok: true };
      }
      const error = (result as { error?: unknown }).error;
      if (typeof error === "string" && FAILURES.has(error)) return { ok: false, error: error as TaskActionError | "unavailable" };
    }
  } catch {
  }
  return { ok: false, error: "unavailable" };
}

export type TaskFieldsInput = { run?: TaskRun; completeWhen?: { checks: TaskCheck[]; own: string | null } } & FeatureInput;

export type CreateTaskResult = { ok: true; taskId: string | null } | { ok: false; error: TaskActionError | "unavailable" };

/** `taskId` is the new task's ID when the monitor answered one, else null. */
export async function createDesktopTask(repositoryId: string, input: { text: string } & TaskFieldsInput): Promise<CreateTaskResult> {
  const result = await sendTaskAction(repositoryId, "create", input);
  return result.ok ? { ok: true, taskId: result.taskId ?? null } : result;
}

export function updateDesktopTask(repositoryId: string, id: string, patch: { text?: string } & TaskFieldsInput): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "update", { id, ...patch });
}

export function deleteDesktopTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "delete", { id });
}

/** Confirms on the requesting device, then asks the desktop to start one task. */
export async function startDesktopTask(repositoryId: string, id: string, separateWorktree = false): Promise<TaskStartStatus> {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  const native = typeof bridge?.taskStart === "function";
  if (!native && (bridge || clientAccessMode() !== "lan")) return "unavailable";
  try {
    if (!native && !window.confirm(`Start task ${id}${separateWorktree ? " in a separate worktree" : ""}?\n\nThe session runs in a new terminal on the computer running Pomegr, using the task's saved Run on settings.${separateWorktree ? " The worktree starts from the current commit; uncommitted changes are left out and remain untouched." : ""}`)) return "cancelled";
    const result: unknown = native
      ? await (separateWorktree ? bridge!.taskStart!(repositoryId, id, true) : bridge!.taskStart!(repositoryId, id))
      : await postPairedTaskStart(repositoryId, id, separateWorktree);
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    if (typeof status !== "string") return "unavailable";
    if (native && typeof (bridge as unknown as { terminal?: unknown }).terminal === "function" && (status === "started" || status === "failed")) {
      window.dispatchEvent(new CustomEvent("pomegr-task-terminal-open", { detail: { repositoryId, taskId: id, status } }));
    }
    return START_STATUSES.has(status) ? status as TaskStartStatus : "failed";
  } catch {
    return "unavailable";
  }
}

/** Starts an owner-confirmed review session for one task on the desktop. */
export async function startDesktopReview(repositoryId: string, id: string): Promise<TaskStartStatus> {
  const bridge = taskDesktopBridge();
  if (typeof bridge?.taskReviewStart !== "function") return "unavailable";
  try {
    const result: unknown = await bridge.taskReviewStart(repositoryId, id);
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    if (typeof status !== "string") return "unavailable";
    return START_STATUSES.has(status) ? status as TaskStartStatus : "failed";
  } catch {
    return "unavailable";
  }
}

/** Asks the desktop to open the folder of a task's worktree. */
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

/** `group` says what a card of a parallel group does: "block" moves its whole group, "leave" takes the card out of it. */
export type TaskMove = { id: string; columnId: string; position: number; group?: "block" | "leave" };

export function moveDesktopTask(repositoryId: string, move: TaskMove): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "move", { id: move.id, columnId: move.columnId, position: move.position, ...(move.group ? { group: move.group } : {}) });
}

/** A name alone is the inline form's create; the Feature modal adds the two details it holds. */
export function createDesktopFeature(repositoryId: string, name: string, details?: { description?: string; appVersion?: string }): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "feature_create", { name, ...details });
}

/** An absent field stays as stored; a null one clears it. `done` marks the feature done or reopens it. */
export type FeaturePatch = { name?: string; description?: string | null; appVersion?: string | null; done?: boolean };

export function updateDesktopFeature(repositoryId: string, id: string, patch: FeaturePatch): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "feature_update", { id, ...patch });
}

/** Deletes a feature; its tasks stay on the board with no feature. The monitor refuses while one of them has started and is not done. */
export function deleteDesktopFeature(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "feature_delete", { id });
}

export type FeatureDetails = { description: string | null; appVersion: string | null };

/** The desktop-only read of one feature's description and app version. Any answer but two strings or nulls is a failure. */
export async function readDesktopFeature(repositoryId: string, id: string): Promise<({ ok: true } & FeatureDetails) | { ok: false }> {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { pomegrDesktop?: Partial<TaskDesktopBridge> }).pomegrDesktop;
  if (typeof bridge?.taskFeature !== "function") return { ok: false };
  try {
    const result = await bridge.taskFeature(repositoryId, id);
    if (typeof result !== "object" || result === null || (result as { ok?: unknown }).ok !== true) return { ok: false };
    const { description, appVersion } = result as { description?: unknown; appVersion?: unknown };
    if ((typeof description !== "string" && description !== null) || (typeof appVersion !== "string" && appVersion !== null)) return { ok: false };
    return { ok: true, description, appVersion };
  } catch {
    return { ok: false };
  }
}

/** The desktop-only read of a repository's scorecard. Any malformed answer is a failure. */
export async function readDesktopScorecard(repositoryId: string): Promise<ScorecardAnswer> {
  const bridge = taskDesktopBridge();
  if (typeof bridge?.taskScorecard !== "function") return { ok: false };
  try {
    const result = await bridge.taskScorecard(repositoryId);
    if (typeof result !== "object" || result === null || (result as { ok?: unknown }).ok !== true) return { ok: false };
    const scorecard = parseScorecard((result as { scorecard?: unknown }).scorecard);
    return scorecard ? { ok: true, scorecard } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export const TASK_LOG_LABELS = {
  started: "Started", assigned: "Assigned to a session", review: "Reported complete", blocked: "Blocked", requeued: "Requeued", done: "Marked done",
  stalled: "Session ended without a report", recovered: "Session working again", checks_passed: "CI passed", checks_failed: "CI failed", merged: "Merged",
  review_started: "Review started", review_passed: "Review passed", review_failed: "Review failed",
  grant_start: "Started by Aril under a grant", grant_review: "Review started by Aril under a grant",
} as const;
export type TaskLog = { entries: { id: number; task: string; kind: keyof typeof TASK_LOG_LABELS; at: number; pullRequest: number | null }[]; more: boolean; arilCursor: number };
export type TaskLogAnswer = { ok: true; log: TaskLog } | { ok: false };

/** Re-bounds the log from desktop main, through the bridge or paired route; never acknowledges entries. */
export async function readDesktopTaskLog(repositoryId: string): Promise<TaskLogAnswer> {
  const bridge = taskDesktopBridge();
  const native = typeof bridge?.taskLog === "function";
  if (!native && clientAccessMode() !== "lan") return { ok: false };
  try {
    const result = native ? await bridge!.taskLog!(repositoryId) : await postPairedTaskLog(repositoryId);
    if (!result || typeof result !== "object" || Array.isArray(result) || (result as { ok?: unknown }).ok !== true) return { ok: false };
    const log = (result as { log?: TaskLog }).log;
    if (!log || Array.isArray(log) || !Array.isArray(log.entries) || log.entries.length > 200 || typeof log.more !== "boolean"
      || !Number.isSafeInteger(log.arilCursor) || log.arilCursor < 0) return { ok: false };
    const entries: TaskLog["entries"] = [];
    for (const entry of log.entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Number.isSafeInteger(entry.id) || entry.id <= 0
        || typeof entry.task !== "string" || !/^T-[1-9]\d*$/u.test(entry.task) || typeof entry.kind !== "string" || !Object.hasOwn(TASK_LOG_LABELS, entry.kind)
        || !Number.isSafeInteger(entry.at) || (entry.pullRequest !== null && (!Number.isSafeInteger(entry.pullRequest) || entry.pullRequest <= 0))) return { ok: false };
      const { id, task, kind, at, pullRequest } = entry;
      entries.push({ id, task, kind, at, pullRequest });
    }
    return { ok: true, log: { entries, more: log.more, arilCursor: log.arilCursor } };
  } catch { return { ok: false }; }
}

export function addDesktopQueueTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", { id });
}

export function scheduleDesktopTask(repositoryId: string, id: string, at: string | null): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", at === null ? { id } : { id, at });
}

export function removeDesktopQueueTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_remove", { id });
}

/** Puts the waiting cards in one parallel group: the group of the first one, or a new group. */
export function groupDesktopTasks(repositoryId: string, ids: readonly string[]): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_group", { ids: [...ids] });
}

/** Takes each waiting card out of its parallel group. */
export function ungroupDesktopTasks(repositoryId: string, ids: readonly string[]): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_ungroup", { ids: [...ids] });
}

/** Queues every card of the task's parallel group that is not queued yet, in the order the plan holds. */
export function queueDesktopGroup(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_add", { id, group: "block" });
}

/** Replaces what the task runs after; an empty list clears it. */
export function setDesktopTaskAfter(repositoryId: string, id: string, after: readonly string[]): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "after_set", { id, after: [...after] });
}

export function setDesktopQueue(repositoryId: string, on: boolean): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { on });
}

export function setDesktopGateThreshold(repositoryId: string, threshold: TaskGateThreshold): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { threshold });
}

/** Sets the queue's own start and stop times, each an instant or null. */
export function setDesktopQueueSchedule(repositoryId: string, schedule: TaskQueueSchedule): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "queue_settings", { schedule: { startAt: schedule.startAt, stopAfter: schedule.stopAfter } });
}

export function resolveDesktopTaskDone(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_done", { id });
}

export function assignDesktopTaskSession(repositoryId: string, id: string, sessionId: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "session_assign", { id, sessionId });
}

export function unassignDesktopTaskSession(repositoryId: string, id: string, sessionId: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "session_unassign", { id, sessionId });
}

export function requeueDesktopTask(repositoryId: string, id: string): Promise<TaskActionResult> {
  return sendTaskAction(repositoryId, "resolve_requeue", { id });
}

/** One short fixed message per failure. */
export function createFailureMessage(error: TaskActionError | "unavailable"): string {
  return error === "limit"
    ? `The board is full: it holds ${TASK_BOUNDS.tasksPerRepository} tasks.`
    : "The task could not be saved.";
}

export const UPDATE_FAILURE_MESSAGE = "The change could not be saved.";
export const DELETE_FAILURE_MESSAGE = "The task could not be deleted.";
export const MOVE_FAILURE_MESSAGE = "The card could not be moved.";
export const QUEUE_GROUP_FAILURE_MESSAGE = "The cards could not be put in a parallel group.";
export const QUEUE_GROUP_LIMIT_MESSAGE = "A parallel group holds at most 16 tasks.";
export const QUEUE_UNGROUP_FAILURE_MESSAGE = "The parallel group could not be changed.";
export const QUEUE_SETTINGS_FAILURE_MESSAGE = "The queue setting could not be changed.";
export const GATE_THRESHOLD_FAILURE_MESSAGE = "The start threshold could not be changed.";
export const QUEUE_SCHEDULE_FAILURE_MESSAGE = "The schedule could not be changed.";
export const TASK_SCHEDULE_FAILURE_MESSAGE = "The start time could not be saved.";
export const TASK_SCHEDULE_INVALID_MESSAGE = "Choose a time from now up to a year ahead.";
export const QUEUE_ADD_FAILURE_MESSAGE = "The task could not be added to the queue.";
export const QUEUE_GROUP_ADD_FAILURE_MESSAGE = "The group could not be added to the queue.";
export const QUEUE_REMOVE_FAILURE_MESSAGE = "The task could not be removed from the queue.";
export const RESOLVE_DONE_FAILURE_MESSAGE = "The task could not be marked done.";
export const REQUEUE_FAILURE_MESSAGE = "The task could not be requeued.";
export const ASSIGN_FAILURE_MESSAGE = "The session could not be assigned.";
export const ASSIGN_LIMIT_MESSAGE = "The task or the session holds the most assignments it can.";
export const UNASSIGN_FAILURE_MESSAGE = "The session could not be unassigned.";
export const FEATURE_ATTACH_FAILURE_MESSAGE = "The task could not join that feature. It may be finished.";

/** One fixed message per feature failure. */
export function featureFailureMessage(error: TaskActionError | "unavailable"): string {
  if (error === "conflict") return "A feature with this name already exists.";
  if (error === "limit") return `The board holds ${TASK_BOUNDS.featuresPerRepository} features, the most it allows.`;
  return "The feature could not be created.";
}

// What a create that also queues or starts left undone, for the Task modal that then opens on the new task.
export type CreateFollowUp = { start: TaskStartStatus } | { failure: string };
const createFollowUps = new Map<string, CreateFollowUp>();

export function rememberCreateFollowUp(repositoryId: string, taskId: string, followUp: CreateFollowUp): void {
  createFollowUps.set(`${repositoryId}:${taskId}`, followUp);
}

export function takeCreateFollowUp(repositoryId: string, taskId: string): CreateFollowUp | null {
  const key = `${repositoryId}:${taskId}`;
  const followUp = createFollowUps.get(key) ?? null;
  createFollowUps.delete(key);
  return followUp;
}
