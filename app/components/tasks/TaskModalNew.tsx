"use client";

import { useEffect, useRef, useState } from "react";
import type { TaskRun } from "../../../shared/task-contract";
import { FeatureFields } from "./FeatureFields";
import { IssueCreateCheckbox, useIssueCreateOption } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { DoneWhenField, RunFields, TaskTextField } from "./TaskFields";
import { createDesktopTask, createFailureMessage } from "./task-desktop";
import { DEFAULT_DONE_WHEN, EMPTY_RUN, createPayload, type DoneWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, featureCreateInput, type FeatureDraft } from "./task-features";
import { createTaskIssue } from "./task-issues-desktop";
import { firstColumnName, modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";

// Task modal, mode new (design contract G115-G158): Task, Feature and Step, Run on and Effort, Done when. Nothing is
// preselected in Run on and Effort; PR open and Tree clean start checked, and the feature is No feature. A new task
// always lands in the first column, which the subtitle names. On the desktop a checkbox under the Task counter also creates
// a GitHub issue from the saved task (G129-G131); the task is created first and an issue failure never costs it.

/**
 * The only mutations here go through the desktop bridge (`createDesktopTask`, and `feature_create` for a new
 * feature, which comes first). Success calls `onCreated` so the board is re-read; the monitor's committed
 * answer is what the board then shows. When the ticked issue create fails, the task stays as created and the modal does
 * not close silently: after `onCreated` it calls `onIssueFailed` with the new task's ID so the page can open that task,
 * where the fixed reason is shown (without the prop it closes as on success).
 */
export function TaskModalNew({ repositoryId, repositoryName, board, refresh, onCreated, onIssueFailed, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onCreated(): void;
  onIssueFailed?: (taskId: string) => void;
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
  const [wantIssue, setWantIssue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const issueOption = useIssueCreateOption(repositoryId);
  const issueChecked = issueOption.kind === "can" && wantIssue;
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
    // The task exists once the monitor says so, even if the modal was closed in the meantime. The issue comes second and
    // its failure is remembered for the task's own modal, which opens in place of this one: it never undoes or blocks the task.
    let issueFailedFor: string | null = null;
    if (result.ok) {
      if (issueChecked && result.taskId !== null && !(await createTaskIssue(repositoryId, result.taskId)).ok) issueFailedFor = result.taskId;
      onCreated();
    }
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (!result.ok) {
      setFailure(createFailureMessage(result.error));
      field.current?.focus({ preventScroll: true });
      return;
    }
    if (issueFailedFor !== null && onIssueFailed) onIssueFailed(issueFailedFor);
    else onClose();
  };

  return <TaskModalFrame title="New task" subtitle={modalSubtitle(repositoryName, firstColumnName(board.columns))} initialFocus={field} closeOnScrim={trimmed.length === 0 && !busy} onClose={onClose}
    footer={<>
      <span className="taskModalSpacer" aria-hidden="true" />
      <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>
      <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit()}>{busy ? "Creating…" : "Create task"}</button>
    </>}>
    <TaskTextField ref={field} value={text} onChange={setText} readOnly={busy} error={failure} />
    <IssueCreateCheckbox option={issueOption} checked={issueChecked} disabled={busy} onChange={setWantIssue} />
    <FeatureFields draft={feature} board={board} error={featureError}
      onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
    <RunFields run={run} models={models} onChange={setRun} />
    <DoneWhenField draft={doneWhen} onDraftChange={setDoneWhen} />
  </TaskModalFrame>;
}
