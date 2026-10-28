"use client";

import { useEffect, useState } from "react";
import type { SessionTaskReference } from "../shared/session-catalog-contract";
import { TASK_ID_PATTERN } from "../shared/task-contract";

const RETRY_DELAY_MS = 5_000;
const SETTLED_DELAY_MS = 30_000;
const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;
const STATES = new Set(["needs_review", "stalled", "blocked", "done"]);

export type SessionTaskResult = { status: "loading" | "absent"; task: null } | { status: "present"; task: SessionTaskReference };

const LOADING: SessionTaskResult = { status: "loading", task: null };
const ABSENT: SessionTaskResult = { status: "absent", task: null };

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseSessionTaskReference(value: unknown): SessionTaskReference | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const task = value as Record<string, unknown>;
  if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id) || typeof task.repositoryId !== "string" || !REPOSITORY_ID.test(task.repositoryId)) return null;
  if (!(task.state === null || STATES.has(task.state as string))) return null;
  if (!(task.featureId === null || boundedText(task.featureId, 200)) || !(task.feature === null || boundedText(task.feature, 80))) return null;
  if (task.role !== undefined && task.role !== "review") return null;
  return { id: task.id, repositoryId: task.repositoryId, state: task.state as SessionTaskReference["state"], featureId: task.featureId as string | null, feature: task.feature as string | null, ...(task.role === "review" ? { role: "review" as const } : {}) };
}

export function parseSessionTaskAnswer(value: unknown, sessionId: string): SessionTaskResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.taskReadiness === "desktop_only") return ABSENT;
  if (body.taskReadiness !== "ready" || !Array.isArray(body.sessions)) return null;
  const row = body.sessions.find((entry) => entry !== null && typeof entry === "object" && (entry as Record<string, unknown>).id === sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (row.task === null) return ABSENT;
  const task = parseSessionTaskReference(row.task);
  return task ? { status: "present", task } : null;
}

function sameResult(left: SessionTaskResult, right: SessionTaskResult) {
  if (left.status !== right.status) return false;
  const a = left.task, b = right.task;
  return a === b || (a !== null && b !== null && a.id === b.id && a.repositoryId === b.repositoryId && a.state === b.state && a.featureId === b.featureId && a.feature === b.feature && a.role === b.role);
}

/** Reads the session's task reference and rereads it while the page is visible. */
export function useSessionTaskReference(sessionId: string, { enabled = true }: { enabled?: boolean } = {}): SessionTaskResult {
  const [state, setState] = useState<{ sessionId: string; result: SessionTaskResult }>({ sessionId, result: LOADING });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number | null = null;
    let desktopOnly = false;
    let settled = false;
    const read = async () => {
      timer = null;
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/sessions?${new URLSearchParams({ mode: "directory", session: sessionId, pageSize: "1" })}`, { cache: "no-store", signal: controller.signal });
          const body = response.ok ? await response.json().catch(() => null) : null;
          if (controller.signal.aborted) return;
          const result = parseSessionTaskAnswer(body, sessionId);
          if (result) {
            settled = true;
            desktopOnly = (body as Record<string, unknown>).taskReadiness === "desktop_only";
            setState((current) => current.sessionId === sessionId && sameResult(current.result, result) ? current : { sessionId, result });
          }
        } catch { /* keep the last answer */ }
      }
      // A client that is not on this computer never gets a reference.
      if (!controller.signal.aborted && !desktopOnly) timer = window.setTimeout(() => void read(), settled ? SETTLED_DELAY_MS : RETRY_DELAY_MS);
    };
    void read();
    return () => { controller.abort(); if (timer !== null) window.clearTimeout(timer); };
  }, [enabled, sessionId]);
  return state.sessionId === sessionId ? state.result : LOADING;
}
