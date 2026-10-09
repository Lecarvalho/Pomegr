"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TASK_BOUNDS, type Task, type TaskCheck, type TaskRun } from "../../../shared/task-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { sessionListTime } from "../../dashboard-utils";
import { CommandIcon } from "../command-center/CommandIcon";
import { DoneWhenField, RunFields } from "./TaskFields";
import {
  DELETE_FAILURE_MESSAGE, UPDATE_FAILURE_MESSAGE, deleteDesktopTask, updateDesktopTask, type TaskFieldsInput,
} from "./task-desktop";
import { doneWhenFromTask, observedModelDiffers, toDoneWhen, type DoneWhenDraft } from "./task-fields";
import { useEscapeToClose, useTaskModelOptions } from "./task-panel-hooks";
import { taskCardTitle, taskChip } from "./task-presentation";

// Task side panel (design contract D239-D272, D295, D298, D299), opened from a card. It reuses the New task
// panel's drawer chrome. A select, segment or checkbox saves when it changes; the Task textarea and the
// own-condition input save when they lose focus after a change. Feature, Step and the feature disclosure
// (D273-D294) and Mark done / Requeue (D296, D297) belong to later parts and are not drawn.

type Patch = { text?: string } & TaskFieldsInput;

function sessionHref(sessionId: string) {
  try {
    return `/sessions/${encodeSessionRoute(sessionId)}`;
  } catch {
    return "/sessions";
  }
}

function reportLine(report: NonNullable<Task["report"]>) {
  const time = Number.isFinite(Date.parse(report.at)) ? <> <time dateTime={report.at}>{sessionListTime(report.at)}</time></> : null;
  return report.blockReason === null
    ? <>Agent reported complete{time}.</>
    : <>Agent reported it cannot continue{time}: {report.blockReason}</>;
}

/** Every change goes through the desktop bridge; success refreshes the board, failure reverts the field and says so once. */
export function TaskPanel({ repositoryId, task, onChanged, onDeleted, onClose }: {
  repositoryId: string;
  task: Task;
  onChanged(): void;
  onDeleted(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const errorId = useId();
  const models = useTaskModelOptions();
  const [text, setText] = useState(task.text);
  const [run, setRun] = useState<TaskRun>(task.run);
  const [doneWhen, setDoneWhen] = useState<DoneWhenDraft>(() => doneWhenFromTask(task.doneWhen));
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // What the monitor was last asked to store, so a quick toggle back is still sent and an unchanged blur is not.
  const sent = useRef({ text: task.text, run: JSON.stringify(task.run), doneWhen: JSON.stringify(toDoneWhen(doneWhenFromTask(task.doneWhen))) });
  const stored = useRef(task);
  useEffect(() => { stored.current = task; }, [task]);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (confirming) cancel.current?.focus({ preventScroll: true }); }, [confirming]);
  useEscapeToClose(onClose);

  const chip = taskChip(task);
  const results = useMemo(() => new Map<TaskCheck, boolean>((task.report?.results ?? []).map((entry) => [entry.check, entry.passed])), [task.report]);
  const sessionTitle = task.session?.title ?? null;

  const save = async (patch: Patch) => {
    setFailure(null);
    const result = await updateDesktopTask(repositoryId, task.id, patch);
    if (result.ok) { onChanged(); return; }
    // Revert only what this change touched, and forget that it was sent.
    const original = stored.current;
    if (patch.text !== undefined) { setText(original.text); sent.current.text = original.text; }
    if (patch.run) { setRun(original.run); sent.current.run = JSON.stringify(original.run); }
    if (patch.doneWhen) {
      const draft = doneWhenFromTask(original.doneWhen);
      setDoneWhen(draft);
      sent.current.doneWhen = JSON.stringify(toDoneWhen(draft));
    }
    setFailure(UPDATE_FAILURE_MESSAGE);
  };

  const changeRun = (next: TaskRun) => {
    setRun(next);
    sent.current.run = JSON.stringify(next);
    void save({ run: next });
  };
  const commitDoneWhen = (next: DoneWhenDraft) => {
    const value = toDoneWhen(next);
    const serialized = JSON.stringify(value);
    if (serialized === sent.current.doneWhen) return;
    sent.current.doneWhen = serialized;
    void save({ doneWhen: value });
  };
  const commitText = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      setText(sent.current.text);
      setFailure("The task needs some text.");
      return;
    }
    setText(trimmed);
    if (trimmed === sent.current.text) return;
    sent.current.text = trimmed;
    void save({ text: trimmed });
  };

  const remove = async () => {
    if (deleting) return;
    setDeleting(true);
    setFailure(null);
    const result = await deleteDesktopTask(repositoryId, task.id);
    if (result.ok) { onChanged(); onDeleted(); return; }
    setDeleting(false);
    setConfirming(false);
    setFailure(DELETE_FAILURE_MESSAGE);
  };

  return <section className="newTaskPanel taskPanel" role="dialog" aria-label={`Task ${task.id}`}>
    <header className="newTaskPanelHeader">
      <span className="taskPanelId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      <button ref={closeButton} type="button" className="commandIconAction" aria-label="Close task" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <div className="newTaskPanelBody">
      <div className="taskPanelTitle">
        <h2 id={titleId} className="taskPanelHeading">{taskCardTitle(task)}</h2>
        {sessionTitle && <span className="newTaskHelper">Title from the session{task.session && <> · <Link className="commandTextLink" href={sessionHref(task.session.id)}>Open session</Link></>}</span>}
        <div className="newTaskField">
          <label htmlFor={fieldId}>Task</label>
          <textarea id={fieldId} rows={3} maxLength={TASK_BOUNDS.textLength} value={text} aria-describedby={failure ? errorId : undefined}
            onChange={(event) => setText(event.target.value)} onBlur={commitText} />
        </div>
        {failure && <p id={errorId} className="newTaskError" role="alert">{failure}</p>}
      </div>
      <div className="taskRunGroup">
        <RunFields run={run} models={models} onChange={changeRun} />
        {observedModelDiffers(run.model, task.session?.observedModel) && <div className="taskModelNotice" role="status">
          <span className="taskModelNoticeTitle">Observed model differs</span>
          <span>Planned <code>{run.model}</code>, latest recorded request used <code>{task.session?.observedModel}</code>.</span>
        </div>}
      </div>
      <DoneWhenField draft={doneWhen} layout="list" results={task.report ? results : undefined} ownNote={task.report && doneWhen.ownEnabled && task.doneWhen.own !== null ? "Agent-reported" : null}
        footnote={task.report ? <span className="newTaskHelper taskDoneWhenNote">{reportLine(task.report)}</span> : undefined}
        onDraftChange={setDoneWhen} onCommit={commitDoneWhen} />
    </div>
    <footer className="newTaskPanelFooter taskPanelFooter">
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      {confirming
        ? <div className="taskPanelConfirm" role="group" aria-label="Confirm delete">
          <span className="newTaskPanelNote">Delete {task.id}? This cannot be undone.</span>
          <button type="button" className="commandSecondaryAction" disabled={deleting} onClick={() => void remove()}>Delete {task.id}</button>
          <button ref={cancel} type="button" className="commandQuietAction" disabled={deleting} onClick={() => setConfirming(false)}>Keep task</button>
        </div>
        : <button type="button" className="commandQuietAction" onClick={() => setConfirming(true)}>Delete task</button>}
    </footer>
  </section>;
}
