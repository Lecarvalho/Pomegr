"use client";

import { useEffect, useState } from "react";
import type { TaskSessionCandidate } from "./TaskSessionsField";

const SESSION_ID = /^(?:claude|codex):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
// One page is read so that ten remain after the closed sessions and the ones already on the task are left out.
const PAGE_SIZE = 50;
/** How many sessions the assign control offers. */
export const SESSION_CANDIDATES_SHOWN = 10;
const TITLE_LENGTH = 160;
const UNTITLED = "Untitled session";

/** The newest sessions of one repository that are not closed, as the Sessions directory lists them: ID, title, and state only. */
export function parseSessionCandidates(value: unknown): TaskSessionCandidate[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { sessions } = value as { sessions?: unknown };
  if (!Array.isArray(sessions)) return null;
  const candidates: TaskSessionCandidate[] = [];
  for (const entry of sessions.slice(0, PAGE_SIZE)) {
    const row = entry !== null && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!row || typeof row.id !== "string" || !SESSION_ID.test(row.id) || row.activityStatus === "closed" || candidates.some((candidate) => candidate.id === row.id)) continue;
    const title = typeof row.title === "string" && row.title.trim() !== "" && row.title !== UNTITLED ? row.title.trim().slice(0, TITLE_LENGTH) : null;
    candidates.push({ id: row.id, title, state: typeof row.activityStatus === "string" ? row.activityStatus : "unknown" });
  }
  return candidates;
}

/** Reads the repository's sessions once for the Task modal's assign control. Absent while unread or unreadable. */
export function useTaskSessionCandidates(repositoryId: string, enabled: boolean): TaskSessionCandidate[] | undefined {
  const [state, setState] = useState<{ repositoryId: string; candidates: TaskSessionCandidate[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/sessions?${new URLSearchParams({ mode: "directory", repositoryId, pageSize: String(PAGE_SIZE) })}`, { cache: "no-store", signal: controller.signal });
        const candidates = response.ok ? parseSessionCandidates(await response.json().catch(() => null)) : null;
        if (candidates && !controller.signal.aborted) setState({ repositoryId, candidates });
      } catch { /* the assign control stays absent */ }
    })();
    return () => controller.abort();
  }, [enabled, repositoryId]);
  return enabled && state?.repositoryId === repositoryId ? state.candidates : undefined;
}
