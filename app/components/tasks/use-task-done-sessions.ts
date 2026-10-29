"use client";

import { useCallback, useRef, useState } from "react";
import { inspectDesktopTaskSessions, settleDesktopTaskSessions } from "./task-desktop";

/** The question a Done action asks while a session of the task still works. Either answer marks the task Done. */
export type DoneSessionsAsk = { working: number; answer(endWorking: boolean): void };

/** What the owner decided before the Done action: `settle` runs after the task is Done and ends its sessions as decided. */
export type DoneSessionsGate = { settle(): Promise<void> };

/**
 * The desktop app's check before a task is marked Done: it asks the desktop whether a session Pomegr started for the task still
 * works, and if one does, asks the owner whether to end it. Without the desktop bridge there is nothing to ask and nothing to settle.
 * One question is open at a time; a later Done action waits for the answer.
 */
export function useDoneSessions(repositoryId: string) {
  const [ask, setAsk] = useState<DoneSessionsAsk | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const decide = useCallback(async (taskId: string): Promise<DoneSessionsGate> => {
    const reading = await inspectDesktopTaskSessions(repositoryId, taskId);
    if (reading === null) return { settle: () => Promise.resolve() };
    let endWorking = false;
    if (reading.working > 0) {
      endWorking = await new Promise<boolean>((resolve) => {
        setAsk({ working: reading.working, answer: (value) => { setAsk(null); resolve(value); } });
      });
    }
    return { settle: () => settleDesktopTaskSessions(repositoryId, taskId, endWorking) };
  }, [repositoryId]);

  const beforeDone = useCallback((taskId: string): Promise<DoneSessionsGate> => {
    const next = queue.current.then(() => decide(taskId));
    queue.current = next.catch(() => undefined);
    return next;
  }, [decide]);

  return { ask, beforeDone };
}
