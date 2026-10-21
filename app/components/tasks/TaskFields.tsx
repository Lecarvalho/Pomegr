"use client";

import { useId, useImperativeHandle, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { TaskImageAttach, TaskRichText, type TaskFieldImages, type TaskRichTextHandle } from "./TaskImages";
import { TaskRow } from "./TaskRows";
import { TASK_BOUNDS, TASK_CHECKS, TASK_EFFORTS, taskImageIds, type TaskRun } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import {
  CHECK_SHORT_LABELS, EFFORT_LABELS, REMOTE_CONTROL_LABEL, REMOVE_WORKTREE_LABEL, canRemoteControl, runFromSelectValue, runSelectOptions, runSelectValue, withCheck, withKeepWorktree, withRemoteControl,
  type CompleteWhenDraft, type TaskModelOptions,
} from "./task-fields";

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** The muted hint under Own condition: what the agent judges. Pomegr verifies the other conditions, as the owner page says. */
export const COMPLETE_WHEN_HINT = "The agent judges Validated with the user and your own condition.";

export type TaskTextHandle = { focus(options?: FocusOptions): void };

export function TaskTextField({ value, onChange, onBlur, images, readOnly, error, ref }: {
  value: string;
  onChange(value: string): void;
  onBlur?(): void;
  images?: TaskFieldImages;
  readOnly?: boolean;
  error?: string | null;
  ref?: Ref<TaskTextHandle>;
}) {
  const fieldId = useId();
  const labelId = useId();
  const counterId = useId();
  const errorId = useId();
  const hintId = useId();
  const editor = useRef<TaskRichTextHandle>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const hasImages = Boolean(images);
  useImperativeHandle(ref, () => ({ focus: (options) => (editor.current ?? textarea.current)?.focus(options) }));
  // Fit the full text while the modal body owns scrolling. Rich text grows through normal layout.
  useLayoutEffect(() => {
    const grow = () => {
      const field = textarea.current;
      if (!field) return;
      field.style.height = "auto";
      if (field.scrollHeight > 0) field.style.height = `${field.scrollHeight + (field.offsetHeight - field.clientHeight)}px`;
    };
    grow();
    // Measured again when the field gets its box (the dialog opens after this effect) or a new width.
    if (!textarea.current || typeof ResizeObserver !== "function") return;
    let width = -1;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return;
      width = entry.contentRect.width;
      grow();
    });
    observer.observe(textarea.current);
    return () => observer.disconnect();
  }, [value, hasImages]);
  const describedBy = [error ? errorId : null, counterId].filter(Boolean).join(" ");
  const over = value.length > TASK_BOUNDS.textLength;
  const counter = <span id={counterId} className={`taskTextCounter${over ? " isOver" : ""}`}>{`${COUNT_FORMAT.format(value.length)} / ${COUNT_FORMAT.format(TASK_BOUNDS.textLength)}`}</span>;
  return <div className="newTaskField taskTextField">
    {images
      ? <>
        <span id={labelId} className="taskRichTextLabel" onClick={() => editor.current?.focus()}>Task</span>
        <div className="taskComposer">
          <TaskRichText ref={editor} labelledBy={labelId} describedBy={describedBy} value={value} onChange={onChange} onBlur={onBlur}
            readOnly={readOnly} images={images} placeholder="What should the session do?" />
          <TaskImageAttach held={taskImageIds(value).length} disabled={readOnly || images.disabled} hintId={hintId}
            onAttach={(files) => editor.current?.attach(files)}>{counter}</TaskImageAttach>
        </div>
      </>
      : <>
        <label htmlFor={fieldId}>Task</label>
        <textarea ref={textarea} id={fieldId} rows={6} maxLength={TASK_BOUNDS.textLength} value={value} readOnly={readOnly}
          placeholder="What should the session do?" aria-describedby={describedBy}
          onChange={(event) => onChange(event.currentTarget.value)} onBlur={onBlur} />
        {counter}
      </>}
    {images?.error && <p className="newTaskError" role="alert">{images.error}</p>}
    {error && <p id={errorId} className="newTaskError" role="alert">{error}</p>}
  </div>;
}

/** Run on, Effort, Remote Control and When done: four rows of the Run settings list. */
export function RunFields({ run, models, notice, onChange }: {
  run: TaskRun;
  models: TaskModelOptions;
  /** A notice under Run on, such as the observed model that differs from the plan. */
  notice?: ReactNode;
  onChange(run: TaskRun): void;
}) {
  const selectId = useId();
  const effortId = useId();
  const remoteId = useId();
  const remoteHintId = useId();
  const removeId = useId();
  const removeHintId = useId();
  const remote = canRemoteControl(run);
  return <>
    <TaskRow label="Run on" htmlFor={selectId} className="taskRunOn" top={notice ? "control" : undefined}>
      <CommandSelect id={selectId} aria-label="Run on" className="taskValueSelect" options={runSelectOptions(models, run)} value={runSelectValue(run)}
        onChange={(value) => onChange(withRemoteControl(withKeepWorktree(runFromSelectValue(value, run.effort), run.keepWorktree === true), run.remoteControl === true))} />
      {notice}
    </TaskRow>
    <TaskRow label="Effort" labelId={effortId}>
      <div className="commandSegmented taskEffort" role="group" aria-labelledby={effortId}>
        {TASK_EFFORTS.map((effort) => <button key={effort} type="button" aria-pressed={run.effort === effort}
          onClick={() => { if (run.effort !== effort) onChange({ ...run, effort }); }}>{EFFORT_LABELS[effort]}</button>)}
      </div>
    </TaskRow>
    {remote && <TaskRow label={REMOTE_CONTROL_LABEL} htmlFor={remoteId} className="taskRemoteControl">
      <div className="taskCheckRow">
        <input id={remoteId} type="checkbox" checked={run.remoteControl === true} aria-describedby={remoteHintId}
          onChange={(event) => onChange(withRemoteControl(run, event.currentTarget.checked))} />
        <span id={remoteHintId} className="newTaskHelper">Open the session on your phone too</span>
      </div>
    </TaskRow>}
    <TaskRow label="When done" className="taskRemoveWorktree">
      <div className="taskCheckRow">
        <input id={removeId} type="checkbox" checked={run.keepWorktree !== true} aria-describedby={removeHintId}
          onChange={(event) => onChange(withKeepWorktree(run, !event.currentTarget.checked))} />
        <label htmlFor={removeId}>{REMOVE_WORKTREE_LABEL}</label>
        <span id={removeHintId} className="newTaskHelper">Unpushed work is kept</span>
      </div>
    </TaskRow>
  </>;
}

/** Complete when: the six checks in a wrapping row, then the own condition the agent judges. A row of the Run settings list. */
export function CompleteWhenField({ draft, onDraftChange, onCommit }: {
  draft: CompleteWhenDraft;
  onDraftChange(next: CompleteWhenDraft): void;
  onCommit?(next: CompleteWhenDraft): void;
}) {
  const prefix = useId();
  const labelId = useId();
  const change = (next: CompleteWhenDraft) => { onDraftChange(next); onCommit?.(next); };
  return <TaskRow label="Complete when" labelId={labelId} className="taskCompleteWhen" top="check">
    <div className="taskCompleteWhenBody" role="group" aria-labelledby={labelId}>
      <div className="taskChecks">
        {TASK_CHECKS.map((check) => {
          const id = `${prefix}-${check}`;
          return <div className="taskCheckRow" key={check}>
            <input id={id} type="checkbox" checked={draft.checks.includes(check)} onChange={(event) => change(withCheck(draft, check, event.currentTarget.checked))} />
            <label htmlFor={id}>{CHECK_SHORT_LABELS[check]}</label>
          </div>;
        })}
      </div>
      <div className="taskOwnRow">
        <input type="text" className="taskOwnInput" aria-label="Own condition" maxLength={TASK_BOUNDS.ownConditionLength} placeholder="Own condition, judged by the agent (optional)"
          value={draft.ownText} onChange={(event) => onDraftChange({ ...draft, ownText: event.currentTarget.value })} onBlur={() => onCommit?.(draft)} />
      </div>
      <span className="newTaskHelper">{COMPLETE_WHEN_HINT}</span>
    </div>
  </TaskRow>;
}
