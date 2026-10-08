"use client";

import { useId, type ReactNode } from "react";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, type TaskCheck, type TaskRun } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  CHECK_LABELS, EFFORT_LABELS, runFromSelectValue, runSelectOptions, runSelectValue, withCheck,
  type DoneWhenDraft, type TaskModelOptions,
} from "./task-fields";

// Run on, Effort and Done when, shared by the New task and Task panels (design contract D195-D216 and D252-D272).
// Controls only report changes; each panel decides when a change is saved.

/** Run on (one select naming provider and model) and the optional four-way Effort. Both are optional. */
export function RunFields({ run, models, onChange }: { run: TaskRun; models: TaskModelOptions; onChange(run: TaskRun): void }) {
  const selectId = useId();
  const effortId = useId();
  return <div className="taskRunRow">
    <div className="newTaskField taskRunOn">
      <label htmlFor={selectId}>Run on</label>
      <CommandSelect id={selectId} aria-label="Run on" options={runSelectOptions(models, run)} value={runSelectValue(run)}
        onChange={(value) => onChange(runFromSelectValue(value, run.effort))} />
    </div>
    <div className="newTaskField">
      <span id={effortId} className="newTaskEffortLabel">Effort</span>
      <div className="commandSegmented taskEffort" role="group" aria-labelledby={effortId}>
        {TASK_EFFORTS.map((effort) => <button key={effort} type="button" aria-pressed={run.effort === effort}
          // Pressing the pressed segment clears the optional choice.
          onClick={() => onChange({ ...run, effort: run.effort === effort ? null : effort })}>{EFFORT_LABELS[effort]}</button>)}
      </div>
    </div>
  </div>;
}

/**
 * The five checks and a last row for the agent-judged own condition. `onDraftChange` fires on every edit;
 * `onCommit` fires when a checkbox changes and when the own-condition input loses focus.
 */
export function DoneWhenField({ draft, layout = "grid", results, ownNote, footnote, onDraftChange, onCommit }: {
  draft: DoneWhenDraft;
  layout?: "grid" | "list";
  /** Per-check outcome from the agent's report; a check without an entry shows no result. */
  results?: ReadonlyMap<TaskCheck, boolean>;
  ownNote?: string | null;
  footnote?: ReactNode;
  onDraftChange(next: DoneWhenDraft): void;
  onCommit?(next: DoneWhenDraft): void;
}) {
  const prefix = useId();
  const change = (next: DoneWhenDraft) => { onDraftChange(next); onCommit?.(next); };
  return <fieldset className="taskDoneWhen">
    <legend>Done when</legend>
    <div className={`taskChecks${layout === "list" ? " isList" : ""}`}>
      {TASK_CHECKS.map((check) => {
        const id = `${prefix}-${check}`;
        const result = draft.checks.includes(check) ? results?.get(check) : undefined;
        return <div className="taskCheckRow" key={check}>
          <input id={id} type="checkbox" checked={draft.checks.includes(check)} onChange={(event) => change(withCheck(draft, check, event.currentTarget.checked))} />
          <label htmlFor={id}>{CHECK_LABELS[check]}</label>
          {result !== undefined && <span className={`taskCheckResult ${result ? "isPassed" : "isFailed"}`}>{result ? "Passed" : "Not passed"}</span>}
        </div>;
      })}
      <div className="taskCheckRow">
        <input type="checkbox" aria-label="Use your own condition" checked={draft.ownEnabled} onChange={(event) => change({ ...draft, ownEnabled: event.currentTarget.checked })} />
        <label className="commandVisuallyHidden" htmlFor={`${prefix}-own`}>Your own condition, judged by the agent</label>
        <input id={`${prefix}-own`} type="text" className="taskOwnInput" maxLength={TASK_BOUNDS.ownConditionLength} placeholder="Your own condition"
          value={draft.ownText} onChange={(event) => onDraftChange({ ...draft, ownText: event.currentTarget.value })} onBlur={() => onCommit?.(draft)} />
        {ownNote && <span className="taskCheckResult">{ownNote}</span>}
      </div>
    </div>
    {footnote ?? <span className="newTaskHelper taskDoneWhenNote">Pomegr verifies the listed conditions. Your own condition is judged by the agent.</span>}
  </fieldset>;
}
