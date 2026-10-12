"use client";

import type { TaskQueueStatus } from "../../../shared/task-contract";

export function QueueControl({ status, busy, onSet }: { status: TaskQueueStatus; busy: boolean; onSet(on: boolean): void }) {
  const on = status !== "idle";
  return <div className="taskQueueSwitch">
    <span className="taskFilterEyebrow" aria-hidden="true">Queue</span>
    <div className="commandSegmented" role="group" aria-label="Queue">
      <button type="button" aria-pressed={!on} disabled={busy} onClick={() => { if (on) onSet(false); }}>Off</button>
      <button type="button" aria-pressed={on} disabled={busy} onClick={() => { if (!on || status === "paused") onSet(true); }}>On</button>
    </div>
  </div>;
}
