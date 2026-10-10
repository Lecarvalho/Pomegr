"use client";

import { TASK_BOUNDS, type TaskBoard } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import { AddFeatureAction } from "./AddFeatureAction";
import { ALL_FEATURES, WITHOUT_FEATURE, type FeatureFilterValue } from "./task-features";
import type { TaskBoardEdits } from "./use-task-board-edits";

/**
 * Feature filter row (design contract D40-D44, as one list since the product owner's decision of 2026-10-10, so the
 * row stays one control however many features a board holds): a select whose options carry a task count, All first
 * and No feature last, then the desktop-only + New feature. The filter is client state; the board decides what it hides.
 */
export function FeatureFilter({ board, filter, onFilter, edits }: {
  board: Pick<TaskBoard, "features" | "tasks">;
  filter: FeatureFilterValue;
  onFilter(next: FeatureFilterValue): void;
  edits?: TaskBoardEdits;
}) {
  const count = (match: (featureId: string | null) => boolean) => board.tasks.filter((task) => match(task.featureId)).length;
  const options = [
    { value: ALL_FEATURES, label: "All", total: board.tasks.length },
    ...board.features.map((feature) => ({ value: feature.id, label: feature.name, total: count((id) => id === feature.id) })),
    { value: WITHOUT_FEATURE, label: "No feature", total: count((id) => id === null) },
  ].map((option) => ({ value: option.value, label: `${option.label} (${option.total})` }));
  return <div className="taskFeatureFilter" role="group" aria-label="Filter by feature">
    <span className="taskFilterEyebrow">Feature</span>
    <CommandSelect className="taskFeatureSelect" aria-label="Feature" options={options} value={filter} onChange={onFilter} />
    {edits && <AddFeatureAction edits={edits} full={board.features.length >= TASK_BOUNDS.featuresPerRepository} />}
    {edits && filter !== ALL_FEATURES && <span className="newTaskHelper">Moving cards is off while a feature filter is on.</span>}
  </div>;
}
