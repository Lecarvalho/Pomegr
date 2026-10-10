"use client";

import { useState } from "react";
import type { Task, TaskRun } from "../../../shared/task-contract";
import type { TaskFieldsInput } from "./task-desktop";
import { doneWhenFromTask, toDoneWhen, type DoneWhenDraft } from "./task-fields";
import { featureDraftFromTask, featureUpdateInput, type FeatureDraft } from "./task-features";

// The local draft of the Task modal in mode edit. Nothing here is sent: Save asks `taskDraftPatch` for the one patch
// holding only what differs from the stored task.

export const SAVE_FIRST_LINE = "Save your changes first.";

export type TaskPatch = { text?: string } & TaskFieldsInput;

export type TaskDraft = { text: string; run: TaskRun; doneWhen: DoneWhenDraft; feature: FeatureDraft };

export function taskDraftFromTask(task: Task): TaskDraft {
  return { text: task.text, run: task.run, doneWhen: doneWhenFromTask(task.doneWhen), feature: featureDraftFromTask(task) };
}

const sameRun = (left: TaskRun, right: TaskRun) => left.provider === right.provider && left.model === right.model && left.effort === right.effort;

/**
 * The fields of `draft` that differ from the stored task, or null when nothing does. The text is compared and sent
 * trimmed. A feature still being named always counts as a change; `createdFeatureId` is the feature once it exists.
 */
export function taskDraftPatch(task: Task, draft: TaskDraft, createdFeatureId: string | null = null): TaskPatch | null {
  const patch: TaskPatch = {};
  const text = draft.text.trim();
  if (text !== task.text) patch.text = text;
  if (!sameRun(draft.run, task.run)) patch.run = draft.run;
  const doneWhen = toDoneWhen(draft.doneWhen);
  if (JSON.stringify(doneWhen) !== JSON.stringify(toDoneWhen(doneWhenFromTask(task.doneWhen)))) patch.doneWhen = doneWhen;
  const feature = featureUpdateInput(draft.feature, createdFeatureId);
  if (draft.feature.creating || JSON.stringify(feature) !== JSON.stringify(featureUpdateInput(featureDraftFromTask(task)))) Object.assign(patch, feature);
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Save is offered once something differs, the text is not empty and a new feature has a name. */
export function taskDraftCanSave(task: Task, draft: TaskDraft): boolean {
  if (draft.text.trim() === "") return false;
  if (draft.feature.creating && draft.feature.name.trim() === "") return false;
  return taskDraftPatch(task, draft) !== null;
}

/** The draft, its setters and whether it differs from the stored task. */
export function useTaskDraft(task: Task) {
  const [draft, setDraft] = useState<TaskDraft>(() => taskDraftFromTask(task));
  return {
    draft,
    dirty: taskDraftPatch(task, draft) !== null,
    canSave: taskDraftCanSave(task, draft),
    setText: (text: string) => setDraft((current) => ({ ...current, text })),
    setRun: (run: TaskRun) => setDraft((current) => ({ ...current, run })),
    setDoneWhen: (doneWhen: DoneWhenDraft) => setDraft((current) => ({ ...current, doneWhen })),
    setFeature: (feature: FeatureDraft) => setDraft((current) => ({ ...current, feature })),
  };
}
