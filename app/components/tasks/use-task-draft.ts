"use client";

import { useState } from "react";
import { TASK_BOUNDS, type Task, type TaskRun } from "../../../shared/task-contract";
import type { TaskFieldsInput } from "./task-desktop";
import { completeWhenFromTask, toCompleteWhen, type CompleteWhenDraft } from "./task-fields";
import { featureDraftFromTask, featureUpdateInput, type FeatureDraft } from "./task-features";

export const SAVE_FIRST_LINE = "Save your changes first.";

export type TaskPatch = { text?: string } & TaskFieldsInput;

export type TaskDraft = { text: string; run: TaskRun; completeWhen: CompleteWhenDraft; feature: FeatureDraft };

export function taskDraftFromTask(task: Task): TaskDraft {
  return { text: task.text, run: task.run, completeWhen: completeWhenFromTask(task.completeWhen), feature: featureDraftFromTask(task) };
}

const sameRun = (left: TaskRun, right: TaskRun) => left.provider === right.provider && left.model === right.model && left.effort === right.effort
  && (left.remoteControl === true) === (right.remoteControl === true);

export function taskDraftPatch(task: Task, draft: TaskDraft, createdFeatureId: string | null = null): TaskPatch | null {
  const patch: TaskPatch = {};
  const text = draft.text.trim();
  if (text !== task.text) patch.text = text;
  if (!sameRun(draft.run, task.run)) patch.run = draft.run;
  const completeWhen = toCompleteWhen(draft.completeWhen);
  if (JSON.stringify(completeWhen) !== JSON.stringify(toCompleteWhen(completeWhenFromTask(task.completeWhen)))) patch.completeWhen = completeWhen;
  const feature = featureUpdateInput(draft.feature, createdFeatureId);
  if (draft.feature.creating || JSON.stringify(feature) !== JSON.stringify(featureUpdateInput(featureDraftFromTask(task)))) Object.assign(patch, feature);
  return Object.keys(patch).length === 0 ? null : patch;
}

export function taskDraftCanSave(task: Task, draft: TaskDraft): boolean {
  if (draft.text.trim() === "" || draft.text.trim().length > TASK_BOUNDS.textLength) return false;
  if (draft.feature.creating && draft.feature.name.trim() === "") return false;
  return taskDraftPatch(task, draft) !== null;
}

export function useTaskDraft(task: Task) {
  const [draft, setDraft] = useState<TaskDraft>(() => taskDraftFromTask(task));
  return {
    draft,
    dirty: taskDraftPatch(task, draft) !== null,
    canSave: taskDraftCanSave(task, draft),
    setText: (text: string) => setDraft((current) => ({ ...current, text })),
    setRun: (run: TaskRun) => setDraft((current) => ({ ...current, run })),
    setCompleteWhen: (completeWhen: CompleteWhenDraft) => setDraft((current) => ({ ...current, completeWhen })),
    setFeature: (feature: FeatureDraft) => setDraft((current) => ({ ...current, feature })),
  };
}
