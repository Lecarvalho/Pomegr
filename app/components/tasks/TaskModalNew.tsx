"use client";

import { useEffect, useRef, useState } from "react";
import { TASK_BOUNDS, type TaskRun } from "../../../shared/task-contract";
import { CommandSplitAction, type CommandSplitItem } from "../command-center/CommandSplitAction";
import { FeatureFields } from "./FeatureFields";
import { IssueCreateCheckbox, useIssueCreateOption } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { CompleteWhenField, RunFields, TaskTextField, type TaskTextHandle } from "./TaskFields";
import {
  QUEUE_ADD_FAILURE_MESSAGE, addDesktopQueueTask, createDesktopTask, createFailureMessage, rememberCreateFollowUp, startDesktopTask, useTaskEditAvailability,
} from "./task-desktop";
import { createPayload, newTaskDefaults, type CompleteWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, featureCreateInput, type FeatureDraft } from "./task-features";
import { rememberImageCreateFailure, taskImagesAvailable } from "./task-images-desktop";
import { createTaskIssue } from "./task-issues-desktop";
import { firstColumnName, modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";
import { useDraftImages } from "./use-task-images";

// What the modal does with the task once it exists.
type After = "create" | "queue" | "start";

export function TaskModalNew({ repositoryId, repositoryName, board, refresh, onCreated, onFollowUpFailed, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onCreated(): void;
  onFollowUpFailed?: (taskId: string) => void;
  onClose(): void;
}) {
  const field = useRef<TaskTextHandle>(null);
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const models = useTaskModelOptions(board.runModels);
  const [text, setText] = useState("");
  const [run, setRun] = useState<TaskRun>(() => newTaskDefaults(board.tasks).run);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(() => newTaskDefaults(board.tasks).completeWhen);
  const [feature, setFeature] = useState<FeatureDraft>(NO_FEATURE_DRAFT);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [wantIssue, setWantIssue] = useState(false);
  const [busy, setBusy] = useState<After | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const issueOption = useIssueCreateOption(repositoryId);
  const images = useDraftImages(repositoryId);
  const imagesOffered = taskImagesAvailable();
  const issueChecked = issueOption.kind === "can" && wantIssue;
  const paired = useTaskEditAvailability() === "paired";
  const followUps: CommandSplitItem<"queue" | "start">[] = [
    { value: "queue", label: "Create and queue", detail: "Goes to the end of Ready." },
    { value: "start", label: "Create and start session", detail: paired ? "Opens a new terminal on the computer running Pomegr." : "Opens a new terminal window now." },
  ];
  const trimmed = text.trim();
  const featureName = feature.name.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= TASK_BOUNDS.textLength && busy === null && (!feature.creating || featureName.length > 0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = async (after: After) => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(after);
    setFailure(null);
    setFeatureError(null);
    let draft = feature;
    if (feature.creating) {
      const created = await createFeature(featureName);
      if (!created.ok) {
        inFlight.current = false;
        if (mounted.current) { setBusy(null); setFeatureError(created.message); }
        return;
      }
      // The feature exists now.
      draft = { ...feature, creating: false, featureId: created.id, name: "" };
      if (mounted.current) setFeature(draft);
    }
    const result = await createDesktopTask(repositoryId, createPayload(trimmed, run, completeWhen, featureCreateInput(draft, null)));
    // The task exists once the monitor says so, even if the modal was closed in the meantime.
    let followUpFailedFor: string | null = null;
    if (result.ok) {
      // The images the text names come first, so an issue failure never leaves them behind.
      if (result.taskId !== null && await images.store(result.taskId, trimmed) !== null) {
        rememberImageCreateFailure(repositoryId, result.taskId);
        followUpFailedFor = result.taskId;
      }
      if (issueChecked && result.taskId !== null && !(await createTaskIssue(repositoryId, result.taskId)).ok) followUpFailedFor = result.taskId;
      // The task is queued or started only as it was written: a lost image or issue opens the task instead.
      if (result.taskId !== null && followUpFailedFor === null) {
        if (after === "queue" && !(await addDesktopQueueTask(repositoryId, result.taskId)).ok) {
          rememberCreateFollowUp(repositoryId, result.taskId, { failure: QUEUE_ADD_FAILURE_MESSAGE });
          followUpFailedFor = result.taskId;
        }
        if (after === "start") {
          const status = await startDesktopTask(repositoryId, result.taskId);
          if (status !== "started") {
            rememberCreateFollowUp(repositoryId, result.taskId, { start: status });
            followUpFailedFor = result.taskId;
          }
        }
      }
      onCreated();
    }
    inFlight.current = false;
    if (!mounted.current) return;
    setBusy(null);
    if (!result.ok) {
      setFailure(createFailureMessage(result.error));
      field.current?.focus({ preventScroll: true });
      return;
    }
    if (followUpFailedFor !== null && onFollowUpFailed) onFollowUpFailed(followUpFailedFor);
    else onClose();
  };

  return <TaskModalFrame title="New task" subtitle={modalSubtitle(repositoryName, firstColumnName(board.columns))} initialFocus={field} closeOnScrim={trimmed.length === 0 && busy === null} onClose={onClose}
    footer={<>
      <span className="taskModalSpacer" aria-hidden="true" />
      <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>
      <CommandSplitAction label={busy === null ? "Create task" : busy === "start" ? "Starting…" : "Creating…"} menuLabel="More ways to create" items={followUps} disabled={!canSubmit}
        onAction={() => void submit("create")} onSelect={(value) => void submit(value)} />
    </>}>
    <TaskTextField ref={field} value={text} onChange={setText} readOnly={busy !== null} error={failure}
      images={imagesOffered ? { urls: images.urls, disabled: busy !== null, error: images.error, onAttach: images.attach } : undefined} />
    <IssueCreateCheckbox option={issueOption} checked={issueChecked} disabled={busy !== null} onChange={setWantIssue} />
    <FeatureFields draft={feature} board={board} error={featureError}
      onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
    <RunFields run={run} models={models} onChange={setRun} />
    <CompleteWhenField draft={completeWhen} onDraftChange={setCompleteWhen} />
  </TaskModalFrame>;
}
