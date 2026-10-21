"use client";

import { useId, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { TaskRow } from "./TaskRows";
import { TASK_SCHEDULE_FAILURE_MESSAGE, TASK_SCHEDULE_INVALID_MESSAGE, scheduleDesktopTask } from "./task-desktop";
import { instantOfLocalDateTime, localDateTime } from "./task-schedule";

export const START_AT_HINT = "Starts at this time or later; setting it queues the task.";

/** The Start at row: a compact date-and-time field with its hint under it. It sends nothing itself: `onCommit` is called when the field loses focus. */
export function StartAtRowView({ value, disabled, failure, onChange, onCommit }: {
  value: string;
  disabled?: boolean;
  failure: string | null;
  onChange(value: string): void;
  onCommit(): void;
}) {
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  return <TaskRow label="Start at" htmlFor={fieldId} top="control" className="taskStartTimeField">
    <div className="taskRowInline">
      <input id={fieldId} type="datetime-local" className="taskTimeInput" value={value} disabled={disabled} aria-describedby={failure ? `${hintId} ${errorId}` : hintId}
        onChange={(event) => onChange(event.currentTarget.value)} onBlur={onCommit} />
      <span id={hintId} className="newTaskHelper">{START_AT_HINT}</span>
      {failure && <p id={errorId} className="newTaskError" role="alert">{failure}</p>}
    </div>
  </TaskRow>;
}

/** A task's own start time, as a row of the Run settings list. It saves by itself. */
export function TaskStartTimeField({ repositoryId, task, onChanged }: { repositoryId: string; task: Task; onChanged(): void }) {
  const stored = task.state === "scheduled" ? localDateTime(task.scheduledAt) : "";
  const [value, setValue] = useState(stored);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) {
    setSeen(stored);
    setValue(stored);
  }
  const commit = async () => {
    if (saving || value === stored) return;
    const at = value === "" ? null : instantOfLocalDateTime(value);
    if (value !== "" && at === null) { setValue(stored); return; }
    setSaving(true);
    setFailure(null);
    const result = await scheduleDesktopTask(repositoryId, task.id, at);
    setSaving(false);
    if (result.ok) { onChanged(); return; }
    setValue(stored);
    setFailure(result.error === "invalid" ? TASK_SCHEDULE_INVALID_MESSAGE : TASK_SCHEDULE_FAILURE_MESSAGE);
  };
  return <StartAtRowView value={value} disabled={saving} failure={failure} onChange={setValue} onCommit={() => void commit()} />;
}
