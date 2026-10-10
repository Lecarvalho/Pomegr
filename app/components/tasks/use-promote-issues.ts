"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { keepSelection } from "./promote-issues-model";
import { listTaskIssues, taskIssuesAvailable, type TaskIssue, type TaskIssueList } from "./task-issues-desktop";

/** `pending` is only the server and hydration pass: the first client render already knows which of the other two applies. */
export type TaskIssuesAvailability = "pending" | "available" | "absent";

const subscribeBridge = () => () => {};

export function useTaskIssuesAvailability(): TaskIssuesAvailability {
  return useSyncExternalStore<TaskIssuesAvailability>(subscribeBridge, () => taskIssuesAvailable() ? "available" : "absent", () => "pending");
}

type Read = {
  /** The last list the monitor answered, kept on screen while the next read runs. */
  list: TaskIssueList | null;
  /** The last call failed outright (no answer the bridge could use). */
  failed: boolean;
  selected: number | null;
};

export type PromoteIssues = Read & {
  availability: TaskIssuesAvailability;
  /** A read is running: opening the page or Refresh. */
  reading: boolean;
  /** The chosen issue of the list, or null. */
  issue: TaskIssue | null;
  select(number: number): void;
  refresh(): void;
};

/**
 * Reads the repository's open issues once when the page opens in the desktop app, and again only when `refresh` is
 * called. Nothing else reads: no timer, no focus or visibility event. The last list stays on screen while a read runs, and
 * the chosen issue stays chosen across a read when it is still listed.
 */
export function usePromoteIssues(repositoryId: string): PromoteIssues {
  const availability = useTaskIssuesAvailability();
  const available = availability === "available";
  const [read, setRead] = useState<Read>({ list: null, failed: false, selected: null });
  // True from the start: the first read begins as soon as the page opens, so no state is set inside the effect.
  const [reading, setReading] = useState(true);
  const alive = useRef(false);
  const running = useRef(false);
  const sequence = useRef(0);
  const started = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const fetchList = useCallback(async () => {
    running.current = true;
    const mine = ++sequence.current;
    const result = await listTaskIssues(repositoryId);
    if (!alive.current || mine !== sequence.current) return;
    running.current = false;
    setRead((previous) => result.ok
      ? { list: result.value, failed: false, selected: keepSelection(previous.selected, result.value.issues) }
      : { ...previous, failed: true });
    setReading(false);
  }, [repositoryId]);

  // One read per repository; a development double-invoked effect cannot send a second one.
  useEffect(() => {
    if (!available || started.current === repositoryId) return;
    started.current = repositoryId;
    void fetchList();
  }, [available, fetchList, repositoryId]);

  const refresh = useCallback(() => {
    if (running.current) return;
    setReading(true);
    // The error of the last read is not kept on screen while the next one runs.
    setRead((previous) => ({ ...previous, failed: false }));
    void fetchList();
  }, [fetchList]);
  const select = useCallback((number: number) => setRead((previous) => ({ ...previous, selected: number })), []);

  const issue = read.list?.issues.find((entry) => entry.number === read.selected) ?? null;
  return { ...read, availability, reading: available && reading, issue, select, refresh };
}
