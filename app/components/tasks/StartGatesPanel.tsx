"use client";

import { useId } from "react";
import { TASK_GATE_THRESHOLDS, type TaskBoard, type TaskGateThreshold, type TaskGateUsage, type TaskProvider } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import { PROVIDER_NAMES, earlierTaskRow, providerStatusRow, usageReading, workingTreeRow, type GateTone } from "./task-gates-model";
import type { TaskBoardEdits } from "./use-task-board-edits";

const thresholdLabel = (value: TaskGateThreshold) => `${value}% of the usage window`;
const THRESHOLD_OPTIONS = TASK_GATE_THRESHOLDS.map((value) => ({ value, label: thresholdLabel(value) }));

function Row({ label, tone, children, mono }: { label: string; tone?: GateTone; children: string; mono?: boolean }) {
  return <div className="taskGateRow">
    <dt>{label}</dt>
    <dd className={`taskGateValue${mono ? " isMono" : ""}${tone ? ` is-${tone}` : ""}`}>{children}</dd>
  </div>;
}

function CapacityRow({ provider, usage }: { provider: TaskProvider; usage: TaskGateUsage }) {
  const reading = usageReading(usage);
  const label = `${PROVIDER_NAMES[provider]} capacity`;
  if (reading === null) return <Row label={label} tone="muted">Unknown</Row>;
  if (usage.status === "over") return <div className="taskGateRow">
    <dt>{label}</dt>
    <dd className="taskGateValue isMono is-error">{reading}<span className="taskGateOver"> · above threshold</span></dd>
  </div>;
  return <Row label={label} mono>{reading}</Row>;
}

/** A section of Queue settings: no frame of its own, under the panel's h2. */
export function StartGatesPanel({ queue, edits }: { queue: TaskBoard["queue"]; edits?: TaskBoardEdits }) {
  const headingId = useId();
  const gates = queue.gates;
  return <section className="taskGatesPanel" aria-labelledby={headingId}>
    <h3 id={headingId} className="taskGatesHeading">Start gates</h3>
    <p className="taskGatesCaption">Checked before every session Pomegr starts.</p>
    {!gates ? <p className="taskGatesCaption">Start gates are not available yet.</p> : <>
      <dl className="taskGateList">
        <Row label="Earlier task finished" tone={earlierTaskRow(gates).tone}>{earlierTaskRow(gates).text}</Row>
        <CapacityRow provider="claude" usage={gates.usage.claude} />
        <CapacityRow provider="codex" usage={gates.usage.codex} />
        <Row label="Provider status" tone={providerStatusRow(gates).tone}>{providerStatusRow(gates).text}</Row>
        <Row label="Working tree" tone={workingTreeRow(gates).tone}>{workingTreeRow(gates).text}</Row>
      </dl>
      <div className="taskGateField taskGateThreshold">
        <span className="taskGateFieldLabel">Do not start above</span>
        {edits
          ? <CommandSelect aria-label="Do not start above" value={gates.threshold} options={THRESHOLD_OPTIONS} disabled={edits.busy}
            onChange={(value) => { if (value !== gates.threshold) void edits.setGateThreshold(value); }} />
          : <p className="taskGateReadOnly">{thresholdLabel(gates.threshold)}</p>}
      </div>
      <p className="taskGatesCaption">Uses the five-hour window, or the seven-day window for Codex accounts with only a weekly limit.</p>
    </>}
  </section>;
}
