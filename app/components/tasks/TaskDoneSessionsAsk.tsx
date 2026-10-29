"use client";

import { useEffect, useRef } from "react";
import type { DoneSessionsAsk } from "./use-task-done-sessions";

/** The question a Done action asks while a session of the task still works. Both buttons mark the task Done; Keep it running has the focus. */
export function TaskDoneSessionsAsk({ ask, className }: { ask: DoneSessionsAsk; className?: string }) {
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => { keep.current?.focus({ preventScroll: true }); }, []);
  return <div className={className ? `taskModalConfirm ${className}` : "taskModalConfirm"} role="group" aria-label="End the session">
    <span className="taskModalNote">{ask.working === 1 ? "Its session is still working. End it?" : "Its sessions are still working. End them?"}</span>
    <button type="button" className="commandSecondaryAction" onClick={() => ask.answer(true)}>End session</button>
    <button ref={keep} type="button" className="commandQuietAction" onClick={() => ask.answer(false)}>Keep it running</button>
  </div>;
}
