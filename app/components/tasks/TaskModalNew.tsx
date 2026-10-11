"use client";

import { useEffect, useRef, useState } from "react";
import { TASK_BOUNDS, type TaskRun } from "../../../shared/task-contract";
import { FeatureFields } from "./FeatureFields";
import { IssueCreateCheckbox, useIssueCreateOption } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { CompleteWhenField, RunFields, TaskTextField, type TaskTextHandle } from "./TaskFields";
import { createDesktopTask, createFailureMessage } from "./task-desktop";
import { DEFAULT_COMPLETE_WHEN, EMPTY_RUN, createPayload, type CompleteWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, featureCreateInput, type FeatureDraft } from "./task-features";
import { rememberImageCreateFailure, taskImagesAvailable } from "./task-images-desktop";
import { createTaskIssue } from "./task-issues-desktop";
import { firstColumnName, modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";
import { useDraftImages } from "./use-task-images";

export function TaskModalNew({ repositoryId, repositoryName, board, refresh, onCreated, onIssueFailed, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onCreated(): void;
  onIssueFailed?: (taskId: string) => void;
  onClose(): void;
}) {
  const field = useRef<TaskTextHandle>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const models = useTaskModelOptions(board.runModels);
  const [text, setText] = useState("");
  const [run, setRun] = useState<TaskRun>(EMPTY_RUN);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(DEFAULT_COMPLETE_WHEN);
  const [feature, setFeature] = useState<FeatureDraft>(NO_FEATURE_DRAFT);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [wantIssue, setWantIssue] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const issueOption = useIssueCreateOption(repositoryId);
  const images = useDraftImages(repositoryId);
  const imagesOffered = taskImagesAvailable();
  const issueChecked = issueOption.kind === "can" && wantIssue;
  const trimmed = text.trim();
  const featureName = feature.name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= TASK_BOUNDS.textLength && !busy && (!feature.creating || featureName.length > 0);

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
      // The feature exists now.
      draft = { ...feature, creating: false, featureId: created.id, name: "" };
      if (mounted.current) setFeature(draft);
    }
    const result = await createDesktopTask(repositoryId, createPayload(trimmed, run, completeWhen, featureCreateInput(draft, null)));
    // The task exists once the monitor says so, even if the modal was closed in the meantime.
    let issueFailedFor: string | null = null;
    if (result.ok) {
      // The images the text names come first, so an issue failure never leaves them behind.
      if (result.taskId !== null && await images.store(result.taskId, trimmed) !== null) {
        rememberImageCreateFailure(repositoryId, result.taskId);
        issueFailedFor = result.taskId;
      }
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
    <TaskTextField ref={field} value={text} onChange={setText} readOnly={busy} error={failure}
      images={imagesOffered ? { urls: images.urls, disabled: busy, error: images.error, onAttach: images.attach } : undefined} />
    <IssueCreateCheckbox option={issueOption} checked={issueChecked} disabled={busy} onChange={setWantIssue} />
    <FeatureFields draft={feature} board={board} error={featureError}
      onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
    <RunFields run={run} models={models} onChange={setRun} />
    <CompleteWhenField draft={completeWhen} onDraftChange={setCompleteWhen} />
  </TaskModalFrame>;
}
