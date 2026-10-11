"use client";

import { useId, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { TaskImageAttach, TaskRichText, type TaskFieldImages, type TaskRichTextHandle } from "./TaskImages";
import { TASK_IMAGE_HELPER } from "./task-images-desktop";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, taskImageIds, type TaskCheck, type TaskRun } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  CHECK_SHORT_LABELS, EFFORT_LABELS, REMOTE_CONTROL_LABEL, canRemoteControl, runFromSelectValue, runSelectOptions, runSelectValue, withCheck, withRemoteControl,
  type CompleteWhenDraft, type TaskModelOptions,
} from "./task-fields";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

export type TaskTextHandle = { focus(options?: FocusOptions): void };

export function TaskTextField({ value, onChange, onBlur, images, readOnly, helper, error, ref }: {
  value: string;
  onChange(value: string): void;
  onBlur?(): void;
  images?: TaskFieldImages;
  readOnly?: boolean;
  helper?: ReactNode;
  error?: string | null;
  ref?: Ref<TaskTextHandle>;
}) {
  const fieldId = useId();
  const labelId = useId();
  const counterId = useId();
  const helperId = useId();
  const errorId = useId();
  const imageHelperId = useId();
  const editor = useRef<TaskRichTextHandle>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: (options) => (editor.current ?? textarea.current)?.focus(options) }));
  const describedBy = [helper ? helperId : null, error ? errorId : null, counterId].filter(Boolean).join(" ");
  const over = value.length > TASK_BOUNDS.textLength;
  return <div className="newTaskField">
    {images
      ? <>
        <span id={labelId} className="taskRichTextLabel" onClick={() => editor.current?.focus()}>Task</span>
        <div className="taskComposer">
          <TaskRichText ref={editor} labelledBy={labelId} describedBy={describedBy} value={value} onChange={onChange} onBlur={onBlur}
            readOnly={readOnly} images={images} placeholder="What should the session do?" />
          <TaskImageAttach held={taskImageIds(value).length} disabled={readOnly || images.disabled} describedBy={imageHelperId}
            onAttach={(files) => editor.current?.attach(files)} />
        </div>
      </>
      : <>
        <label htmlFor={fieldId}>Task</label>
        <textarea ref={textarea} id={fieldId} rows={6} maxLength={TASK_BOUNDS.textLength} value={value} readOnly={readOnly}
          placeholder="What should the session do?" aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.value)} onBlur={onBlur} />
      </>}
    <span id={counterId} className={`taskTextCounter${over ? " isOver" : ""}`}>{`${COUNT_FORMAT.format(value.length)} / ${COUNT_FORMAT.format(TASK_BOUNDS.textLength)}`}</span>
    {images && <p id={imageHelperId} className="newTaskHelper">{TASK_IMAGE_HELPER}</p>}
    {images?.error && <p className="newTaskError" role="alert">{images.error}</p>}
    {helper && <p id={helperId} className="newTaskHelper">{helper}</p>}
    {error && <p id={errorId} className="newTaskError" role="alert">{error}</p>}
  </div>;
}

export function RunFields({ run, models, disabled, onChange }: { run: TaskRun; models: TaskModelOptions; disabled?: boolean; onChange(run: TaskRun): void }) {
  const selectId = useId();
  const effortId = useId();
  const remoteId = useId();
  const remoteHelperId = useId();
  const remote = canRemoteControl(run);
  return <div className="taskRunRow">
    <div className="newTaskField taskRunOn">
      <label htmlFor={selectId}>Run on</label>
      <CommandSelect id={selectId} aria-label="Run on" options={runSelectOptions(models, run)} value={runSelectValue(run)} disabled={disabled}
        onChange={(value) => onChange(withRemoteControl(runFromSelectValue(value, run.effort), run.remoteControl === true))} />
    </div>
    <div className="newTaskField">
      <span id={effortId} className="newTaskEffortLabel">Effort</span>
      <div className="commandSegmented taskEffort" role="group" aria-labelledby={effortId}>
        {TASK_EFFORTS.map((effort) => <button key={effort} type="button" aria-pressed={run.effort === effort} disabled={disabled}
          onClick={() => onChange({ ...run, effort: run.effort === effort ? null : effort })}>{EFFORT_LABELS[effort]}</button>)}
      </div>
    </div>
    <div className="newTaskField taskRemoteControl">
      <div className="taskCheckRow">
        <input id={remoteId} type="checkbox" checked={remote && run.remoteControl === true} disabled={disabled || !remote} aria-describedby={remoteHelperId}
          onChange={(event) => onChange(withRemoteControl(run, event.currentTarget.checked))} />
        <label htmlFor={remoteId}>{REMOTE_CONTROL_LABEL}</label>
      </div>
      <p id={remoteHelperId} className="newTaskHelper">{remote ? "Starts the session with Remote Control, so you can also open it on your phone." : "Claude Code only."}</p>
    </div>
  </div>;
}

export function CompleteWhenField({ draft, results, ownNote, footnote, disabled, onDraftChange, onCommit }: {
  draft: CompleteWhenDraft;
  results?: ReadonlyMap<TaskCheck, boolean>;
  ownNote?: string | null;
  footnote?: ReactNode;
  disabled?: boolean;
  onDraftChange(next: CompleteWhenDraft): void;
  onCommit?(next: CompleteWhenDraft): void;
}) {
  const prefix = useId();
  const change = (next: CompleteWhenDraft) => { onDraftChange(next); onCommit?.(next); };
  return <fieldset className="taskCompleteWhen">
    <legend>Complete when</legend>
    <div className="taskChecks">
      {TASK_CHECKS.map((check) => {
        const id = `${prefix}-${check}`;
        const result = draft.checks.includes(check) ? results?.get(check) : undefined;
        return <div className="taskCheckRow" key={check}>
          <input id={id} type="checkbox" checked={draft.checks.includes(check)} disabled={disabled} onChange={(event) => change(withCheck(draft, check, event.currentTarget.checked))} />
          <label htmlFor={id}>{CHECK_SHORT_LABELS[check]}</label>
          {result !== undefined && <span className={`taskCheckResult ${result ? "isPassed" : "isFailed"}`}>{result ? "Passed" : "Not passed"}</span>}
        </div>;
      })}
    </div>
    <div className="taskOwnRow">
      <input type="text" className="taskOwnInput" aria-label="Own condition" maxLength={TASK_BOUNDS.ownConditionLength} placeholder="Own condition, judged by the agent (optional)"
        value={draft.ownText} readOnly={disabled} onChange={(event) => onDraftChange({ ...draft, ownText: event.currentTarget.value })} onBlur={() => onCommit?.(draft)} />
      {ownNote && <span className="taskCheckResult">{ownNote}</span>}
    </div>
    {footnote ?? <span className="newTaskHelper taskCompleteWhenNote">Pomegr verifies the listed conditions. Your own condition is judged by the agent.</span>}
  </fieldset>;
}
