"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { Task, TaskBoard, TaskCheck, TaskState } from "../shared/task-contract";

// Client for the committed task board (GET /api/tasks). Task text is user-authored content, so it
// lives only in this module's memory: never in browser storage, a URL, or the notification layer.

const LOADING_DELAY_MS = 1_500;
const RETRY_DELAY_MS = 5_000;
const READY_DELAY_MS = 10_000;

// Documented per-repository bounds (AGENTS.md "Task board and dispatch"). A body past them is malformed.
const LIMITS = { tasks: 500, columns: 12, features: 50, text: 4_000, own: 500, columnName: 40, featureName: 80, blockReason: 200, model: 120, label: 200 };

const READINESS = new Set<TaskBoard["readiness"]>(["ready", "loading", "unavailable", "desktop_only"]);
const CHECKS = new Set<TaskCheck>(["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"]);
const STATES = new Set<TaskState>(["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const PROVIDERS = new Set(["claude", "codex"]);
const QUEUE_STATUSES = new Set(["idle", "running", "blocked", "paused"]);

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}
function text(value: unknown, max: number, { empty = false } = {}): value is string {
  return typeof value === "string" && value.length <= max && (empty || value.length > 0);
}
function nullableText(value: unknown, max: number): value is string | null {
  return value === null || text(value, max, { empty: true });
}
function count(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= Number.MAX_SAFE_INTEGER;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function listOf<T>(value: unknown, max: number, valid: (entry: unknown) => entry is T): T[] | null {
  return Array.isArray(value) && value.length <= max && value.every(valid) ? value : null;
}

function validTask(value: unknown): value is Task {
  const task = record(value);
  if (!task) return false;
  const run = record(task.run);
  const doneWhen = record(task.doneWhen);
  const session = task.session === null ? null : record(task.session);
  const report = task.report === null ? null : record(task.report);
  // A null session or report is valid; a present value that is not an object is not.
  if (!run || !doneWhen || (task.session !== null && !session) || (task.report !== null && !report)) return false;
  const results = report ? listOf(report.results, CHECKS.size, (entry): entry is Json => {
    const result = record(entry);
    return Boolean(result) && CHECKS.has(result!.check as TaskCheck) && typeof result!.passed === "boolean";
  }) : [];
  const checks = listOf(doneWhen.checks, CHECKS.size, (entry): entry is TaskCheck => CHECKS.has(entry as TaskCheck));
  return typeof task.id === "string" && /^T-[1-9]\d*$/u.test(task.id)
    && text(task.text, LIMITS.text) && text(task.columnId, LIMITS.label) && count(task.position, 0)
    && (task.featureId === null || text(task.featureId, LIMITS.label)) && (task.step === null || count(task.step, 1))
    && (run.provider === null || PROVIDERS.has(run.provider as string)) && nullableText(run.model, LIMITS.model)
    && (run.effort === null || EFFORTS.has(run.effort as string))
    && checks !== null && nullableText(doneWhen.own, LIMITS.own)
    && STATES.has(task.state as TaskState) && (task.scheduledAt === null || timestamp(task.scheduledAt))
    && (session === null || (text(session.id, LIMITS.label) && nullableText(session.title, LIMITS.label) && text(session.state, 40) && nullableText(session.observedModel, LIMITS.model)))
    && (report === null || (timestamp(report.at) && results !== null && nullableText(report.blockReason, LIMITS.blockReason)))
    && timestamp(task.createdAt) && timestamp(task.updatedAt);
}

function validColumn(value: unknown): value is TaskBoard["columns"][number] {
  const column = record(value);
  return Boolean(column) && text(column!.id, LIMITS.label) && text(column!.name, LIMITS.columnName) && count(column!.position, 0);
}
function validFeature(value: unknown): value is TaskBoard["features"][number] {
  const feature = record(value);
  return Boolean(feature) && text(feature!.id, LIMITS.label) && text(feature!.name, LIMITS.featureName) && typeof feature!.done === "boolean";
}

function contentFreeBoard(repositoryId: string, readiness: TaskBoard["readiness"]): TaskBoard {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null } };
}

/**
 * Validates a monitor answer for one repository. Anything not "ready" is reduced to its readiness:
 * task content is never kept from a board that is loading, unavailable, or denied.
 */
export function parseTaskBoard(value: unknown, repositoryId: string): TaskBoard | null {
  const body = record(value);
  if (!body || body.version !== 1 || !READINESS.has(body.readiness as TaskBoard["readiness"]) || body.repositoryId !== repositoryId) return null;
  const readiness = body.readiness as TaskBoard["readiness"];
  if (readiness !== "ready") return contentFreeBoard(repositoryId, readiness);
  const columns = listOf(body.columns, LIMITS.columns, validColumn);
  const features = listOf(body.features, LIMITS.features, validFeature);
  const tasks = listOf(body.tasks, LIMITS.tasks, validTask);
  const queue = record(body.queue);
  if (!columns || !features || !tasks || !queue || !QUEUE_STATUSES.has(queue.status as string) || !nullableText(queue.blockedBy, LIMITS.label)) return null;
  return { version: 1, readiness, repositoryId, columns, features, tasks, queue: { status: queue.status as TaskBoard["queue"]["status"], blockedBy: queue.blockedBy } };
}

function isVisible() {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * One reference-counted store per repository. It reads the monitor's committed task store (never
 * triggers acquisition) and polls while visible: quickly while loading or unavailable, slowly once
 * ready, never once the answer is desktop_only. A failed read keeps the last resolved board; only a
 * still-loading placeholder downgrades to unavailable, so a resolved board is never retracted.
 */
class TasksStore {
  private data: TaskBoard;
  private readonly listeners = new Set<() => void>();
  private consumers = 0;
  private timer: number | null = null;
  private controller: AbortController | null = null;
  private request: Promise<void> | null = null;
  private again = false;
  private visibilityWake: (() => void) | null = null;

  constructor(private readonly repositoryId: string) { this.data = contentFreeBoard(repositoryId, "loading"); }

  getSnapshot = () => this.data;
  getServerSnapshot = () => this.data;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.consumers += 1;
    if (this.consumers === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      this.consumers = Math.max(0, this.consumers - 1);
      if (!this.consumers) this.stop();
    };
  };

  dispose() { this.listeners.clear(); this.consumers = 0; this.stop(); }

  private publish(next: TaskBoard) {
    this.data = next;
    for (const listener of this.listeners) listener();
  }

  private nextDelay(): number | null {
    if (!isVisible()) return null;
    if (this.data.readiness === "desktop_only") return null;
    if (this.data.readiness === "loading") return LOADING_DELAY_MS;
    return this.data.readiness === "unavailable" ? RETRY_DELAY_MS : READY_DELAY_MS;
  }

  private schedule() {
    if (!this.consumers || typeof window === "undefined") return;
    const delay = this.nextDelay();
    if (delay === null) { if (!isVisible()) this.armVisibilityWake(); return; }
    if (this.timer !== null) return;
    this.timer = window.setTimeout(() => { this.timer = null; void this.poll(); }, delay);
  }

  private armVisibilityWake() {
    if (this.visibilityWake || typeof document === "undefined") return;
    this.visibilityWake = () => {
      if (!isVisible() || !this.consumers) return;
      document.removeEventListener("visibilitychange", this.visibilityWake!);
      this.visibilityWake = null;
      void this.poll();
    };
    document.addEventListener("visibilitychange", this.visibilityWake);
  }

  private async poll() {
    if (!this.consumers) return;
    await this.refresh();
    this.schedule();
  }

  /** Refetches now. A call made while a read is in flight triggers one more read after it settles. */
  refresh = async (): Promise<void> => {
    if (this.request) { this.again = true; return this.request; }
    if (!this.consumers) return;
    const controller = new AbortController();
    this.controller = controller;
    const request = this.request = (async () => {
      try {
        const response = await fetch(`/api/tasks?${new URLSearchParams({ repositoryId: this.repositoryId })}`, { cache: "no-store", signal: controller.signal });
        if (controller.signal.aborted) return;
        // The proxy answers 403 (and a LAN gateway 404) to a client that is not on this computer.
        if (response.status === 403 || response.status === 404) { this.publish(contentFreeBoard(this.repositoryId, "desktop_only")); return; }
        if (!response.ok) throw new Error("task board request failed");
        const next = parseTaskBoard(await response.json().catch(() => null), this.repositoryId);
        if (controller.signal.aborted) return;
        if (!next) throw new Error("invalid task board response");
        this.publish(next);
      } catch {
        if (!controller.signal.aborted && this.data.readiness === "loading") this.publish(contentFreeBoard(this.repositoryId, "unavailable"));
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    })();
    await request;
    if (this.request === request) this.request = null;
    if (this.again) { this.again = false; await this.refresh(); }
  };

  private start() {
    if (typeof window === "undefined") return;
    void this.poll();
  }

  private stop() {
    this.controller?.abort();
    this.controller = null;
    this.request = null;
    this.again = false;
    if (this.timer !== null) { window.clearTimeout(this.timer); this.timer = null; }
    if (this.visibilityWake && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityWake);
      this.visibilityWake = null;
    }
  }
}

const stores = new Map<string, TasksStore>();

function getStore(repositoryId: string) {
  let store = stores.get(repositoryId);
  if (!store) { store = new TasksStore(repositoryId); stores.set(repositoryId, store); }
  return store;
}

/** Committed task board for one repository; `board.readiness` is "loading" until the first answer. */
export function useTasks(repositoryId: string): { board: TaskBoard; refresh: () => Promise<void> } {
  const store = useMemo(() => getStore(repositoryId), [repositoryId]);
  const board = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  return useMemo(() => ({ board, refresh: store.refresh }), [board, store]);
}

export function resetTasksStoreForTests() {
  for (const store of stores.values()) store.dispose();
  stores.clear();
}
