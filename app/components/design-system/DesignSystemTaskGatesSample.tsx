"use client";

import type { ReactNode } from "react";
import type { TaskQueue } from "../../../shared/task-contract";
import { SchedulePanel } from "../tasks/SchedulePanel";
import { StartGatesPanel } from "../tasks/StartGatesPanel";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_RUNNING, GATES_OPEN, GATES_STOPPED, GATES_UNKNOWN, QUEUE_IDLE, QUEUE_RUNNING, SAMPLE_FUTURE, SAMPLE_FUTURE_STOP, inertEdits,
} from "./DesignSystemTaskSampleData";

const EDITS = inertEdits(BOARD_RUNNING);
const SCHEDULED: TaskQueue = { ...QUEUE_IDLE, schedule: { startAt: SAMPLE_FUTURE, stopAfter: SAMPLE_FUTURE_STOP } };
const STOP_ONLY: TaskQueue = { ...QUEUE_RUNNING, schedule: { startAt: null, stopAfter: SAMPLE_FUTURE_STOP } };
const NO_GATES: TaskQueue = { status: "idle", blockedBy: null, pauseReason: null, order: [] };

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

export function TaskGatesSection() {
  return <Section id="task-gates" title="Start gates and schedule" lede="Two panels share one frame, heading, field, and caption in the Queue view's right column. Start gates reads what the monitor last judged before a session starts; Schedule holds the queue's own start and stop times. Both are read-only outside the desktop app. A time field is the native time input at control height with the stronger line and the data font.">
    <div className="designSystemGrid">
      <Sample label="Start gates, held" note="A reading is green when its gate passes, error when it holds, and muted when unknown. Capacity prints only the percentages the board sent.">
        <Frame><StartGatesPanel queue={QUEUE_RUNNING} /></Frame>
      </Sample>
      <Sample label="Start gates, desktop app" note="Do not start above is a CommandSelect with the three fixed thresholds in the app, plain text in a browser.">
        <Frame><StartGatesPanel queue={{ ...QUEUE_RUNNING, gates: GATES_OPEN }} edits={EDITS} /></Frame>
      </Sample>
      <Sample label="Start gates, stopped" note="A provider incident, a dirty working tree, and the earlier task the next one waits on.">
        <Frame><StartGatesPanel queue={{ ...QUEUE_RUNNING, gates: GATES_STOPPED }} /></Frame>
      </Sample>
      <Sample label="Start gates, unknown" note="Missing, stale, or partial evidence holds a start like a failed gate and is never drawn as passed.">
        <Frame><StartGatesPanel queue={{ ...QUEUE_IDLE, gates: GATES_UNKNOWN }} /></Frame>
      </Sample>
      <Sample label="Start gates, not available" note="Shown until the board carries gates."><Frame><StartGatesPanel queue={NO_GATES} /></Frame></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Schedule, browser, not set" note="Two definition rows."><Frame><SchedulePanel queue={QUEUE_IDLE} /></Frame></Sample>
      <Sample label="Schedule, browser, set" note="Each line names the day of its stored time. Times print in this computer's local time."><Frame><SchedulePanel queue={SCHEDULED} /></Frame></Sample>
      <Sample label="Schedule, desktop app, run now" note="A Segmented pair, Run now and Start at a time; only a stop time shows. The fixed note says a running session is never stopped."><Frame><SchedulePanel queue={STOP_ONLY} edits={EDITS} /></Frame></Sample>
      <Sample label="Schedule, desktop app, start at a time" note="The Start at field appears for the second segment."><Frame><SchedulePanel queue={SCHEDULED} edits={EDITS} /></Frame></Sample>
    </div>
    <p className="designSystemNote">In the Queue view these panels share one right column, at most 360px wide, that wraps under the queue when the page is narrow. The next queued task&apos;s card repeats a held gate as one muted Waiting line.</p>
  </Section>;
}
