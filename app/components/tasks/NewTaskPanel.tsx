"use client";

import { useEffect, useId, useRef, useState } from "react";
import { TASK_BOUNDS, type TaskBoard, type TaskRun } from "../../../shared/task-contract";
import { CommandIcon } from "../command-center/CommandIcon";
import { FeatureFields } from "./FeatureFields";
import { DoneWhenField, RunFields } from "./TaskFields";
import { createDesktopTask, createFailureMessage } from "./task-desktop";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, createPayload, type DoneWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, featureCreateInput, type FeatureDraft } from "./task-features";
import { useEscapeToClose, useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";

// New task side panel (design contract D184-D238): Task, Run on, Effort, Done when, then Feature and Step in feature
// with the folded list of the feature's tasks. Nothing is preselected in Run on and Effort; Pull request open and
// Working tree clean start checked, and the feature is No feature.

/**
 * The only mutations here go through the desktop bridge (`createDesktopTask`, and `feature_create` for a new
 * feature, which comes first). Success calls `onCreated` so the board is re-read; the monitor's committed
 * answer is what the board then shows.
 */
export function NewTaskPanel({ repositoryId, repositoryName, board, refresh, onCreated, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  /** The committed board: its unfinished features and their tasks fill the Feature fields. */
  board: Pick<TaskBoard, "columns" | "features" | "tasks"> & { queue?: Pick<TaskBoard["queue"], "order"> };
  refresh(): Promise<void>;
  onCreated(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const helperId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const models = useTaskModelOptions();
  const [text, setText] = useState("");
  const [run, setRun] = useState<TaskRun>(EMPTY_RUN);
  const [doneWhen, setDoneWhen] = useState<DoneWhenDraft>(DEFAULT_DONE_WHEN);
  const [feature, setFeature] = useState<FeatureDraft>(NO_FEATURE_DRAFT);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const trimmed = text.trim();
  const featureName = feature.name.trim();
  const canSubmit = trimmed.length > 0 && !busy && (!feature.creating || featureName.length > 0);

  useEffect(() => {
    mounted.current = true;
    field.current?.focus({ preventScroll: true });
    return () => { mounted.current = false; };
  }, []);
  useEscapeToClose(onClose);

  const submit = async (another: boolean) => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailure(null);
    setFeatureError(null);
    let draft = feature;
    if (feature.creating) {
      const created = await createFeature(featureName);
      if (!created.ok) {
        inFlight.current = false;
        if (mounted.current) { setBusy(false); setFeatureError(created.message); }
        return;
      }
      // The feature exists now: a retry after a failed task must attach to it, not create it again.
      draft = { ...feature, creating: false, featureId: created.id, name: "" };
      if (mounted.current) setFeature(draft);
    }
    const result = await createDesktopTask(repositoryId, createPayload(trimmed, run, doneWhen, featureCreateInput(draft, null)));
    inFlight.current = false;
    // The task exists once the monitor says so, even if the panel was closed in the meantime.
    if (result.ok) onCreated();
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(createFailureMessage(result.error));
      field.current?.focus({ preventScroll: true });
      return;
    }
    if (!another) { onClose(); return; }
    setText("");
    field.current?.focus({ preventScroll: true });
  };

  return <section className="newTaskPanel" role="dialog" aria-labelledby={titleId}>
    <header className="newTaskPanelHeader">
      <h2 id={titleId}>New task</h2>
      {repositoryName && <span className="newTaskPanelRepository">{repositoryName}</span>}
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      <button type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <div className="newTaskPanelBody">
      <div className="newTaskField">
        <label htmlFor={fieldId}>Task</label>
        <textarea ref={field} id={fieldId} rows={5} maxLength={TASK_BOUNDS.textLength} value={text} readOnly={busy}
          placeholder="What should the session do?" aria-describedby={failure ? `${helperId} ${errorId}` : helperId}
          onChange={(event) => setText(event.target.value)} />
        <p id={helperId} className="newTaskHelper">The card shows this text until the session has a title.</p>
        {failure && <p id={errorId} className="newTaskError" role="alert">{failure}</p>}
      </div>
      <RunFields run={run} models={models} onChange={setRun} />
      <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
      <FeatureFields draft={feature} board={board} error={featureError}
        onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
    </div>
    <footer className="newTaskPanelFooter">
      <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit(false)}>Create task</button>
      <button type="button" className="commandSecondaryAction" disabled={!canSubmit} onClick={() => void submit(true)}>Create and add another</button>
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      <span className="newTaskPanelNote">Goes to Backlog, not queued</span>
    </footer>
  </section>;
}
