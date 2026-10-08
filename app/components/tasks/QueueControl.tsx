"use client";

import type { TaskQueueStatus } from "../../../shared/task-contract";

/**
 * The queue's Off | On switch, desktop app only. On is pressed for every status but idle: a blocked or paused queue is
 * on and held. Pressing the side already shown sends nothing; On while paused sends on again, which is the retry.
 */
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
