"use client";

import type { ReactNode } from "react";
import { CapacityStrip } from "../tasks/CapacityStrip";
import { ScorecardPanel } from "../tasks/ScorecardPanel";
import { TaskLogPanel, type TaskLogRead } from "../tasks/TaskLogPanel";
import type { TaskLog, TaskLogAnswer } from "../tasks/task-desktop";
import type { Scorecard, ScorecardAnswer } from "../tasks/scorecard-model";
import { Sample, SAMPLE_TIME, Section } from "./DesignSystemKit";
import { TaskBoardView } from "../tasks/TaskBoardView";
import { BOARD_RUNNING, inertEdits } from "./DesignSystemTaskSampleData";

const EDITS = inertEdits(BOARD_RUNNING);

const noop = () => undefined;
const readLater = (): Promise<ScorecardAnswer> => Promise.resolve({ ok: true, scorecard: LATER });
const HOUR = 3_600_000;

const LOG: TaskLog = { entries: [
  { id: 1, task: "T-12", kind: "started", at: SAMPLE_TIME - HOUR, pullRequest: null },
  { id: 2, task: "T-12", kind: "review", at: SAMPLE_TIME, pullRequest: 42 },
  { id: 3, task: "T-12", kind: "checks_failed", at: SAMPLE_TIME, pullRequest: 42 },
], more: false, arilCursor: 2 };
const readLog = (): Promise<TaskLogAnswer> => Promise.resolve({ ok: true, log: LOG });
const LOG_SAMPLES: [string, TaskLogRead][] = [
  ["entries", { state: "ready", log: LOG }], ["empty", { state: "ready", log: { entries: [], more: false, arilCursor: 0 } }],
  ["reading", { state: "pending" }], ["failed", { state: "failed" }], ["more", { state: "ready", log: { ...LOG, more: true } }],
  ["paired", { state: "ready", log: LOG }],
];

// Synthetic values only.
const FIRST: Scorecard = {
  formula: 1,
  current: { version: "0.9.0", takenAt: SAMPLE_TIME, measures: { ownerTurns: { value: 2, sample: 6 }, reviewToDoneMs: { value: 5.5 * HOUR, sample: 6 }, firstPass: { value: 0.5, sample: 6 } } },
  baseline: null,
};
const LATER: Scorecard = {
  formula: 1,
  current: { version: "0.9.2", takenAt: SAMPLE_TIME, measures: { ownerTurns: { value: 1, sample: 14 }, reviewToDoneMs: { value: 2.25 * HOUR, sample: 14 }, firstPass: { value: 0.71, sample: 14 } } },
  baseline: { version: "0.9.0", takenAt: SAMPLE_TIME - 21 * 24 * HOUR, measures: FIRST.current.measures },
};
const EMPTY: Scorecard = {
  formula: 1,
  current: { version: "0.9.0", takenAt: SAMPLE_TIME, measures: { ownerTurns: { value: null, sample: 0 }, reviewToDoneMs: { value: null, sample: 0 }, firstPass: { value: null, sample: 0 } } },
  baseline: null,
};

function Frame({ children }: { children: ReactNode }) {
  return <div className="designSystemTaskFrame">{children}</div>;
}

export function ScorecardSection() {
  return <Section id="task-scorecard" title="Scorecard" lede="Desktop app only. Heuristic proxies from the board's Done tasks, each with its sample. The first snapshot is the baseline. Values never leave this computer.">
    <div className="designSystemGrid">
      <Sample label="Capacity strip, desktop app" note="Desktop app only: the Quiet Log and Scorecard actions sit before Queue settings at the strip's end.">
        <Frame><CapacityStrip queue={BOARD_RUNNING.queue} onOpenSettings={noop} onOpenLog={noop} onOpenScorecard={noop} /></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Board, desktop app, with Scorecard" note="Scorecard opens the side panel from the right edge, like Queue settings. The board keeps its height.">
        <Frame><div className="tasksPageBody"><TaskBoardView board={BOARD_RUNNING} readTaskLog={readLog} readScorecard={readLater} edits={EDITS} onOpenTask={noop} /></div></Frame>
      </Sample>
    </div>
    <div className="designSystemGrid">
      <Sample label="Panel, a later version" note="The side panel of Queue settings. Each row: the measure and its definition, the value now with its sample, and the baseline. Measures with no source yet name the gap that will measure them.">
        <ScorecardPanel read={{ state: "ready", scorecard: LATER }} onClose={noop} titleId="scorecard-sample-later" />
      </Sample>
      <Sample label="Panel, the first version" note="No baseline yet: this version's values become it.">
        <ScorecardPanel read={{ state: "ready", scorecard: FIRST }} onClose={noop} titleId="scorecard-sample-first" />
      </Sample>
      <Sample label="Panel, no Done task yet" note="A measure with no merged task says No data, never 0.">
        <ScorecardPanel read={{ state: "ready", scorecard: EMPTY }} onClose={noop} titleId="scorecard-sample-empty" />
      </Sample>
      <Sample label="Panel, reading" note="Shown until the desktop answers.">
        <ScorecardPanel read={{ state: "pending" }} onClose={noop} titleId="scorecard-sample-pending" />
      </Sample>
      <Sample label="Panel, the read failed" note="An unavailable store or a malformed answer. Reopening the panel reads again.">
        <ScorecardPanel read={{ state: "failed" }} onClose={noop} titleId="scorecard-sample-failed" />
      </Sample>
    </div>
    <div className="designSystemGrid">
      {LOG_SAMPLES.map(([name, read]) => <Sample key={name} label={`Task log, ${name}`} note="Desktop app and paired device. A neutral record, newest first; viewing never advances Aril's cursor.">
        <TaskLogPanel read={read} onClose={noop} titleId={`task-log-sample-${name}`} paired={name === "paired"} />
      </Sample>)}
    </div>
  </Section>;
}
