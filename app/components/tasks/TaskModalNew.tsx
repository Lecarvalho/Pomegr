"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskRun } from "../../../shared/task-contract";
import { FeatureFields } from "./FeatureFields";
import { TaskModalFrame } from "./TaskModalFrame";
import { DoneWhenField, RunFields, TaskTextField } from "./TaskFields";
import { createDesktopTask, createFailureMessage } from "./task-desktop";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, createPayload, type DoneWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, featureCreateInput, type FeatureDraft } from "./task-features";
import { firstColumnName, modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";

// Task modal, mode new (design contract G115-G158): Task, Feature and Step, Run on and Effort, Done when. Nothing is
// preselected in Run on and Effort; PR open and Tree clean start checked, and the feature is No feature. A new task
// always lands in the first column, which the subtitle names.

/**
 * The only mutations here go through the desktop bridge (`createDesktopTask`, and `feature_create` for a new
 * feature, which comes first). Success calls `onCreated` so the board is re-read; the monitor's committed
 * answer is what the board then shows.
 */
export function TaskModalNew({ repositoryId, repositoryName, board, refresh, onCreated, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onCreated(): void;
  onClose(): void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const models = useTaskModelOptions(board.runModels);
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
    return () => { mounted.current = false; };
  }, []);

  const submit = async () => {
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
    // The task exists once the monitor says so, even if the modal was closed in the meantime.
    if (result.ok) onCreated();
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(createFailureMessage(result.error));
      field.current?.focus({ preventScroll: true });
      return;
    }
    onClose();
  };

  return <TaskModalFrame title="New task" subtitle={modalSubtitle(repositoryName, firstColumnName(board.columns))} initialFocus={field} onClose={onClose}
    footer={<>
      <span className="taskModalSpacer" aria-hidden="true" />
      <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>
      <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit()}>Create task</button>
    </>}>
    <TaskTextField ref={field} value={text} onChange={setText} readOnly={busy} error={failure} />
    <FeatureFields draft={feature} board={board} error={featureError}
      onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
    <RunFields run={run} models={models} onChange={setRun} />
    <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
  </TaskModalFrame>;
}
