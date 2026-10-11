"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { keepSelection } from "./promote-issues-model";
import { listTaskIssues, taskIssuesAvailable, type TaskIssue, type TaskIssueList } from "./task-issues-desktop";

export type TaskIssuesAvailability = "pending" | "available" | "absent";

const subscribeBridge = () => () => {};

export function useTaskIssuesAvailability(): TaskIssuesAvailability {
  return useSyncExternalStore<TaskIssuesAvailability>(subscribeBridge, () => taskIssuesAvailable() ? "available" : "absent", () => "pending");
}

type Read = {
  list: TaskIssueList | null;
  failed: boolean;
  selected: number | null;
};

export type PromoteIssues = Read & {
  availability: TaskIssuesAvailability;
  reading: boolean;
  issue: TaskIssue | null;
  select(number: number): void;
  refresh(): void;
};

/** Reads the repository's open issues once when the page opens in the desktop app, and again only when `refresh` is called. */
export function usePromoteIssues(repositoryId: string): PromoteIssues {
  const availability = useTaskIssuesAvailability();
  const available = availability === "available";
  const [read, setRead] = useState<Read>({ list: null, failed: false, selected: null });
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

  useEffect(() => {
    if (!available || started.current === repositoryId) return;
    started.current = repositoryId;
    void fetchList();
  }, [available, fetchList, repositoryId]);

  const refresh = useCallback(() => {
    if (running.current) return;
    setReading(true);
    setRead((previous) => ({ ...previous, failed: false }));
    void fetchList();
  }, [fetchList]);
  const select = useCallback((number: number) => setRead((previous) => ({ ...previous, selected: number })), []);

  const issue = read.list?.issues.find((entry) => entry.number === read.selected) ?? null;
  return { ...read, availability, reading: available && reading, issue, select, refresh };
}
