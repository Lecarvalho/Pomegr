"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { FeatureFields } from "./FeatureFields";
import { TaskIssueRow } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { TaskQueueWait } from "./TaskQueueWait";
import { CompleteWhenField, RunFields, TaskTextField } from "./TaskFields";
import { TaskReadView } from "./TaskReadView";
import { TaskReviewPanel, reviewListsConditions, taskHasReview, taskNeedsUser } from "./TaskReviewPanel";
import { RunSettings } from "./TaskRows";
import { ModelDiffersNotice, TaskRunSettingsRead } from "./TaskRunSettingsRead";
import { TaskSessionLine } from "./TaskSessionLine";
import { TaskSessionsField } from "./TaskSessionsField";
import { TaskAfterField } from "./TaskAfterField";
import { AFTER_FAILURE_MESSAGE, AFTER_LOOP_MESSAGE, afterMakesLoop, afterStartLine, unfinishedAfter } from "./task-after-model";
import { TaskStartTimeField } from "./TaskStartTimeField";
import {
  ASSIGN_FAILURE_MESSAGE, ASSIGN_LIMIT_MESSAGE, DELETE_FAILURE_MESSAGE, FEATURE_ATTACH_FAILURE_MESSAGE, QUEUE_ADD_FAILURE_MESSAGE, QUEUE_REMOVE_FAILURE_MESSAGE, REQUEUE_FAILURE_MESSAGE,
  RESOLVE_DONE_FAILURE_MESSAGE, UPDATE_FAILURE_MESSAGE, addDesktopQueueTask, deleteDesktopTask, removeDesktopQueueTask, requeueDesktopTask, setDesktopTaskAfter,
  UNASSIGN_FAILURE_MESSAGE, assignDesktopTaskSession, resolveDesktopTaskDone, takeCreateFollowUp, unassignDesktopTaskSession, updateDesktopTask,
} from "./task-desktop";
import { observedModelDiffers } from "./task-fields";
import { taskImagesAvailable } from "./task-images-desktop";
import { taskIssuesAvailable } from "./task-issues-desktop";
import { featureDraftFromTask, type FeatureDraft } from "./task-features";
import type { TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import {
  AWAITING_REPORT_NOTE, EDITS_DROPPED_NOTE, STARTED_NOTE, STARTED_REQUEUE_NOTE, taskAwaitsReport, taskChip, taskIssueNumber, taskSessionTitle, taskStarted,
} from "./task-presentation";
import { SAVE_FIRST_LINE, taskDraftPatch, useTaskDraft } from "./use-task-draft";
import { useFeatureCreation } from "./use-feature-creation";
import { shownTaskText, useStoredImages } from "./use-task-images";
import { SESSION_CANDIDATES_SHOWN, useTaskSessionCandidates } from "./use-task-session-candidates";
import { useTaskStart } from "./use-task-start";
import { waitDetail } from "./task-wait-model";

export function TaskModalEdit({ repositoryId, repositoryName, task, board, refresh, onOpenTask, onChanged, onDeleted, onClose, focus }: {
  repositoryId: string;
  repositoryName: string | null;
  task: Task;
  board: TaskModalBoard;
  refresh(): Promise<void>;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  onChanged(): void;
  onDeleted(): void;
  onClose(): void;
  /** The board's Runs after… opened the modal: its select takes focus. */
  focus?: "after";
}) {
  const models = useTaskModelOptions(board.runModels);
  const shown = useMemo(() => ({ ...task, text: shownTaskText(task.text, task.images) }), [task]);
  // The session works from the task as it was when it started, so a started task is read-only until it is requeued.
  const locked = taskStarted(task);
  const { draft, dirty, canSave, setText, setRun, setCompleteWhen, setFeature, reset: dropEdits } = useTaskDraft(shown);
  // A task can start while its modal holds unsaved edits. Its session works from the stored text, so the edits are dropped in the render
  // that sees the start: the modal is not dirty, Create issue… is offered, and the footer says what happened. A requeue clears the note.
  const [wasLocked, setWasLocked] = useState(locked);
  const [editsDropped, setEditsDropped] = useState(false);
  if (locked !== wasLocked) {
    setWasLocked(locked);
    setEditsDropped(locked && dirty);
    if (locked && dirty) dropEdits();
  }
  const droppedNote = locked && editsDropped;
  const [featureError, setFeatureError] = useState<string | null>(null);
  // A create that could not queue or start the task opens here with what happened.
  const [followUp] = useState(() => takeCreateFollowUp(repositoryId, task.id));
  const [failure, setFailure] = useState<string | null>(followUp && "failure" in followUp ? followUp.failure : null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [afterBusy, setAfterBusy] = useState(false);
  const [afterError, setAfterError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const saveInFlight = useRef(false);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  useEffect(() => { if (confirming) cancel.current?.focus({ preventScroll: true }); }, [confirming]);

  const chip = taskChip(task, task.id === board.queue?.order[0]);
  const unresolved = taskNeedsUser(task);
  const start = useTaskStart(repositoryId, task, board, dirty, refresh, onClose, followUp && "start" in followUp ? followUp.start : null);
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
  const sessionTitle = taskSessionTitle(task);
  const issueNumber = taskIssueNumber(task);
  const issueOffered = issueNumber === null && taskIssuesAvailable();
  const blocked = saving || deleting;
  // Why a task that waits in the queue has not started, as the monitor judged it.
  const queueWait = waitDetail(board.queue, task);
  // A done task takes no report, so it takes no new session. The sessions it holds can still be unassigned.
  const assigned = useMemo(() => task.assigned ?? [], [task.assigned]);
  const listed = useTaskSessionCandidates(repositoryId, task.state !== "done");
  const candidates = useMemo(() => listed?.filter((candidate) => candidate.id !== task.session?.id && !assigned.some((session) => session.id === candidate.id)).slice(0, SESSION_CANDIDATES_SHOWN),
    [listed, task.session, assigned]);
  // A task that runs after an unfinished task never starts, by hand or by the queue.
  const afterHold = showStart ? afterStartLine(unfinishedAfter(task, board.tasks)) : null;
  const startLine = showStart && start.line !== SAVE_FIRST_LINE ? start.line ?? afterHold : null;
  // Only a task that has not started can hold a draft.
  const saveLine = dirty && !confirming && startLine === null;
  const folderOffered = showStart && start.folder.offered;
  const folderLine = showStart ? start.folder.line : null;
  const separateOffered = showStart && start.separate.offered;
  // A started task never starts again, and a queued one whose session started has left the queue: those two actions are not offered for it.
  const startOffered = showStart && !locked;
  const queueOffered = waiting && !(locked && inProgress);
  const notes = !confirming && Boolean(startLine || saveLine || folderLine || awaitingReport || droppedNote);

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
      current = { ...draft, feature: { featureId: created.id, creating: false, name: "" } };
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
    if (!result.ok) { setFailure(done ? RESOLVE_DONE_FAILURE_MESSAGE : REQUEUE_FAILURE_MESSAGE); return; }
    onChanged();
    // A task marked done needs nothing more from its modal. A requeued task can be edited again, so its modal stays.
    if (done) onClose();
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

  const changeAfter = async (after: string[]) => {
    if (afterBusy) return;
    setAfterError(null);
    if (afterMakesLoop(board.tasks, task.id, after)) { setAfterError(AFTER_LOOP_MESSAGE); return; }
    setAfterBusy(true);
    const result = await setDesktopTaskAfter(repositoryId, task.id, after);
    setAfterBusy(false);
    if (result.ok) onChanged(); else setAfterError(result.error === "conflict" && afterMakesLoop(board.tasks, task.id, after) ? AFTER_LOOP_MESSAGE : AFTER_FAILURE_MESSAGE);
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

  const sessionLine = <TaskSessionLine title={sessionTitle} sessionId={task.session?.id ?? null} />;
  // The row can create an issue only from the saved text, so an unsaved draft holds it. The footer already says so when it can.
  const issueRow = <TaskIssueRow number={issueNumber} offered={issueOffered} repositoryId={repositoryId} repositoryName={repositoryName} taskId={task.id}
    unsaved={dirty} saveFirst={saveLine || confirming ? null : SAVE_FIRST_LINE} onChanged={onChanged} />;
  // Runs after, Sessions and Start at are rows of the same list as the settings above them.
  const afterRow = <TaskAfterField task={task} tasks={board.tasks} columnName={(columnId) => board.columns.find((column) => column.id === columnId)?.name ?? null}
    editable={!locked} busy={afterBusy || blocked} error={afterError} focusSelect={focus === "after"} onChange={(after) => void changeAfter(after)} />;
  const sessionsRow = <TaskSessionsField started={task.session} assigned={assigned} candidates={candidates} busy={assigning || blocked} error={assignError}
    onAssign={(sessionId) => void changeAssignment(sessionId, true)} onUnassign={(sessionId) => void changeAssignment(sessionId, false)} />;
  const modelNotice = observedModelDiffers(draft.run.model, task.session?.observedModel)
    ? <ModelDiffersNotice planned={draft.run.model} observed={task.session?.observedModel} />
    : undefined;
  const resolveName = task.state === "needs_review" && !(board.queue?.status === "blocked" && board.queue.blockedBy === task.id) ? "Mark done" : "Mark done and resume queue";

  return <TaskModalFrame title="Task" subtitle={repositoryName} closeOnScrim={!dirty} onClose={onClose}
    titleExtra={<>
      <span className="taskModalId">{task.id}</span>
      <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    </>}
    footer={<>
      {confirming
        ? <div className="taskModalConfirm" role="group" aria-label="Confirm delete">
          <span className="taskModalNote">Delete {task.id}? This cannot be undone.</span>
          <button type="button" className="commandSecondaryAction" disabled={deleting} onClick={() => void remove()}>Delete {task.id}</button>
          <button ref={cancel} type="button" className="commandQuietAction" disabled={deleting} onClick={() => setConfirming(false)}>Keep task</button>
        </div>
        : <button type="button" className="commandQuietAction" disabled={blocked} onClick={() => setConfirming(true)}>Delete task</button>}
      {notes
        ? <div className="taskModalNotes">
          {startLine && <span className="taskModalNote" role="status" aria-live="polite">{startLine}</span>}
          {saveLine && <span className="taskModalNote" role="status" aria-live="polite">{SAVE_FIRST_LINE}</span>}
          {folderLine && <span className="taskModalNote" role="status" aria-live="polite">{folderLine}</span>}
          {awaitingReport && <span className="taskModalNote">{AWAITING_REPORT_NOTE}</span>}
          {droppedNote && <span className="taskModalNote" role="status" aria-live="polite">{EDITS_DROPPED_NOTE}</span>}
        </div>
        : <span className="taskModalSpacer" aria-hidden="true" />}
      {!confirming && <>
        {folderOffered && <button type="button" className="commandSecondaryAction" disabled={start.folder.opening} onClick={() => void start.folder.open()}>Open folder</button>}
        {separateOffered && <button type="button" className="commandSecondaryAction" onClick={() => void start.separate.run()}>Start in separate worktree</button>}
        {queueOffered && <button type="button" className="commandSecondaryAction" disabled={queueing || dirty || inProgress} onClick={() => void changeQueue(task.state === "not_queued")}>
          {task.state === "not_queued" ? "Add to queue" : "Remove from queue"}
        </button>}
        {startOffered && <button type="button" className="commandSecondaryAction" disabled={start.disabled || afterHold !== null} onClick={() => void start.run()}>
          {start.pending ? "Starting…" : "Start session"}
        </button>}
        {(unresolved || awaitingReport) && <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(false)}>Requeue task</button>}
        {unresolved && <button type="button" className="commandPrimaryAction" disabled={resolving} onClick={() => void resolve(true)}>{resolveName}</button>}
        {awaitingReport && <button type="button" className="commandSecondaryAction" disabled={resolving} onClick={() => void resolve(true)}>Mark done</button>}
        {!locked && <button type="button" className="commandPrimaryAction" disabled={!canSave || saving} onClick={() => void save()}>Save</button>}
      </>}
    </>}>
    {queueWait && <TaskQueueWait detail={queueWait} />}
    {locked
      ? <>
        {taskHasReview(task) ? <TaskReviewPanel task={task} session={sessionLine} /> : sessionLine}
        <TaskReadView text={shown.text} urls={images.urls} note={unresolved || awaitingReport ? STARTED_REQUEUE_NOTE : STARTED_NOTE}
          error={<>
            {images.error && <p className="newTaskError" role="alert">{images.error}</p>}
            {failure && <p className="newTaskError" role="alert">{failure}</p>}
          </>} />
        <TaskRunSettingsRead task={task} board={board} models={models} conditionsListed={reviewListsConditions(task)} notice={modelNotice} issue={issueRow}
          extra={<>{afterRow}{sessionsRow}</>} onOpenTask={onOpenTask} />
      </>
      : <>
        <TaskTextField value={draft.text} onChange={setText} readOnly={saving} error={failure}
          images={imagesOffered ? { urls: images.urls, disabled: blocked, error: images.error, onAttach: images.attach } : undefined} />
        <RunSettings>
          <FeatureFields draft={draft.feature} board={board} selfId={task.id} error={featureError} onChange={changeFeature} onCancelName={cancelName} onOpenTask={onOpenTask} />
          <RunFields run={draft.run} models={models} notice={modelNotice} onChange={setRun} />
          <CompleteWhenField draft={draft.completeWhen} onDraftChange={setCompleteWhen} />
          {issueRow}
          {afterRow}
          {sessionsRow}
          {schedulable && <TaskStartTimeField repositoryId={repositoryId} task={task} onChanged={onChanged} />}
        </RunSettings>
      </>}
  </TaskModalFrame>;
}
