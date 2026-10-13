"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, TaskCheck } from "../../../shared/task-contract";
import { sessionListTime } from "../../dashboard-utils";
import { FeatureFields } from "./FeatureFields";
import { IssueCreateRow } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { TaskModalSource } from "./TaskModalPromote";
import { CompleteWhenField, RunFields, TaskTextField } from "./TaskFields";
import { TaskSessionLink } from "./TaskSessionLink";
import { TaskSessionsField } from "./TaskSessionsField";
import { TaskStartTimeField } from "./TaskStartTimeField";
import {
  ASSIGN_FAILURE_MESSAGE, ASSIGN_LIMIT_MESSAGE, DELETE_FAILURE_MESSAGE, FEATURE_ATTACH_FAILURE_MESSAGE, QUEUE_ADD_FAILURE_MESSAGE, QUEUE_REMOVE_FAILURE_MESSAGE, REQUEUE_FAILURE_MESSAGE,
  RESOLVE_DONE_FAILURE_MESSAGE, UPDATE_FAILURE_MESSAGE, addDesktopQueueTask, deleteDesktopTask, removeDesktopQueueTask, requeueDesktopTask,
  UNASSIGN_FAILURE_MESSAGE, assignDesktopTaskSession, resolveDesktopTaskDone, unassignDesktopTaskSession, updateDesktopTask,
} from "./task-desktop";
import { observedModelDiffers } from "./task-fields";
import { taskImagesAvailable } from "./task-images-desktop";
import { taskIssuesAvailable } from "./task-issues-desktop";
import { featureDraftFromTask, type FeatureDraft } from "./task-features";
import { modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import {
  AWAITING_REPORT_NOTE, STARTED_NOTE, STARTED_REQUEUE_NOTE, taskAwaitsReport, taskChip, taskIssueNumber, taskSessionHref, taskSessionTitle, taskStarted,
} from "./task-presentation";
import { SAVE_FIRST_LINE, taskDraftPatch, useTaskDraft } from "./use-task-draft";
import { useFeatureCreation } from "./use-feature-creation";
import { shownTaskText, useStoredImages } from "./use-task-images";
import { SESSION_CANDIDATES_SHOWN, useTaskSessionCandidates } from "./use-task-session-candidates";
import { useTaskStart } from "./use-task-start";

const STALLED_NOTE = "The session ended with no report.";

function reportLine(report: NonNullable<Task["report"]>) {
  // The time sits in parentheses.
  const time = Number.isFinite(Date.parse(report.at)) ? <> (<time dateTime={report.at}>{sessionListTime(report.at)}</time>)</> : null;
  if (report.blockReason !== null) return <>Agent reported it cannot continue{time}: {report.blockReason}</>;
  return report.attention ? <>Agent reported complete{time} and asks for your attention: {report.attention}</> : <>Agent reported complete{time}.</>;
}

export function TaskModalEdit({ repositoryId, repositoryName, task, board, refresh, onOpenTask, onChanged, onDeleted, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  task: Task;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  onChanged(): void;
  onDeleted(): void;
  onClose(): void;
}) {
  const models = useTaskModelOptions(board.runModels);
  const shown = useMemo(() => ({ ...task, text: shownTaskText(task.text, task.images) }), [task]);
  const { draft, dirty, canSave, setText, setRun, setCompleteWhen, setFeature } = useTaskDraft(shown);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const saveInFlight = useRef(false);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  useEffect(() => { if (confirming) cancel.current?.focus({ preventScroll: true }); }, [confirming]);

  const chip = taskChip(task, task.id === board.queue?.order[0]);
  const unresolved = task.state === "needs_review" || task.state === "blocked" || task.state === "stalled";
  const results = useMemo(() => new Map<TaskCheck, boolean>((task.report?.results ?? []).map((entry) => [entry.check, entry.passed])), [task.report]);
  const outcomeNote = task.report ? reportLine(task.report) : task.state === "stalled" ? STALLED_NOTE : null;
  const start = useTaskStart(repositoryId, task, board, dirty, refresh);
  const images = useStoredImages(repositoryId, task);
  const imagesOffered = taskImagesAvailable();
  // A task that needs the user offers its resolutions instead of Start session.
  const showStart = start.available && !unresolved;
  const waiting = task.state === "not_queued" || task.state === "queued" || task.state === "scheduled";
  const schedulable = waiting && task.session === null;
  // A queued task whose session has started is in progress: it has left the queue, so Remove from queue does nothing for it.
  const inProgress = task.session !== null && (task.state === "queued" || task.state === "scheduled");
  // A linked task with no report never resolves by itself, so the user can mark it done or requeue it.
  const awaitingReport = taskAwaitsReport(task);
  // The session works from the task as it was when it started, so a started task is read-only until it is requeued.
  const locked = taskStarted(task);
  const sessionTitle = taskSessionTitle(task);
  const issueNumber = taskIssueNumber(task);
  const issueOffered = issueNumber === null && taskIssuesAvailable();
  const hasSessionLink = task.session !== null && taskSessionHref(task.session.id) !== null;
  const columnName = board.columns.find((column) => column.id === task.columnId)?.name ?? null;
  const blocked = saving || deleting;
  // A done task takes no report, so it takes no new session. The sessions it holds can still be unassigned.
  const assigned = useMemo(() => task.assigned ?? [], [task.assigned]);
  const listed = useTaskSessionCandidates(repositoryId, task.state !== "done");
  const candidates = useMemo(() => listed?.filter((candidate) => candidate.id !== task.session?.id && !assigned.some((session) => session.id === candidate.id)).slice(0, SESSION_CANDIDATES_SHOWN),
    [listed, task.session, assigned]);
  const startLine = showStart && start.line !== SAVE_FIRST_LINE ? start.line : null;
  // Only a task that has not started can hold a draft.
  const saveLine = dirty && !confirming && startLine === null;
  const folderOffered = showStart && start.folder.offered;
  const folderLine = showStart ? start.folder.line : null;
  const separateOffered = showStart && start.separate.offered;
  const resolveRow = !confirming && (startLine || saveLine || folderLine || folderOffered || separateOffered || unresolved || awaitingReport);

  const save = async () => {
    if (!canSave || saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setFailure(null);
    setFeatureError(null);
    let current = draft;
    if (draft.feature.creating) {
      const created = await createFeature(draft.feature.name.trim());
      if (!created.ok) {
        saveInFlight.current = false;
        setSaving(false);
        setFeatureError(created.message);
        return;
      }
      // The feature exists now.
      current = { ...draft, feature: { featureId: created.id, creating: false, name: "", step: null } };
      setFeature(current.feature);
    }
    const patch = taskDraftPatch(shown, current);
    const imageFailure = await images.store(task.id, current.text);
    if (imageFailure !== null) {
      saveInFlight.current = false;
      setSaving(false);
      setFailure(imageFailure);
      onChanged();
      return;
    }
    const result = patch ? await updateDesktopTask(repositoryId, task.id, patch) : { ok: true as const };
    if (result.ok) await images.prune(current.text);
    saveInFlight.current = false;
    setSaving(false);
    if (result.ok) { onChanged(); onClose(); return; }
    setFailure(patch?.featureId && result.error === "conflict" ? FEATURE_ATTACH_FAILURE_MESSAGE : UPDATE_FAILURE_MESSAGE);
  };

  const changeFeature = (next: FeatureDraft) => {
    setFeature(next);
    setFeatureError(null);
  };
  const cancelName = () => {
    setFeatureError(null);
    setFeature(featureDraftFromTask(task));
  };

  const changeQueue = async (add: boolean) => {
    if (queueing) return;
    setQueueing(true);
    setFailure(null);
    const result = await (add ? addDesktopQueueTask(repositoryId, task.id) : removeDesktopQueueTask(repositoryId, task.id));
    setQueueing(false);
    if (result.ok) onChanged(); else setFailure(add ? QUEUE_ADD_FAILURE_MESSAGE : QUEUE_REMOVE_FAILURE_MESSAGE);
  };

  const resolve = async (done: boolean) => {
    if (resolving) return;
    setResolving(true);
    setFailure(null);
    const result = await (done ? resolveDesktopTaskDone(repositoryId, task.id) : requeueDesktopTask(repositoryId, task.id));
    setResolving(false);
    if (result.ok) onChanged(); else setFailure(done ? RESOLVE_DONE_FAILURE_MESSAGE : REQUEUE_FAILURE_MESSAGE);
  };

  const changeAssignment = async (sessionId: string, assign: boolean) => {
    if (assigning) return;
    setAssigning(true);
    setAssignError(null);
    const result = await (assign ? assignDesktopTaskSession(repositoryId, task.id, sessionId) : unassignDesktopTaskSession(repositoryId, task.id, sessionId));
    setAssigning(false);
    if (result.ok) onChanged();
    else setAssignError(!assign ? UNASSIGN_FAILURE_MESSAGE : result.error === "limit" ? ASSIGN_LIMIT_MESSAGE : ASSIGN_FAILURE_MESSAGE);
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

  return <TaskModalFrame title="Task" subtitle={modalSubtitle(repositoryName, columnName)} closeOnScrim={!dirty} onClose={onClose}
    titleExtra={<>
      <span className="taskModalId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </>}
    footer={<>
      {resolveRow && <div className="taskModalResolve">
        {startLine && <span className="taskModalNote" role="status" aria-live="polite">{startLine}</span>}
        {saveLine && <span className="taskModalNote" role="status" aria-live="polite">{SAVE_FIRST_LINE}</span>}
        {folderLine && <span className="taskModalNote" role="status" aria-live="polite">{folderLine}</span>}
        {folderOffered && <button type="button" className="commandSecondaryAction" disabled={start.folder.opening} onClick={() => void start.folder.open()}>Open folder</button>}
        {separateOffered && <button type="button" className="commandSecondaryAction" onClick={() => void start.separate.run()}>Start in separate worktree</button>}
        {unresolved && <>
          <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(true)}>{task.state === "needs_review" ? "Mark done" : "Mark done and resume queue"}</button>
          <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(false)}>Requeue task</button>
        </>}
        {awaitingReport && <>
          <span className="taskModalNote">{AWAITING_REPORT_NOTE}</span>
          <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(true)}>Mark done</button>
          <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(false)}>Requeue task</button>
        </>}
      </div>}
      {confirming
        ? <div className="taskModalConfirm" role="group" aria-label="Confirm delete">
          <span className="taskModalNote">Delete {task.id}? This cannot be undone.</span>
          <button type="button" className="commandSecondaryAction" disabled={deleting} onClick={() => void remove()}>Delete {task.id}</button>
          <button ref={cancel} type="button" className="commandQuietAction" disabled={deleting} onClick={() => setConfirming(false)}>Keep task</button>
        </div>
        : <button type="button" className="commandQuietAction" disabled={blocked} onClick={() => setConfirming(true)}>Delete task</button>}
      <span className="taskModalSpacer" aria-hidden="true" />
      {!confirming && <>
        {waiting && <button type="button" className="commandSecondaryAction" disabled={queueing || dirty || inProgress} onClick={() => void changeQueue(task.state === "not_queued")}>
          {task.state === "not_queued" ? "Add to queue" : "Remove from queue"}
        </button>}
        {showStart && <button type="button" className="commandSecondaryAction" disabled={start.disabled} onClick={() => void start.run()}>
          {start.pending ? "Starting…" : "Start session"}
        </button>}
        {!locked && <button type="button" className="commandPrimaryAction" disabled={!canSave || saving} onClick={() => void save()}>Save</button>}
      </>}
    </>}>
    {issueNumber !== null && <TaskModalSource number={issueNumber} caption="GitHub issue" />}
    {issueOffered && <IssueCreateRow repositoryId={repositoryId} taskId={task.id} unsaved={dirty} saveFirst={saveLine || confirming ? null : SAVE_FIRST_LINE}
      onChanged={onChanged} />}
    {(sessionTitle !== null || hasSessionLink) && <div className="taskModalSession">
      {sessionTitle !== null && <p className="taskModalSessionTitle">{sessionTitle}</p>}
      <span className="newTaskHelper">
        {sessionTitle !== null && <>Title from the session{hasSessionLink && " · "}</>}
        {task.session && <TaskSessionLink sessionId={task.session.id} />}
      </span>
    </div>}
    <TaskTextField value={draft.text} onChange={setText} readOnly={saving || locked} error={failure}
      helper={locked ? (unresolved || awaitingReport ? STARTED_REQUEUE_NOTE : STARTED_NOTE) : undefined}
      images={imagesOffered ? { urls: images.urls, disabled: blocked || locked, error: images.error, onAttach: images.attach } : undefined} />
    <FeatureFields draft={draft.feature} board={board} selfId={task.id} error={featureError} disabled={locked} onChange={changeFeature}
      onCancelName={cancelName} onOpenTask={onOpenTask} />
    <div className="taskRunGroup">
      <RunFields run={draft.run} models={models} disabled={locked} onChange={setRun} />
      {observedModelDiffers(draft.run.model, task.session?.observedModel) && <div className="taskModelNotice" role="status">
        <span className="taskModelNoticeTitle">Observed model differs</span>{" "}
        <span>Planned <code>{draft.run.model}</code>, latest recorded request used <code>{task.session?.observedModel}</code>.</span>
      </div>}
    </div>
    <CompleteWhenField draft={draft.completeWhen} results={task.report ? results : undefined}
      ownNote={task.report && draft.completeWhen.ownText.trim() !== "" && task.completeWhen.own !== null ? "Agent-reported" : null}
      footnote={outcomeNote ? <span className="newTaskHelper taskCompleteWhenNote">{outcomeNote}</span> : undefined} disabled={locked}
      onDraftChange={setCompleteWhen} />
    <TaskSessionsField started={task.session} assigned={assigned} candidates={candidates} busy={assigning || blocked} error={assignError}
      onAssign={(sessionId) => void changeAssignment(sessionId, true)} onUnassign={(sessionId) => void changeAssignment(sessionId, false)} />
    {schedulable && <TaskStartTimeField repositoryId={repositoryId} task={task} onChanged={onChanged} />}
  </TaskModalFrame>;
}
