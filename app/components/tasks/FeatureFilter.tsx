"use client";

import type { TaskBoard } from "../../../shared/task-contract";
import { CommandSelect } from "../command-center/CommandSelect";
import { NewFeatureAction, type FeatureEntry } from "./FeatureActions";
import { ALL_FEATURES, WITHOUT_FEATURE, featureProgress, type FeatureFilterValue } from "./task-features";
import type { TaskBoardEdits } from "./use-task-board-edits";

export function FeatureFilter({ board, filter, onFilter, edits, entry }: {
  board: Pick<TaskBoard, "features" | "tasks">;
  filter: FeatureFilterValue;
  onFilter(next: FeatureFilterValue): void;
  edits?: TaskBoardEdits;
  /** Desktop app only: Edit feature and + New feature open the Feature modal. */
  entry?: FeatureEntry;
}) {
  const count = (match: (featureId: string | null) => boolean) => board.tasks.filter((task) => match(task.featureId)).length;
  const feature = (entry: TaskBoard["features"][number]) => ({ value: entry.id, label: entry.name, total: count((id) => id === entry.id), done: entry.done });
  // Done features sit last, below No feature, in muted text.
  const options = [
    { value: ALL_FEATURES, label: "All", total: board.tasks.length },
    ...board.features.filter((entry) => !entry.done).map(feature),
    { value: WITHOUT_FEATURE, label: "No feature", total: count((id) => id === null) },
    ...board.features.filter((entry) => entry.done).map(feature),
  ].map((option) => ({
    value: option.value,
    label: `${option.label} (${option.total})`,
    ...("done" in option && option.done ? { muted: true, iconLabel: "done" } : {}),
  }));
  const progress = featureProgress(board, filter);
  const num = (value: number) => <span className="taskFeatureProgressNum">{value}</span>;
  return <div className="taskFeatureFilter" role="group" aria-label="Filter by feature">
    <span className="taskFilterEyebrow">Feature</span>
    <CommandSelect className="taskFeatureSelect" aria-label="Feature" options={options} value={filter} onChange={onFilter} />
    {entry && filter !== ALL_FEATURES && filter !== WITHOUT_FEATURE
      && <button type="button" className="commandQuietAction" aria-haspopup="dialog" onClick={(event) => entry.onEdit(filter, event.currentTarget)}>Edit feature</button>}
    {entry && <NewFeatureAction board={board} entry={entry} />}
    {progress && <span className="taskFeatureProgress">
      {num(progress.done)} of {num(progress.total)} {progress.total === 1 ? "task" : "tasks"} done
      {progress.running > 0 && <> · {num(progress.running)} running</>}
    </span>}
    {edits && filter !== ALL_FEATURES && <span className="newTaskHelper">Moving cards is off while a feature filter is on.</span>}
  </div>;
}
