"use client";

import { useId } from "react";
import type { KeyboardEvent } from "react";
import { TASK_BOUNDS, type Task, type TaskBoard } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  featureCounts, featureDraftFromSelect, featureSelectOptions, featureSelectValue, featureSiblings, stepFromSelect,
  stepSelectOptions, stepSelectValue, type FeatureDraft,
} from "./task-features";
import { taskCardTitle, taskChip } from "./task-presentation";

// Feature, Step in feature and the folded "In this feature" list, shared by the New task and Task panels (design
// contract D217-D233 and D273-D294). Controls only report changes; each panel decides when a change is saved.

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks">;

function SiblingRow({ task, step, onOpenTask }: { task: Task; step: boolean; onOpenTask?: (task: Task, opener: HTMLElement) => void }) {
  const chip = taskChip(task);
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

/**
 * The other tasks of the chosen feature, closed until opened. `selfId` marks the open Task panel: that task is not
 * listed (it is still counted) and each row leads with its step.
 */
function FeatureSiblings({ board, featureId, selfId, onOpenTask }: { board: BoardShape; featureId: string; selfId?: string; onOpenTask?: (task: Task, opener: HTMLElement) => void }) {
  const { total, done } = featureCounts(board, featureId);
  const rows = featureSiblings(board, featureId, selfId);
  return <details className="taskFeatureDetails">
    <summary>
      <svg className="taskFeatureChevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
      <span className="taskFeatureLabel">In this feature</span>
      <span className="taskFeatureCount"><span className="taskFeatureNum">{total}</span> {total === 1 ? "task" : "tasks"} · <span className="taskFeatureNum">{done}</span> done</span>
    </summary>
    {rows.length > 0 && <ul className="taskFeatureList">
      {rows.map((task) => <SiblingRow key={task.id} task={task} step={selfId !== undefined} onOpenTask={onOpenTask} />)}
    </ul>}
  </details>;
}

/**
 * Feature (unfinished features, No feature, New feature…) and Step in feature (Last, or an existing step), then the
 * folded sibling list once a created feature is chosen. New feature… reveals a one-line name in place.
 */
export function FeatureFields({ draft, board, selfId, error, onChange, onCommitName, onCancelName, onOpenTask }: {
  draft: FeatureDraft;
  board: BoardShape;
  /** The open task, for the Task panel: it is not listed as a sibling and is left out of "parallel with". */
  selfId?: string;
  error?: string | null;
  onChange(next: FeatureDraft): void;
  /** The name is final (Enter or leaving the field). */
  onCommitName?(): void;
  onCancelName?(): void;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
}) {
  const featureId = useId();
  const stepId = useId();
  const errorId = useId();
  const steps = stepSelectOptions(board.tasks, draft, selfId);
  const known = draft.featureId !== null && board.features.some((feature) => feature.id === draft.featureId);
  const nameKeys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onCommitName?.(); return; }
    if (event.key !== "Escape") return;
    // Escape leaves the name and keeps the panel's own Escape handling (closing it) out of it.
    event.preventDefault();
    onCancelName?.();
  };
  return <>
    <div className="taskFeatureRow">
      <div className="newTaskField">
        <label htmlFor={featureId}>Feature</label>
        <CommandSelect id={featureId} aria-label="Feature" options={featureSelectOptions(board.features, draft.featureId)} value={featureSelectValue(draft)}
          onChange={(value) => onChange(featureDraftFromSelect(value, draft))} />
        {draft.creating && <input className="taskOwnInput taskFeatureName" type="text" aria-label="Feature name" placeholder="Feature name" maxLength={TASK_BOUNDS.featureNameLength}
          value={draft.name} aria-describedby={error ? errorId : undefined} onChange={(event) => onChange({ ...draft, name: event.currentTarget.value })}
          onKeyDown={nameKeys} onBlur={onCommitName} />}
        {error && <p id={errorId} className="newTaskError" role="alert">{error}</p>}
      </div>
      <div className="newTaskField">
        <label htmlFor={stepId}>Step in feature</label>
        <CommandSelect id={stepId} aria-label="Step in feature" options={steps.options} value={stepSelectValue(draft)} disabled={steps.disabled}
          onChange={(value) => onChange(stepFromSelect(value, draft))} />
      </div>
    </div>
    {known && draft.featureId !== null && <FeatureSiblings key={draft.featureId} board={board} featureId={draft.featureId} selfId={selfId} onOpenTask={onOpenTask} />}
  </>;
}
