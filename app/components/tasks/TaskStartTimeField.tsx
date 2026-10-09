"use client";

import { useId, useState } from "react";
import type { Task } from "../../../shared/task-contract";
import { TASK_SCHEDULE_FAILURE_MESSAGE, TASK_SCHEDULE_INVALID_MESSAGE, scheduleDesktopTask } from "./task-desktop";
import { instantOfLocalDateTime, localDateTime } from "./task-schedule";

const HELPER = "The queue starts this task at this time or later, never before. Setting a time adds the task to the queue; clearing it leaves the task queued.";

/**
 * The task's own start time in the Task panel. It saves when the field loses focus after a change: a time makes the
 * task Scheduled, and clearing it leaves the task Queued. Only a task that still waits for a session has the field.
 */
export function TaskStartTimeField({ repositoryId, task, onChanged }: { repositoryId: string; task: Task; onChanged(): void }) {
  const fieldId = useId();
  const errorId = useId();
  const stored = task.state === "scheduled" ? localDateTime(task.scheduledAt) : "";
  const [value, setValue] = useState(stored);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The committed time wins once the board shows it.
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
  return <div className="newTaskField taskStartTimeField">
    <label htmlFor={fieldId}>Start at</label>
    <input id={fieldId} type="datetime-local" className="taskTimeInput" value={value} disabled={saving} aria-describedby={failure ? errorId : undefined}
      onChange={(event) => setValue(event.currentTarget.value)} onBlur={() => void commit()} />
    <span className="newTaskHelper">{HELPER}</span>
    {failure && <p id={errorId} className="newTaskError" role="alert">{failure}</p>}
  </div>;
}
