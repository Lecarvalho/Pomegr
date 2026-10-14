"use client";

import { useEffect, useId, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import { AFTER_HELPER, AFTER_LIMIT, afterCandidates } from "./task-after-model";
import { taskChip, taskSessionTitle, taskTextPreview } from "./task-presentation";

/** A task named in one line: its session title, or the first sentence of its text. */
const rowTitle = (task: AfterTask) => taskSessionTitle(task as Task) ?? taskTextPreview(task.text).lead;

type AfterTask = Pick<Task, "id" | "text" | "state" | "session" | "after" | "columnId">;

function AfterRow({ task, columnName, disabled, onRemove }: {
  task: AfterTask;
  columnName: string | null;
  disabled?: boolean;
  onRemove?(): void;
}) {
  const title = rowTitle(task);
  const chip = taskChip(task as Task, false);
  return <li className="taskSessionsItem">
    <span className="taskSessionsName">
      <span className="taskSessionsTitle" title={title}>{title}</span>
      <span className="taskSessionsRole"><span className="taskAfterId">{task.id}</span>{columnName ? ` · ${columnName}` : ""}</span>
    </span>
    <span className={`commandChip taskCardChip ${chip.tone}${chip.ink ? " isInk" : ""}`}>{chip.label}</span>
    {onRemove && <button type="button" className="commandQuietAction" disabled={disabled} aria-label={`Remove ${task.id}`} onClick={onRemove}>Remove</button>}
  </li>;
}

/** What one task runs after: a ruled row for each task, then the owner's select. It saves by itself. */
export function TaskAfterField({ task, tasks, columnName, editable, busy, error, focusSelect = false, onChange }: {
  task: AfterTask;
  tasks: readonly AfterTask[];
  columnName(columnId: string): string | null;
  /** False for a task that has started, and for a client that cannot change the board. */
  editable: boolean;
  busy?: boolean;
  error?: string | null;
  /** The board's Runs after… opened the modal: the select takes focus. */
  focusSelect?: boolean;
  onChange?(after: string[]): void;
}) {
  const selectId = useId();
  const helperId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    if (focusSelect) document.getElementById(selectId)?.focus({ preventScroll: false });
  }, [focusSelect, selectId]);
  const listed = (task.after ?? []).map((id) => tasks.find((other) => other.id === id)).filter((other): other is AfterTask => other !== undefined);
  if (!editable && listed.length === 0) return null;
  const options = afterCandidates(tasks, task).map((other) => ({ value: other.id, label: `${other.id} · ${rowTitle(other)}` }));
  const value = options.some((option) => option.value === chosen) ? chosen : null;
  const full = listed.length >= AFTER_LIMIT;
  const current = listed.map((other) => other.id);
  return <fieldset className="taskSessions taskAfter">
    <legend>Runs after</legend>
    {listed.length > 0 && <ul className="taskSessionsList">
      {listed.map((other) => <AfterRow key={other.id} task={other} columnName={columnName(other.columnId)} disabled={busy}
        onRemove={editable && onChange ? () => onChange(current.filter((id) => id !== other.id)) : undefined} />)}
    </ul>}
    {editable && onChange && <>
      <div className="taskSessionsAssign">
        <CommandSelect id={selectId} aria-label="Task this one runs after" options={options} value={value}
          placeholder={full ? `It runs after ${AFTER_LIMIT} tasks, the most it can` : options.length > 0 ? "Choose a task" : "No other open task on this board"}
          disabled={busy || full || options.length === 0} onChange={setChosen} />
        <button type="button" className="commandSecondaryAction" disabled={busy || value === null || full} aria-describedby={helperId}
          onClick={() => { if (value !== null) { onChange([...current, value]); setChosen(null); } }}>Add</button>
      </div>
      <p id={helperId} className="newTaskHelper">{AFTER_HELPER}</p>
    </>}
    {error && <p className="newTaskError" role="alert">{error}</p>}
  </fieldset>;
}
