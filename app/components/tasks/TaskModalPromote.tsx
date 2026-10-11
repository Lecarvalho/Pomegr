"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TaskRun } from "../../../shared/task-contract";
import { FeatureFields } from "./FeatureFields";
import { IssueBody, IssueCharacterCount, IssueNotices, IssueStatusChip } from "./IssuePreview";
import { TaskIssueChip } from "./TaskIssueChip";
import { TaskModalFrame } from "./TaskModalFrame";
import { CompleteWhenField, RunFields } from "./TaskFields";
import { canPromote, tasksHref } from "./promote-issues-model";
import { updateDesktopTask } from "./task-desktop";
import { newTaskDefaults, type CompleteWhenDraft } from "./task-fields";
import { NO_FEATURE_DRAFT, type FeatureDraft } from "./task-features";
import { promoteTaskIssue, type TaskIssue } from "./task-issues-desktop";
import {
  PROMOTE_MESSAGES, firstColumnName, modalSubtitle, promoteOutcome, promotePatch, promoteUnsavedMessage, retryablePromote, shownOutcome,
  type PromoteOutcome, type TaskModalBoard,
} from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { useFeatureCreation } from "./use-feature-creation";

export function TaskModalSource({ number, caption, status, children }: { number: number; caption?: string; status?: ReactNode; children?: ReactNode }) {
  return <div className="taskIssueSource">
    <div className="taskSourceRow">
      <span className="taskSourceLabel">Source</span>
      <TaskIssueChip number={number} />
      {status}
      {caption && <span className="taskSourceCaption">{caption}</span>}
    </div>
    {children}
  </div>;
}

export function PromoteIssueSummary({ issue, notices }: { issue: TaskIssue; notices?: ReactNode }) {
  return <div className="taskIssueContent">
    <TaskModalSource number={issue.number} status={<IssueStatusChip issue={issue} />}>
      <h3 className="taskIssueTitle">{issue.title}</h3>
    </TaskModalSource>
    <IssueNotices issue={issue}>{notices}</IssueNotices>
    <div className="taskIssuePreview">
      <IssueBody body={issue.body} ranges={issue.hiddenComments.ranges} truncated={issue.bodyTruncated} />
      <IssueCharacterCount issue={issue} />
    </div>
  </div>;
}

export function PromoteOutcomeNotice({ outcome, reloading, onShowNewVersion }: { outcome: PromoteOutcome; reloading?: boolean; onShowNewVersion?(): void }) {
  if (outcome.kind === "conflict") {
    return <div className="taskNotice warning">
      <span role="alert">{PROMOTE_MESSAGES.conflict}</span>
      <button type="button" className="commandSecondaryAction" disabled={reloading || !onShowNewVersion} onClick={onShowNewVersion}>Show new version</button>
    </div>;
  }
  if (outcome.kind === "unsaved") return <p className="taskNotice warning" role="alert">{promoteUnsavedMessage(outcome.taskId)}</p>;
  return <p className={`taskNotice ${outcome.kind === "not_found" ? "warning" : "negative"}`} role="alert">{PROMOTE_MESSAGES[outcome.kind]}</p>;
}

export function PromotedNotice({ taskId, repositoryId }: { taskId: string; repositoryId: string }) {
  return <div className="taskNotice positive">
    <span>Already on the board as {taskId}.</span>
    <Link className="commandTextLink" href={tasksHref(repositoryId)}>Open board</Link>
  </div>;
}

/** The only mutations here go through the desktop bridge. */
export function TaskModalPromote({ repositoryId, repositoryName, issue, board, refresh, onReload, onPromoted, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  issue: TaskIssue;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onReload(): Promise<void>;
  onPromoted(taskId: string): void;
  onClose(): void;
}) {
  const mounted = useRef(false);
  const inFlight = useRef(false);
  const models = useTaskModelOptions(board.runModels);
  const [run, setRun] = useState<TaskRun>(() => newTaskDefaults(board.tasks).run);
  const [completeWhen, setCompleteWhen] = useState<CompleteWhenDraft>(() => newTaskDefaults(board.tasks).completeWhen);
  const [feature, setFeature] = useState<FeatureDraft>(NO_FEATURE_DRAFT);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [outcome, setOutcome] = useState<PromoteOutcome | null>(null);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const shown = shownOutcome(outcome, issue);
  const unsaved = shown?.kind === "unsaved";
  const featureName = feature.name.trim();
  const canSubmit = !busy && !reloading && canPromote(issue) && retryablePromote(shown) && (!feature.creating || featureName.length > 0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const submit = async () => {
    if (!canSubmit || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setOutcome(null);
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
    const promoted = await promoteTaskIssue(repositoryId, { number: issue.number, digest: issue.digest });
    if (!promoted.ok) {
      inFlight.current = false;
      if (mounted.current) { setBusy(false); setOutcome(promoteOutcome(promoted.error, issue.digest)); }
      return;
    }
    const { taskId } = promoted.value;
    const patch = promotePatch(run, completeWhen, draft);
    const saved = patch ? await updateDesktopTask(repositoryId, taskId, patch) : { ok: true as const };
    inFlight.current = false;
    void refresh();
    onPromoted(taskId);
    if (!mounted.current) return;
    setBusy(false);
    if (saved.ok) onClose(); else setOutcome({ kind: "unsaved", taskId });
  };

  const showNewVersion = async () => {
    if (reloading) return;
    setReloading(true);
    try { await onReload(); } finally { if (mounted.current) setReloading(false); }
  };

  const notices = <>
    {issue.taskId !== null && !unsaved && <PromotedNotice taskId={issue.taskId} repositoryId={repositoryId} />}
    {shown !== null && <PromoteOutcomeNotice outcome={shown} reloading={reloading} onShowNewVersion={() => void showNewVersion()} />}
  </>;

  return <TaskModalFrame title="New task" subtitle={modalSubtitle(repositoryName, firstColumnName(board.columns))} onClose={onClose}
    footer={unsaved
      ? <>
        <span className="taskModalSpacer" aria-hidden="true" />
        <button type="button" className="commandSecondaryAction" onClick={onClose}>Close</button>
      </>
      : <>
        <span className="taskModalNote taskModalCloses">The pull request will say Closes <span className="taskModalCloseRef">#{issue.number}</span>.</span>
        <button type="button" className="commandQuietAction" onClick={onClose}>Cancel</button>
        <button type="button" className="commandPrimaryAction" disabled={!canSubmit} onClick={() => void submit()}>Promote issue</button>
      </>}>
    <PromoteIssueSummary issue={issue} notices={notices} />
    {!unsaved && <>
      <FeatureFields draft={feature} board={board} error={featureError}
        onChange={(next) => { setFeature(next); setFeatureError(null); }} onCancelName={() => setFeature(NO_FEATURE_DRAFT)} />
      <RunFields run={run} models={models} onChange={setRun} />
      <CompleteWhenField draft={completeWhen} onDraftChange={setCompleteWhen} />
    </>}
  </TaskModalFrame>;
}
