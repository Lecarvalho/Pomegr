"use client";

import { useSyncExternalStore } from "react";
import {
  TASK_HOME_ATTENTION_STATES, TASK_HOME_BOUNDS, TASK_ID_PATTERN, TASK_QUEUE_PAUSE_REASONS, TASK_QUEUE_STATUSES, TASK_REPOSITORY_ID_PATTERN, createEmptyTaskHome,
  type TaskBoardReadiness, type TaskHome, type TaskHomeAttention, type TaskHomeAttentionState, type TaskHomeBoard, type TaskQueuePauseReason, type TaskQueueStatus,
} from "../shared/task-contract";

// Client for the Tasks home (GET /api/tasks?view=home).

const LOADING_DELAY_MS = 1_500;
const RETRY_DELAY_MS = 5_000;
const READY_DELAY_MS = 10_000;
const COLUMN_COUNT = 5;
const READINESS = new Set<TaskBoardReadiness>(["ready", "loading", "unavailable", "desktop_only"]);

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const repositoryId = (value: unknown): value is string => typeof value === "string" && TASK_REPOSITORY_ID_PATTERN.test(value);
const taskId = (value: unknown): value is string => typeof value === "string" && TASK_ID_PATTERN.test(value);

function parseBoard(value: unknown): TaskHomeBoard | null {
  const board = record(value);
  if (!board || !repositoryId(board.repositoryId)) return null;
  const unavailable: TaskHomeBoard = { repositoryId: board.repositoryId, readiness: "unavailable", counts: [], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: null };
  const queue = record(board.queue);
  if (board.readiness !== "ready" || !Array.isArray(board.counts) || board.counts.length !== COLUMN_COUNT || !board.counts.every(count) || !count(board.openFeatures)
    || !queue || !TASK_QUEUE_STATUSES.includes(queue.status as TaskQueueStatus)
    || !(board.updatedAt === null || (typeof board.updatedAt === "string" && board.updatedAt.length <= 40 && Number.isFinite(Date.parse(board.updatedAt))))) return unavailable;
  return {
    repositoryId: board.repositoryId, readiness: "ready", counts: board.counts, openFeatures: board.openFeatures,
    queue: {
      status: queue.status as TaskQueueStatus,
      blockedBy: taskId(queue.blockedBy) ? queue.blockedBy : null,
      pauseReason: queue.status === "paused" && TASK_QUEUE_PAUSE_REASONS.includes(queue.pauseReason as TaskQueuePauseReason) ? queue.pauseReason as TaskQueuePauseReason : null,
    },
    updatedAt: board.updatedAt,
  };
}

function parseAttention(value: unknown): TaskHomeAttention | null {
  const item = record(value);
  return item && repositoryId(item.repositoryId) && taskId(item.taskId) && TASK_HOME_ATTENTION_STATES.includes(item.state as TaskHomeAttentionState)
    && typeof item.title === "string" && item.title.length <= TASK_HOME_BOUNDS.titleLength
    ? { repositoryId: item.repositoryId, taskId: item.taskId, title: item.title, state: item.state as TaskHomeAttentionState }
    : null;
}

/** Validates a monitor answer. A home that is not ready carries no content. */
export function parseTaskHome(value: unknown): TaskHome | null {
  const body = record(value);
  if (!body || body.version !== 1 || !READINESS.has(body.readiness as TaskBoardReadiness)) return null;
  const readiness = body.readiness as TaskBoardReadiness;
  if (readiness !== "ready") return createEmptyTaskHome(readiness);
  if (!Array.isArray(body.boards) || body.boards.length > TASK_HOME_BOUNDS.boards || !Array.isArray(body.attention) || body.attention.length > TASK_HOME_BOUNDS.attention
    || !count(body.attentionTotal)) return null;
  const boards = body.boards.map(parseBoard);
  const attention = body.attention.map(parseAttention);
  if (boards.includes(null) || attention.includes(null)) return null;
  return { version: 1, readiness, boards: boards as TaskHomeBoard[], attention: attention as TaskHomeAttention[], attentionTotal: Math.max(body.attentionTotal, attention.length) };
}

function isVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

let data: TaskHome = createEmptyTaskHome("loading");
const listeners = new Set<() => void>();
let timer: number | null = null;
let controller: AbortController | null = null;
let wake: (() => void) | null = null;

function publish(next: TaskHome) {
  data = next;
  for (const listener of listeners) listener();
}

function schedule() {
  if (!listeners.size || typeof window === "undefined" || timer !== null || data.readiness === "desktop_only") return;
  if (!isVisible()) {
    if (wake) return;
    wake = () => {
      if (!isVisible() || !wake) return;
      document.removeEventListener("visibilitychange", wake);
      wake = null;
      void poll();
    };
    document.addEventListener("visibilitychange", wake);
    return;
  }
  const delay = data.readiness === "loading" ? LOADING_DELAY_MS : data.readiness === "unavailable" ? RETRY_DELAY_MS : READY_DELAY_MS;
  timer = window.setTimeout(() => { timer = null; void poll(); }, delay);
}

async function poll() {
  if (!listeners.size || controller) return;
  const request = controller = new AbortController();
  try {
    const response = await fetch("/api/tasks?view=home", { cache: "no-store", signal: request.signal });
    if (request.signal.aborted) return;
    if (response.status === 403 || response.status === 404) publish(createEmptyTaskHome("desktop_only"));
    else {
      const next = response.ok ? parseTaskHome(await response.json().catch(() => null)) : null;
      if (request.signal.aborted) return;
      if (!next) throw new Error("task home request failed");
      publish(next);
    }
  } catch {
    // The last committed home stays until a complete answer replaces it.
    if (!request.signal.aborted && data.readiness === "loading") publish(createEmptyTaskHome("unavailable"));
  } finally {
    if (controller === request) controller = null;
  }
  schedule();
}

function stop() {
  controller?.abort();
  controller = null;
  if (timer !== null) { window.clearTimeout(timer); timer = null; }
  if (wake && typeof document !== "undefined") { document.removeEventListener("visibilitychange", wake); wake = null; }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") void poll();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) stop();
  };
}

const getSnapshot = () => data;

export function useTaskHome(): TaskHome {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetTaskHomeStoreForTests() {
  listeners.clear();
  stop();
  data = createEmptyTaskHome("loading");
}
