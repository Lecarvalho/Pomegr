"use client";

import { useId } from "react";
import type { KeyboardEvent } from "react";
import { TASK_BOUNDS, type Task, type TaskBoard } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  featureCounts, featureDraftFromSelect, featureSelectOptions, featureSelectValue, featureSiblings, type FeatureDraft,
} from "./task-features";
import { taskCardTitle, taskChip } from "./task-presentation";

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks"> & { queue?: Pick<TaskBoard["queue"], "order"> };

function SiblingRow({ task, step, nextQueued, onOpenTask }: { task: Task; step: boolean; nextQueued: boolean; onOpenTask?: (task: Task, opener: HTMLElement) => void }) {
  const chip = taskChip(task, nextQueued);
  const title = taskCardTitle(task);
  return <li className={`taskFeatureItem${step ? " hasStep" : ""}${task.state === "done" ? " isDone" : ""}`} data-task-id={task.id}>
    {step && <span className="taskFeatureStep">{task.step}</span>}
    <span className="taskFeatureId">{task.id}</span>
    {onOpenTask
      ? <button type="button" className="commandQuietAction taskFeatureOpen" title={title} onClick={(event) => onOpenTask(task, event.currentTarget)}><span className="taskFeatureTitle">{title}</span></button>
      : <span className="taskFeatureTitle" title={title}>{title}</span>}
    <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
  </li>;
}

/** The folded list of a feature's tasks. The task modal leaves its own task out and leads each row with its step; the Feature modal lists every task under "Tasks". */
export function FeatureSiblings({ board, featureId, selfId, label = "In this feature", steps = selfId !== undefined, onOpenTask }: {
  board: BoardShape;
  featureId: string;
  selfId?: string;
  label?: string;
  steps?: boolean;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
}) {
  const { total, done } = featureCounts(board, featureId);
  const rows = featureSiblings(board, featureId, selfId);
  return <details className="taskFeatureDetails">
    <summary>
      <svg className="taskFeatureChevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
      <span className="taskFeatureLabel">{label}</span>
      <span className="taskFeatureCount"><span className="taskFeatureNum">{total}</span> {total === 1 ? "task" : "tasks"} · <span className="taskFeatureNum">{done}</span> done</span>
    </summary>
    {rows.length > 0 && <ul className="taskFeatureList">
      {rows.map((task) => <SiblingRow key={task.id} task={task} step={steps} nextQueued={task.id === board.queue?.order[0]} onOpenTask={onOpenTask} />)}
    </ul>}
  </details>;
}

export function FeatureFields({ draft, board, selfId, error, disabled, onChange, onCommitName, onCancelName, onOpenTask }: {
  draft: FeatureDraft;
  board: BoardShape;
  selfId?: string;
  error?: string | null;
  disabled?: boolean;
  onChange(next: FeatureDraft): void;
  onCommitName?(): void;
  onCancelName?(): void;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
}) {
  const featureId = useId();
  const errorId = useId();
  const known = draft.featureId !== null && board.features.some((feature) => feature.id === draft.featureId);
  const nameKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onCommitName?.(); return; }
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancelName?.();
  };
  return <>
    <div className="taskFeatureRow">
      <div className="newTaskField">
        <label htmlFor={featureId}>Feature</label>
        <CommandSelect id={featureId} aria-label="Feature" options={featureSelectOptions(board.features, draft.featureId)} value={featureSelectValue(draft)} disabled={disabled}
          onChange={(value) => onChange(featureDraftFromSelect(value, draft))} />
        {draft.creating && <input className="taskOwnInput taskFeatureName" type="text" aria-label="Feature name" placeholder="Feature name" maxLength={TASK_BOUNDS.featureNameLength}
          value={draft.name} aria-describedby={error ? errorId : undefined} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
          onKeyDown={nameKeys} onBlur={onCommitName} />}
        {error && <p id={errorId} className="newTaskError" role="alert">{error}</p>}
      </div>
    </div>
    {known && draft.featureId !== null && <FeatureSiblings key={draft.featureId} board={board} featureId={draft.featureId} selfId={selfId} onOpenTask={onOpenTask} />}
  </>;
}
