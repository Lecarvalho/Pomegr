"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, TaskCheck } from "../../../shared/task-contract";
import { sessionListTime } from "../../dashboard-utils";
import { FeatureFields } from "./FeatureFields";
import { IssueCreateRow } from "./IssueCreate";
import { TaskModalFrame } from "./TaskModalFrame";
import { TaskModalSource } from "./TaskModalPromote";
import { DoneWhenField, RunFields, TaskTextField } from "./TaskFields";
import { TaskSessionLink } from "./TaskSessionLink";
import { TaskStartTimeField } from "./TaskStartTimeField";
import {
  DELETE_FAILURE_MESSAGE, FEATURE_ATTACH_FAILURE_MESSAGE, QUEUE_ADD_FAILURE_MESSAGE, QUEUE_REMOVE_FAILURE_MESSAGE, REQUEUE_FAILURE_MESSAGE,
  RESOLVE_DONE_FAILURE_MESSAGE, UPDATE_FAILURE_MESSAGE, addDesktopQueueTask, deleteDesktopTask, removeDesktopQueueTask, requeueDesktopTask,
  resolveDesktopTaskDone, updateDesktopTask,
} from "./task-desktop";
import { observedModelDiffers } from "./task-fields";
import { taskIssuesAvailable } from "./task-issues-desktop";
import { featureDraftFromTask, type FeatureDraft } from "./task-features";
import { modalSubtitle, type TaskModalBoard } from "./task-modal-types";
import { useTaskModelOptions } from "./task-panel-hooks";
import { AWAITING_REPORT_NOTE, taskAwaitsReport, taskChip, taskIssueNumber, taskSessionHref, taskSessionTitle } from "./task-presentation";
import { SAVE_FIRST_LINE, taskDraftPatch, useTaskDraft } from "./use-task-draft";
import { useFeatureCreation } from "./use-feature-creation";
import { useTaskStart } from "./use-task-start";

// Task modal, mode edit (design contract G241-G298), opened from a card. A task promoted from a GitHub issue starts the
// body with its Source block (G253-G257); its text stays editable like any task's. Text, Run on, Effort, Done when,
// Feature and Step are a local draft that Save sends as one patch holding only what changed; Close and Escape discard it. Start at
// keeps saving by itself. A task that needs review, is blocked or stalled leads the footer with Mark done and resume
// queue and Requeue task. A task whose linked session has not reported offers Mark done and Requeue task too, with a
// line that neither stops the session; nothing marks such a task done or stalled by itself. While the draft is unsaved
// Start session, Add to queue, Remove from queue, Mark done and Requeue task are disabled.

const STALLED_NOTE = "The session ended with no report.";

function reportLine(report: NonNullable<Task["report"]>) {
  // The time sits in parentheses: a locale whose time ends in a period ("p.m.") must not double the sentence's own.
  const time = Number.isFinite(Date.parse(report.at)) ? <> (<time dateTime={report.at}>{sessionListTime(report.at)}</time>)</> : null;
  return report.blockReason === null
    ? <>Agent reported complete{time}.</>
    : <>Agent reported it cannot continue{time}: {report.blockReason}</>;
}

/** Every change goes through the desktop bridge; success refreshes the board, failure keeps the draft and says so once. */
export function TaskModalEdit({ repositoryId, repositoryName, task, board, refresh, onOpenTask, onChanged, onDeleted, onClose }: {
  repositoryId: string;
  repositoryName: string | null;
  task: Task;
  /** The committed board: its features and their tasks fill the Feature fields and the folded list. */
  board: TaskModalBoard;
  refresh(): Promise<void>;
  /** Opens a sibling's own modal from the folded list. */
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  onChanged(): void;
  onDeleted(): void;
  onClose(): void;
}) {
  const models = useTaskModelOptions(board.runModels);
  const { draft, dirty, canSave, setText, setRun, setDoneWhen, setFeature } = useTaskDraft(task);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const saveInFlight = useRef(false);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  useEffect(() => { if (confirming) cancel.current?.focus({ preventScroll: true }); }, [confirming]);

  const chip = taskChip(task, task.id === board.queue?.order[0]);
  const unresolved = task.state === "needs_review" || task.state === "blocked" || task.state === "stalled";
  const results = useMemo(() => new Map<TaskCheck, boolean>((task.report?.results ?? []).map((entry) => [entry.check, entry.passed])), [task.report]);
  // A stalled task has no report: its session ended before the agent reported complete or blocked.
  const outcomeNote = task.report ? reportLine(task.report) : task.state === "stalled" ? STALLED_NOTE : null;
  const start = useTaskStart(repositoryId, task, dirty, refresh);
  // A task that needs the user offers its resolutions instead of Start session.
  const showStart = start.available && !unresolved;
  const waiting = task.state === "not_queued" || task.state === "queued" || task.state === "scheduled";
  const schedulable = waiting && task.session === null;
  // A linked task with no report never resolves by itself, so the user can mark it done or requeue it.
  const awaitingReport = taskAwaitsReport(task);
  const sessionTitle = taskSessionTitle(task);
  const issueNumber = taskIssueNumber(task);
  // Only a task with no GitHub issue offers one, and only on the desktop. No GitHub status is read when a task opens.
  const issueOffered = issueNumber === null && taskIssuesAvailable();
  const hasSessionLink = task.session !== null && taskSessionHref(task.session.id) !== null;
  const columnName = board.columns.find((column) => column.id === task.columnId)?.name ?? null;
  const blocked = saving || deleting;
  // The start gate words "Save your changes first." itself; any other offered action gets the same line.
  const startLine = showStart && start.line !== SAVE_FIRST_LINE ? start.line : null;
  const saveLine = dirty && !confirming && startLine === null && (showStart || waiting || unresolved || awaitingReport || issueOffered);
  const folderOffered = showStart && start.folder.offered;
  const folderLine = showStart ? start.folder.line : null;
  const resolveRow = !confirming && (startLine || saveLine || folderLine || folderOffered || unresolved || awaitingReport);

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
      // The feature exists now: a retry after a failed save must attach to it, not create it again.
      current = { ...draft, feature: { featureId: created.id, creating: false, name: "", step: null } };
      setFeature(current.feature);
    }
    const patch = taskDraftPatch(task, current);
    const result = patch ? await updateDesktopTask(repositoryId, task.id, patch) : { ok: true as const };
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

  // Add to queue / Remove from queue: only a task in the matching state is offered, and the monitor decides the rest.
  const changeQueue = async (add: boolean) => {
    if (queueing) return;
    setQueueing(true);
    setFailure(null);
    const result = await (add ? addDesktopQueueTask(repositoryId, task.id) : removeDesktopQueueTask(repositoryId, task.id));
    setQueueing(false);
    if (result.ok) onChanged(); else setFailure(add ? QUEUE_ADD_FAILURE_MESSAGE : QUEUE_REMOVE_FAILURE_MESSAGE);
  };

  // Mark done / Requeue: offered only for a task that needs the user or whose session has not reported, and the monitor decides the rest.
  const resolve = async (done: boolean) => {
    if (resolving) return;
    setResolving(true);
    setFailure(null);
    const result = await (done ? resolveDesktopTaskDone(repositoryId, task.id) : requeueDesktopTask(repositoryId, task.id));
    setResolving(false);
    if (result.ok) onChanged(); else setFailure(done ? RESOLVE_DONE_FAILURE_MESSAGE : REQUEUE_FAILURE_MESSAGE);
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

  const resolveDisabled = resolving || dirty;
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
        {unresolved && <>
          <button type="button" className="commandSecondaryAction" disabled={resolveDisabled} onClick={() => void resolve(true)}>Mark done and resume queue</button>
          <button type="button" className="commandSecondaryAction" disabled={resolveDisabled} onClick={() => void resolve(false)}>Requeue task</button>
        </>}
        {awaitingReport && <>
          <span className="taskModalNote">{AWAITING_REPORT_NOTE}</span>
          <button type="button" className="commandSecondaryAction" disabled={resolveDisabled} onClick={() => void resolve(true)}>Mark done</button>
          <button type="button" className="commandSecondaryAction" disabled={resolveDisabled} onClick={() => void resolve(false)}>Requeue task</button>
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
        {waiting && <button type="button" className="commandSecondaryAction" disabled={queueing || dirty} onClick={() => void changeQueue(task.state === "not_queued")}>
          {task.state === "not_queued" ? "Add to queue" : "Remove from queue"}
        </button>}
        {showStart && <button type="button" className="commandSecondaryAction" disabled={start.disabled} onClick={() => void start.run()}>
          {start.pending ? "Starting…" : "Start session"}
        </button>}
        <button type="button" className="commandPrimaryAction" disabled={!canSave || saving} onClick={() => void save()}>Save</button>
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
    <TaskTextField value={draft.text} onChange={setText} readOnly={saving} error={failure} />
    <FeatureFields draft={draft.feature} board={board} selfId={task.id} error={featureError} onChange={changeFeature}
      onCancelName={cancelName} onOpenTask={onOpenTask} />
    <div className="taskRunGroup">
      <RunFields run={draft.run} models={models} onChange={setRun} />
      {observedModelDiffers(draft.run.model, task.session?.observedModel) && <div className="taskModelNotice" role="status">
        <span className="taskModelNoticeTitle">Observed model differs</span>{" "}
        <span>Planned <code>{draft.run.model}</code>, latest recorded request used <code>{task.session?.observedModel}</code>.</span>
      </div>}
    </div>
    <DoneWhenField draft={draft.doneWhen} results={task.report ? results : undefined}
      ownNote={task.report && draft.doneWhen.ownText.trim() !== "" && task.doneWhen.own !== null ? "Agent-reported" : null}
      footnote={outcomeNote ? <span className="newTaskHelper taskDoneWhenNote">{outcomeNote}</span> : undefined}
      onDraftChange={setDoneWhen} />
    {schedulable && <TaskStartTimeField repositoryId={repositoryId} task={task} onChanged={onChanged} />}
  </TaskModalFrame>;
}
