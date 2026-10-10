"use client";

import { useId, useImperativeHandle, useRef, type ReactNode, type Ref } from "react";
import { TaskImageAttach, TaskRichText, type TaskFieldImages, type TaskRichTextHandle } from "./TaskImages";
import { TASK_IMAGE_HELPER } from "./task-images-desktop";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, taskImageIds, type TaskCheck, type TaskRun } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  CHECK_SHORT_LABELS, EFFORT_LABELS, runFromSelectValue, runSelectOptions, runSelectValue, withCheck,
  type DoneWhenDraft, type TaskModelOptions,
} from "./task-fields";

// The Task field, Run on, Effort and Done when, shared by the New task and Task modal forms (design contract G124-G128
// and G138-G152). Controls only report changes; each form decides when a change is saved.

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** The Task field's handle: a textarea, or the rich-text editor of a form that holds images. Both can take focus. */
export type TaskTextHandle = { focus(options?: FocusOptions): void };

/**
 * The Task field with its `{n} / 4,000` counter under it, right-aligned. `helper` and `error` are optional lines
 * under the counter (the error is an alert); the field is described by the counter and by whichever of them show.
 * Without `images` it is a textarea. With `images` it is rich text in one frame: the text is typed as before, an image
 * shows inline where it was pasted, dropped or attached, and Attach image sits at the foot of the frame. The value is
 * one string either way; an image is a marker in it.
 */
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

/** Run on (one select naming provider and model) and the optional four-way Effort, in one two-column row. Both are optional. */
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
 * The five checks in a wrapping row, then one input for the agent-judged own condition: a non-blank input is the own
 * condition, a blank one is none. `onDraftChange` fires on every edit; `onCommit` fires when a checkbox changes and
 * when the own-condition input loses focus.
 */
export function DoneWhenField({ draft, results, ownNote, footnote, onDraftChange, onCommit }: {
  draft: DoneWhenDraft;
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
    <div className="taskChecks">
      {TASK_CHECKS.map((check) => {
        const id = `${prefix}-${check}`;
        const result = draft.checks.includes(check) ? results?.get(check) : undefined;
        return <div className="taskCheckRow" key={check}>
          <input id={id} type="checkbox" checked={draft.checks.includes(check)} onChange={(event) => change(withCheck(draft, check, event.currentTarget.checked))} />
          <label htmlFor={id}>{CHECK_SHORT_LABELS[check]}</label>
          {result !== undefined && <span className={`taskCheckResult ${result ? "isPassed" : "isFailed"}`}>{result ? "Passed" : "Not passed"}</span>}
        </div>;
      })}
    </div>
    <div className="taskOwnRow">
      <input type="text" className="taskOwnInput" aria-label="Own condition" maxLength={TASK_BOUNDS.ownConditionLength} placeholder="Own condition, judged by the agent (optional)"
        value={draft.ownText} onChange={(event) => onDraftChange({ ...draft, ownText: event.currentTarget.value })} onBlur={() => onCommit?.(draft)} />
      {ownNote && <span className="taskCheckResult">{ownNote}</span>}
    </div>
    {footnote ?? <span className="newTaskHelper taskDoneWhenNote">Pomegr verifies the listed conditions. Your own condition is judged by the agent.</span>}
  </fieldset>;
}
