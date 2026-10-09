"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { TASK_BOUNDS, type Task, type TaskBoard, type TaskCheck, type TaskRun } from "../../../shared/task-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { sessionListTime } from "../../dashboard-utils";
import { CommandIcon } from "../command-center/CommandIcon";
import { FeatureFields } from "./FeatureFields";
import { DoneWhenField, RunFields } from "./TaskFields";
import {
  DELETE_FAILURE_MESSAGE, FEATURE_ATTACH_FAILURE_MESSAGE, QUEUE_ADD_FAILURE_MESSAGE, QUEUE_REMOVE_FAILURE_MESSAGE, UPDATE_FAILURE_MESSAGE, addDesktopQueueTask,
  deleteDesktopTask, removeDesktopQueueTask, updateDesktopTask, type TaskFieldsInput,
} from "./task-desktop";
import { doneWhenFromTask, observedModelDiffers, toDoneWhen, type DoneWhenDraft } from "./task-fields";
import { featureDraftFromTask, featureUpdateInput, type FeatureDraft } from "./task-features";
import { useEscapeToClose, useTaskModelOptions } from "./task-panel-hooks";
import { taskCardTitle, taskChip } from "./task-presentation";
import { useFeatureCreation } from "./use-feature-creation";
import { useTaskStart } from "./use-task-start";

// Task side panel (design contract D239-D294, D295, D298, D299), opened from a card. It reuses the New task
// panel's drawer chrome. A select, segment or checkbox saves when it changes; the Task textarea, the
// own-condition input and a new feature's name save when they lose focus after a change. Mark done / Requeue
// (D296, D297) belong to a later part and are not drawn. The footer offers Add to queue (Not queued) or Remove
// from queue (Queued) before Delete task: the design has no such control, so this is the orchestrator's decision.

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
export function TaskPanel({ repositoryId, task, board, refresh, onOpenTask, onChanged, onDeleted, onClose }: {
  repositoryId: string;
  task: Task;
  /** The committed board: its features and their tasks fill the Feature fields and the folded list. */
  board: Pick<TaskBoard, "columns" | "features" | "tasks"> & { runModels?: NonNullable<TaskBoard["runModels"]>; queue?: Pick<TaskBoard["queue"], "order"> };
  refresh(): Promise<void>;
  /** Opens a sibling's own panel from the folded list. */
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
  onChanged(): void;
  onDeleted(): void;
  onClose(): void;
}) {
  const titleId = useId();
  const fieldId = useId();
  const errorId = useId();
  const models = useTaskModelOptions(board.runModels);
  const [text, setText] = useState(task.text);
  const [run, setRun] = useState<TaskRun>(task.run);
  const [doneWhen, setDoneWhen] = useState<DoneWhenDraft>(() => doneWhenFromTask(task.doneWhen));
  const [feature, setFeature] = useState<FeatureDraft>(() => featureDraftFromTask(task));
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  // What the monitor was last asked to store, so a quick toggle back is still sent and an unchanged blur is not.
  const sent = useRef({ text: task.text, run: JSON.stringify(task.run), doneWhen: JSON.stringify(toDoneWhen(doneWhenFromTask(task.doneWhen))) });
  const sentFeature = useRef(JSON.stringify(featureUpdateInput(featureDraftFromTask(task))));
  const creatingName = useRef(false);
  const nameCancelled = useRef(false);
  const createFeature = useFeatureCreation(repositoryId, board, refresh);
  const stored = useRef(task);
  useEffect(() => { stored.current = task; }, [task]);
  // The committed feature and step win once the board shows them: "Last" becomes the step it landed on.
  const committedFeature = `${task.featureId}:${task.step}`;
  const [seenFeature, setSeenFeature] = useState(committedFeature);
  if (seenFeature !== committedFeature) {
    setSeenFeature(committedFeature);
    setFeature((current) => current.creating ? current : featureDraftFromTask(task));
  }
  useEffect(() => {
    sentFeature.current = JSON.stringify(featureUpdateInput(featureDraftFromTask({ featureId: task.featureId, step: task.step })));
  }, [task.featureId, task.step]);
  useEffect(() => { closeButton.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => { if (confirming) cancel.current?.focus({ preventScroll: true }); }, [confirming]);
  useEscapeToClose(onClose);

  const chip = taskChip(task, task.id === board.queue?.order[0]);
  const results = useMemo(() => new Map<TaskCheck, boolean>((task.report?.results ?? []).map((entry) => [entry.check, entry.passed])), [task.report]);
  const start = useTaskStart(repositoryId, task, text.trim() !== task.text, refresh);
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
    if (patch.featureId !== undefined) {
      const draft = featureDraftFromTask(original);
      setFeature(draft);
      sentFeature.current = JSON.stringify(featureUpdateInput(draft));
    }
    setFailure(patch.featureId && result.error === "conflict" ? FEATURE_ATTACH_FAILURE_MESSAGE : UPDATE_FAILURE_MESSAGE);
  };

  // Feature and Step save when they change, except a feature still being named: it saves once it is created.
  const saveFeature = (next: FeatureDraft) => {
    const input = featureUpdateInput(next);
    const serialized = JSON.stringify(input);
    if (serialized === sentFeature.current) return;
    sentFeature.current = serialized;
    void save(input);
  };
  const changeFeature = (next: FeatureDraft) => {
    setFeature(next);
    setFeatureError(null);
    if (next.creating) { nameCancelled.current = false; return; }
    saveFeature(next);
  };
  const cancelName = () => {
    nameCancelled.current = true;
    setFeatureError(null);
    setFeature(featureDraftFromTask(stored.current));
  };
  const commitName = async () => {
    if (!feature.creating || creatingName.current || nameCancelled.current) return;
    const name = feature.name.trim();
    if (!name) { cancelName(); return; }
    creatingName.current = true;
    const created = await createFeature(name);
    creatingName.current = false;
    if (!created.ok) { setFeatureError(created.message); return; }
    const next: FeatureDraft = { featureId: created.id, creating: false, name: "", step: null };
    setFeature(next);
    saveFeature(next);
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

  // Add to queue / Remove from queue: only a task in the matching state is offered, and the monitor decides the rest.
  const changeQueue = async (add: boolean) => {
    if (queueing) return;
    setQueueing(true);
    setFailure(null);
    const result = await (add ? addDesktopQueueTask(repositoryId, task.id) : removeDesktopQueueTask(repositoryId, task.id));
    setQueueing(false);
    if (result.ok) onChanged(); else setFailure(add ? QUEUE_ADD_FAILURE_MESSAGE : QUEUE_REMOVE_FAILURE_MESSAGE);
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
      <FeatureFields draft={feature} board={board} selfId={task.id} error={featureError} onChange={changeFeature}
        onCommitName={() => void commitName()} onCancelName={cancelName} onOpenTask={onOpenTask} />
    </div>
    <footer className="newTaskPanelFooter taskPanelFooter">
      {start.available && <span className="newTaskPanelNote" role="status" aria-live="polite">{start.line}</span>}
      <span className="newTaskPanelSpacer" aria-hidden="true" />
      {confirming
        ? <div className="taskPanelConfirm" role="group" aria-label="Confirm delete">
          <span className="newTaskPanelNote">Delete {task.id}? This cannot be undone.</span>
          <button type="button" className="commandSecondaryAction" disabled={deleting} onClick={() => void remove()}>Delete {task.id}</button>
          <button ref={cancel} type="button" className="commandQuietAction" disabled={deleting} onClick={() => setConfirming(false)}>Keep task</button>
        </div>
        : <>
          {start.available && <button type="button" className="commandPrimaryAction" disabled={start.disabled} onClick={() => void start.run()}>
            {start.pending ? "Starting…" : "Start session"}
          </button>}
          {(task.state === "not_queued" || task.state === "queued") && <button type="button" className="commandSecondaryAction" disabled={queueing} onClick={() => void changeQueue(task.state === "not_queued")}>
            {task.state === "not_queued" ? "Add to queue" : "Remove from queue"}
          </button>}
          <button type="button" className="commandQuietAction" onClick={() => setConfirming(true)}>Delete task</button>
        </>}
    </footer>
  </section>;
}
