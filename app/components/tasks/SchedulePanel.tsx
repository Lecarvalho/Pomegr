"use client";

import { useId, useState } from "react";
import type { TaskBoard, TaskQueueSchedule } from "../../../shared/task-contract";
import { useMinuteClock } from "./task-panel-hooks";
import { NO_SCHEDULE, editedSchedule, scheduleLabel, timeOfDay } from "./task-schedule";
import type { TaskBoardEdits } from "./use-task-board-edits";

const NOTE = "A running session is never stopped by the schedule. Pomegr must be open for scheduled tasks to start.";

/** What the stored times mean right now, one line each, or null. */
function startLine(schedule: TaskQueueSchedule, status: TaskBoard["queue"]["status"], now: number): string | null {
  const label = schedule.startAt === null ? null : scheduleLabel(schedule.startAt);
  if (schedule.startAt === null || label === null) return null;
  if (Date.parse(schedule.startAt) <= now) return `The start time ${label} has passed: the queue starts tasks now.`;
  return status === "idle" ? `Starts ${label}, once the queue is on.` : `Starts ${label}.`;
}

function stopLine(schedule: TaskQueueSchedule, now: number): string | null {
  const label = schedule.stopAfter === null ? null : scheduleLabel(schedule.stopAfter);
  if (schedule.stopAfter === null || label === null) return null;
  return Date.parse(schedule.stopAfter) <= now
    ? `No task has started since ${label}. Change or clear this time to start tasks again.`
    : `No task starts from ${label}.`;
}

/**
 * The queue's own schedule in the Queue view's right column (design contract D170-D177, D452): Run now or Start at a
 * time, and a time after which nothing new starts. Each time is typed as a time of day and stored as its next
 * occurrence, so the lines under the fields name the day. The controls exist only in the desktop app (`edits`); any
 * other client reads the stored times.
 */
export function SchedulePanel({ queue, edits }: { queue: TaskBoard["queue"]; edits?: TaskBoardEdits }) {
  const headingId = useId();
  const startId = useId();
  const stopId = useId();
  const now = useMinuteClock();
  const stored = queue.schedule ?? NO_SCHEDULE;
  const storedStart = timeOfDay(stored.startAt);
  const storedStop = timeOfDay(stored.stopAfter);
  // "Start at a time" with no time chosen yet is only this panel's: nothing is stored until a time is.
  const [picking, setPicking] = useState(false);
  const [start, setStart] = useState(storedStart);
  const [stop, setStop] = useState(storedStop);
  // The committed times win once the board shows them.
  const committed = `${stored.startAt}|${stored.stopAfter}`;
  const [seen, setSeen] = useState(committed);
  if (seen !== committed) {
    setSeen(committed);
    setStart(storedStart);
    setStop(storedStop);
    if (stored.startAt !== null) setPicking(false);
  }
  const atTime = stored.startAt !== null || picking;
  const send = (change: { startAt?: string; stopAfter?: string }) => { void edits?.setQueueSchedule(editedSchedule(stored, change, Date.now())); };
  const runNow = () => {
    setPicking(false);
    setStart("");
    if (stored.startAt !== null) send({ startAt: "" });
  };
  // An emptied start field is not a choice: Run now is how the start time is cleared.
  const commitStart = () => {
    if (start === "") setStart(storedStart);
    else if (start !== storedStart) send({ startAt: start });
  };
  const commitStop = () => { if (stop !== storedStop) send({ stopAfter: stop }); };
  const starts = startLine(stored, queue.status, now);
  const stops = stopLine(stored, now);

  return <section className="panel taskGatesPanel taskSchedulePanel" aria-labelledby={headingId}>
    <h2 id={headingId} className="taskGatesHeading">Schedule</h2>
    {edits ? <>
      <div className="commandSegmented taskScheduleMode" role="group" aria-label="Queue start">
        <button type="button" aria-pressed={!atTime} disabled={edits.busy} onClick={runNow}>Run now</button>
        <button type="button" aria-pressed={atTime} disabled={edits.busy} onClick={() => setPicking(true)}>Start at a time</button>
      </div>
      {atTime && <div className="taskGateField">
        <label className="taskGateFieldLabel" htmlFor={startId}>Start at</label>
        <input id={startId} type="time" className="taskTimeInput" value={start} disabled={edits.busy}
          onChange={(event) => setStart(event.currentTarget.value)} onBlur={commitStart} />
        {starts && <p className="taskGatesCaption">{starts}</p>}
      </div>}
      <div className="taskGateField">
        <label className="taskGateFieldLabel" htmlFor={stopId}>Stop starting tasks after</label>
        <input id={stopId} type="time" className="taskTimeInput" value={stop} disabled={edits.busy}
          onChange={(event) => setStop(event.currentTarget.value)} onBlur={commitStop} />
        {stops && <p className="taskGatesCaption">{stops}</p>}
      </div>
    </> : <dl className="taskGateList">
      <div className="taskGateRow"><dt>Start</dt><dd className="taskGateValue">{starts ?? "Run now"}</dd></div>
      <div className="taskGateRow"><dt>Stop starting tasks after</dt><dd className="taskGateValue">{stops ?? "Not set"}</dd></div>
    </dl>}
    <p className="taskGatesCaption">{NOTE}</p>
  </section>;
}
