"use client";

import type { ReactNode } from "react";
import type { Task } from "../../../shared/task-contract";
import { QueueBanner } from "../tasks/QueueBanner";
import { QueueBlockRules } from "../tasks/QueueBlockRules";
import { QueueControl } from "../tasks/QueueControl";
import { QueueFeaturePanel } from "../tasks/QueueFeaturePanel";
import { QueueSettings } from "../tasks/QueueSettingsPanel";
import { QueueSingleTasks } from "../tasks/QueueSingleTasks";
import { QueueTaskCard } from "../tasks/QueueTaskCard";
import { TaskBoardView } from "../tasks/TaskBoardView";
import { waitingLine } from "../tasks/task-gates-model";
import { moveChoices, queueFeatures, singleQueueTasks } from "../tasks/task-queue-model";
import { useQueueDrag } from "../tasks/use-queue-drag";
import { Sample, Section } from "./DesignSystemKit";
import { BOARD_BLOCKED, BOARD_PAUSED, BOARD_RUNNING, SAMPLE_FUTURE_STOP, inertEdits } from "./DesignSystemTaskSampleData";

const noop = () => undefined;
const EDITS_BLOCKED = inertEdits(BOARD_BLOCKED);
const EDITS_PAUSED = inertEdits(BOARD_PAUSED);
const EDITS_RUNNING = inertEdits(BOARD_RUNNING);
const PANELS = queueFeatures(BOARD_RUNNING);
const QUEUE_WITH_STOP = { ...BOARD_RUNNING.queue, schedule: { startAt: null, stopAfter: SAMPLE_FUTURE_STOP } };
const upload = PANELS[0];
const task = (id: string): Task => BOARD_RUNNING.tasks.find((entry) => entry.id === id) as Task;

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

function Wide({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemGrid"><Sample label={label} note={note}><Frame>{children}</Frame></Sample></div>;
}

function DesktopFeaturePanel() {
  const drag = useQueueDrag(BOARD_RUNNING.tasks, noop);
  return <QueueFeaturePanel panel={upload} nextId="T-2" queue={BOARD_RUNNING.queue} onOpenTask={noop} drag={drag} onMove={noop} />;
}

export function TaskQueueSection() {
  return <Section id="task-queue" title="Task queue" lede="The Queue view of the Tasks page: a switch in the page header, a status banner while the queue is blocked or paused, one panel per unfinished feature with its steps, the single tasks, the fixed rules for when the queue blocks, and the Start gates and Schedule panels beside them. The monitor owns the start order; these components only draw it.">
    <div className="designSystemGrid">
      <Sample label="Queue switch, off" note="Segmented role with a muted Queue eyebrow. Desktop app only; every client reads one muted line saying whether the queue is on."><QueueControl status="idle" busy={false} onSet={noop} /></Sample>
      <Sample label="Queue switch, on" note="On stays pressed while the queue is running, blocked, or paused; pressing On while paused is the retry."><QueueControl status="running" busy={false} onSet={noop} /></Sample>
      <Sample label="Queue switch, busy" note="Disabled while the monitor answers."><QueueControl status="running" busy onSet={noop} /></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Banner, blocked (Board)" note="Error-soft fill and error line, title in the error color, body in ink. It names the task that holds the queue and why.">
        <Frame><QueueBanner board={BOARD_BLOCKED} view="board" onOpenTask={noop} edits={EDITS_BLOCKED} /></Frame>
      </Sample>
      <Sample label="Banner, blocked (Queue)" note="A stalled or blocked task adds the desktop-only Mark done and resume (Secondary) and Requeue (Quiet, ink), on the Board and on the Queue view.">
        <Frame><QueueBanner board={BOARD_BLOCKED} view="queue" onOpenTask={noop} edits={EDITS_BLOCKED} /></Frame>
      </Sample>
      <Sample label="Banner, paused" note="Words one fixed pause reason; turning the queue on again is the retry.">
        <Frame><QueueBanner board={BOARD_PAUSED} view="queue" onOpenTask={noop} edits={EDITS_PAUSED} /></Frame>
      </Sample>
      <Sample label="Banner, browser" note="No task opener, so the banner carries text only.">
        <Frame><QueueBanner board={BOARD_BLOCKED} view="queue" /></Frame>
      </Sample>
    </div>
    <Wide label="Queue cards" note="A step card is the board card at the compact padding. The next task adds the muted Waiting line while a gate holds it; a movable queued task adds the Move to step select, drawn while the card holds keyboard focus or on a coarse pointer.">
      <ul className="taskQueueCards">
        <QueueTaskCard task={task("T-2")} nextQueued waiting={waitingLine(BOARD_RUNNING.queue, "T-2")} />
        <QueueTaskCard task={task("T-3")} nextQueued={false} onOpen={noop} move={{ drag: {}, choices: moveChoices(upload, task("T-3")), onMove: noop }} />
        <QueueTaskCard task={task("T-6")} nextQueued={false} />
      </ul>
    </Wide>
    <Wide label="Feature panel, browser" note="Feature name and a done count; steps in order with Parallel · n when a step holds several tasks, each started in its own worktree. The read-only copy drops the drag sentence.">
      <QueueFeaturePanel panel={upload} nextId="T-2" queue={BOARD_RUNNING.queue} />
    </Wide>
    <Wide label="Feature panel, desktop app" note="Queued cards drag onto another step; a step whose tasks are all done never takes a drop. The dashed zone adds a new last step.">
      <DesktopFeaturePanel />
    </Wide>
    <div className="designSystemGrid">
      <Sample label="Single tasks"><Frame><QueueSingleTasks tasks={singleQueueTasks(BOARD_RUNNING)} nextId="T-2" queue={BOARD_RUNNING.queue} /></Frame></Sample>
      <Sample label="Single tasks, none queued"><Frame><QueueSingleTasks tasks={[]} nextId={null} queue={BOARD_RUNNING.queue} /></Frame></Sample>
      <Sample label="When the queue blocks" note="Fixed copy; each rule ends in its state, in that state's tone. The closing line names the state that does not block."><Frame><QueueBlockRules /></Frame></Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Queue settings, desktop app" note="The side panel the Board's Queue settings action opens: 400px wide at the right edge of the Tasks page, full height, on the panel fill with a strong-line left border. Start gates, Schedule and the blocking rules are its sections, with 13px headings; a rule and 20px divide them. It is drawn in place here; on the Board it is a modal dialog.">
        <Frame><QueueSettings queue={QUEUE_WITH_STOP} edits={EDITS_RUNNING} onClose={noop} titleId="design-system-queue-settings" /></Frame>
      </Sample>
      <Sample label="Queue settings, browser" note="Read-only: the threshold is plain text and the two schedule values are a two-row definition list.">
        <Frame><QueueSettings queue={QUEUE_WITH_STOP} onClose={noop} titleId="design-system-queue-settings-browser" /></Frame>
      </Sample>
    </div>
    <Wide label="Queue view, browser (blocked queue)" note="Feature panels, single tasks and rules in the left column; Start gates and Schedule wrap under it when narrow.">
      <TaskBoardView board={BOARD_BLOCKED} view="queue" />
    </Wide>
    <Wide label="Queue view, desktop app (queue on)" note="Adds drag between steps, the threshold select and the schedule controls.">
      <TaskBoardView board={BOARD_RUNNING} view="queue" edits={EDITS_RUNNING} onOpenTask={noop} />
    </Wide>
  </Section>;
}
