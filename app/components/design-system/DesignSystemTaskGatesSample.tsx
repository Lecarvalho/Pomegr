"use client";

import type { ReactNode } from "react";
import type { ArilGrant, ArilSettings as Settings, TaskQueue } from "../../../shared/task-contract";
import { ArilSettings } from "../tasks/ArilSettingsPanel";
import { CapacityStrip } from "../tasks/CapacityStrip";
import { CommandSelect } from "../command-center/CommandSelect";
import { NewFeatureAction } from "../tasks/FeatureActions";
import { QueueBanner } from "../tasks/QueueBanner";
import { QueueControl } from "../tasks/QueueControl";
import { QueueSettings } from "../tasks/QueueSettingsPanel";
import { SchedulePanel } from "../tasks/SchedulePanel";
import { StartGatesPanel } from "../tasks/StartGatesPanel";
import { PromoteIssuesAction } from "../tasks/promote-issues-action";
import { Sample, Section } from "./DesignSystemKit";
import {
  BOARD_BLOCKED, BOARD_PAUSED, BOARD_RUNNING, GATES_OPEN, GATES_STOPPED, GATES_UNKNOWN, QUEUE_IDLE, QUEUE_RUNNING, SAMPLE_FUTURE, SAMPLE_FUTURE_STOP, SAMPLE_REPOSITORY_ID, inertEdits,
} from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const REPOSITORIES = [{ value: SAMPLE_REPOSITORY_ID, label: "upload-service" }];
const EDITS = inertEdits(BOARD_RUNNING);
const EDITS_BLOCKED = inertEdits(BOARD_BLOCKED);
const EDITS_PAUSED = inertEdits(BOARD_PAUSED);
const QUEUE_WITH_STOP: TaskQueue = { ...BOARD_RUNNING.queue, schedule: { startAt: null, stopAfter: SAMPLE_FUTURE_STOP } };
const SCHEDULED: TaskQueue = { ...QUEUE_IDLE, schedule: { startAt: SAMPLE_FUTURE, stopAfter: SAMPLE_FUTURE_STOP } };
const STOP_ONLY: TaskQueue = { ...QUEUE_RUNNING, schedule: { startAt: null, stopAfter: SAMPLE_FUTURE_STOP } };
const NO_GATES: TaskQueue = { status: "idle", blockedBy: null, pauseReason: null, order: [] };
const ARIL_SETTINGS: Settings = {
  actions: { start: false, review: false, sendBack: false, merge: false, writeTasks: false },
  mergeMethod: null, mergeMode: null, deleteBranch: null,
  limits: { hours: null, tasks: null, tasksAtATime: null, sendBacks: null, usagePercent: null },
  workRules: [], reviewer: { provider: null, model: null, differentFromBuilder: false }, pairedDevices: false,
};

export function ArilSettingsSamples() {
  return <div className="designSystemGrid">{["desktop editable", "paired read-only", "paired allowed", "empty memory", "full memory", "save failure", "not ready", "ready", "confirm", "active", "last ended", "paired stop-only"].map((state, index) => {
    const memory = Array.from({ length: state === "empty memory" ? 0 : state === "full memory" ? 100 : 1 }, (_, id) => ({ id: id + 1, text: `Repository habit ${id + 1}: keep changes focused.`, createdAt: id, updatedAt: id }));
    const ready = ["paired allowed", "ready", "confirm", "active", "last ended", "paired stop-only"].includes(state);
    const settings: Settings = { ...ARIL_SETTINGS, pairedDevices: state === "paired allowed", ...(ready ? {
      actions: { ...ARIL_SETTINGS.actions, start: true, review: true }, limits: { ...ARIL_SETTINGS.limits, hours: 2, tasks: 5, tasksAtATime: 2, usagePercent: 80 }, workRules: [{ kind: "tag", value: "backend" }],
    } : {}) };
    const active: ArilGrant = { active: true, startedAt: Date.parse(SAMPLE_FUTURE), endsAt: Date.parse(SAMPLE_FUTURE_STOP), startsUsed: 2, actions: settings.actions, limits: settings.limits };
    const grant: ArilGrant | null = state === "last ended" ? { ...active, active: false, endedAt: active.endsAt, endReason: "expired" } : ["active", "paired stop-only"].includes(state) ? active : null;
    const board = { ...BOARD_RUNNING, aril: { settings, memory, grant } };
    return <Sample key={state} label={`Aril settings, ${state}`} note="Queue settings frame, existing fields and button roles. Settings and memory grant no actions.">
      <Frame>{state === "active" && <CapacityStrip queue={board.queue} grant={grant} onOpenSettings={noop} onOpenAril={noop} />}
        <ArilSettings board={board} desktop={!state.startsWith("paired")} editable={state !== "paired read-only"} onClose={noop}
        titleId={`design-system-aril-${index}`} initialConfirm={state === "confirm"} initialFailure={state === "save failure" ? "settings" : null} onAction={async () => ({ ok: false, error: "unavailable" })} /></Frame>
    </Sample>;
  })}</div>;
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

/** A section drawn as the Queue settings panel draws it. */
function PanelFrame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame"><div className="taskQueueSettings">{children}</div></div>;
}

export function QueueControlsSection() {
  return <Section id="task-queue-controls" title="Queue controls" lede="The queue is run from the Board: a switch in the page header, a status banner while the queue is blocked or paused, and the Queue settings panel the capacity strip opens. The monitor owns the start order; these components only draw it.">
    <div className="designSystemGrid">
      <Sample label="Queue switch, off" note="Segmented role with a muted Queue eyebrow. Desktop app and paired device only; every client reads one muted line saying whether the queue is on."><QueueControl status="idle" busy={false} onSet={noop} /></Sample>
      <Sample label="Queue switch, on" note="On stays pressed while the queue is running, blocked, or paused; pressing On while paused is the retry."><QueueControl status="running" busy={false} onSet={noop} /></Sample>
      <Sample label="Queue switch, busy" note="Disabled while the monitor answers."><QueueControl status="running" busy onSet={noop} /></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Page header actions, desktop app" note="The Tasks page header holds, in order, the Repository select, the Queue switch and Promote issues, 12px apart, wrapping. A browser has no Queue switch. While the board has no feature, the desktop app adds the Quiet + New feature before Promote issues; it opens the Feature modal.">
        <div className="taskHeadActions">
          <CommandSelect className="tasksRepositorySwitcher" aria-label="Repository" options={REPOSITORIES} value={SAMPLE_REPOSITORY_ID} onChange={noop} />
          <QueueControl status="running" busy={false} onSet={noop} />
          <NewFeatureAction board={{ features: [] }} entry={{ onNew: noop, onEdit: noop }} />
          <PromoteIssuesAction repositoryId={SAMPLE_REPOSITORY_ID} />
        </div>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Banner, blocked" note="Error-soft fill and error line, title in the error color, body in ink. It names the task that holds the queue and why. A stalled or blocked task adds the desktop-only Mark done and resume (Secondary) and Requeue (Quiet, ink).">
        <Frame><QueueBanner board={BOARD_BLOCKED} onOpenTask={noop} edits={EDITS_BLOCKED} /></Frame>
      </Sample>
      <Sample label="Banner, paused" note="Words one fixed pause reason; turning the queue on again is the retry.">
        <Frame><QueueBanner board={BOARD_PAUSED} onOpenTask={noop} edits={EDITS_PAUSED} /></Frame>
      </Sample>
      <Sample label="Banner, browser" note="No task opener, so the banner carries text only.">
        <Frame><QueueBanner board={BOARD_BLOCKED} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Queue settings, desktop app" note="The side panel the Board's Queue settings action opens: 400px wide at the right edge of the Tasks page, full height, on the panel fill with a strong-line left border. Start gates, Schedule and the blocking rules are its sections, with 13px headings; a rule and 20px divide them. Each rule ends in its state, in that state's tone. It is drawn in place here; on the Board it is a modal dialog.">
        <Frame><QueueSettings queue={QUEUE_WITH_STOP} edits={EDITS} onClose={noop} titleId="design-system-queue-settings" /></Frame>
      </Sample>
      <Sample label="Queue settings, browser" note="Read-only: the threshold is plain text and the two schedule values are a two-row definition list.">
        <Frame><QueueSettings queue={QUEUE_WITH_STOP} onClose={noop} titleId="design-system-queue-settings-browser" /></Frame>
      </Sample>
    </div>
    <ArilSettingsSamples />
  </Section>;
}

export function TaskGatesSection() {
  return <Section id="task-gates" title="Start gates and schedule" lede="Two sections of the Queue settings panel share one heading, field, and caption; each is drawn here on the panel's own fill. Start gates reads what the monitor last judged before a session starts; Schedule holds the queue's own start and stop times. Both are read-only outside the desktop app. A time field is the native time input at control height with the stronger line and the data font.">
    <div className="designSystemGrid">
      <Sample label="Start gates, held" note="A reading is green when its gate passes, error when it holds, and muted when unknown. Capacity prints only the percentages the board sent.">
        <PanelFrame><StartGatesPanel queue={QUEUE_RUNNING} /></PanelFrame>
      </Sample>
      <Sample label="Start gates, desktop app" note="Do not start above is a CommandSelect with the three fixed thresholds in the app, plain text in a browser.">
        <PanelFrame><StartGatesPanel queue={{ ...QUEUE_RUNNING, gates: GATES_OPEN }} edits={EDITS} /></PanelFrame>
      </Sample>
      <Sample label="Start gates, stopped" note="A provider incident, a dirty working tree, and the earlier task the next one waits on.">
        <PanelFrame><StartGatesPanel queue={{ ...QUEUE_RUNNING, gates: GATES_STOPPED }} /></PanelFrame>
      </Sample>
      <Sample label="Start gates, unknown" note="Missing, stale, or partial evidence holds a start like a failed gate and is never drawn as passed.">
        <PanelFrame><StartGatesPanel queue={{ ...QUEUE_IDLE, gates: GATES_UNKNOWN }} /></PanelFrame>
      </Sample>
      <Sample label="Start gates, not available" note="Shown until the board carries gates."><PanelFrame><StartGatesPanel queue={NO_GATES} /></PanelFrame></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Schedule, browser, not set" note="Two definition rows."><PanelFrame><SchedulePanel queue={QUEUE_IDLE} /></PanelFrame></Sample>
      <Sample label="Schedule, browser, set" note="Each line names the day of its stored time. Times print in this computer's local time."><PanelFrame><SchedulePanel queue={SCHEDULED} /></PanelFrame></Sample>
      <Sample label="Schedule, desktop app, run now" note="A Segmented pair, Run now and Start at a time; only a stop time shows. The fixed note says a running session is never stopped."><PanelFrame><SchedulePanel queue={STOP_ONLY} edits={EDITS} /></PanelFrame></Sample>
      <Sample label="Schedule, desktop app, start at a time" note="The Start at field appears for the second segment."><PanelFrame><SchedulePanel queue={SCHEDULED} edits={EDITS} /></PanelFrame></Sample>
    </div>
    <p className="designSystemNote">The next queued task&apos;s card repeats a held gate as one muted Waiting line.</p>
  </Section>;
}
