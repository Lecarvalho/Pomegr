import type { ReactNode } from "react";
import { TASK_CHECKS, type Task, type TaskBoard } from "../../../shared/task-contract";
import { FeatureSiblings } from "./FeatureFields";
import { RunSettings, TaskRow, TaskRowNone } from "./TaskRows";
import {
  CHECK_SHORT_LABELS, EFFORT_LABELS, KEEP_WORKTREE_LABEL, REMOTE_CONTROL_LABEL, REMOVE_WORKTREE_LABEL, canRemoteControl, runSelectOptions, runSelectValue,
  type TaskModelOptions,
} from "./task-fields";

type BoardShape = Pick<TaskBoard, "columns" | "features" | "tasks"> & { queue?: Pick<TaskBoard["queue"], "order"> };

/** The conditions a task completes on, as one comma list: the checked conditions in their fixed order, then the own condition. Null when there is none. */
function conditionList(completeWhen: Task["completeWhen"]): string | null {
  const parts = [...TASK_CHECKS.filter((check) => completeWhen.checks.includes(check)).map((check) => CHECK_SHORT_LABELS[check]), ...(completeWhen.own === null ? [] : [completeWhen.own])];
  return parts.length === 0 ? null : parts.join(", ");
}

/** The amber notice under Run on when the model the session used differs from the planned one. */
export function ModelDiffersNotice({ planned, observed }: { planned: string | null; observed: string | null | undefined }) {
  return <div className="taskModelNotice" role="status">
    <span className="taskModelNoticeTitle">Observed model differs</span>{" "}
    <span>Planned <code>{planned}</code>, latest recorded request used <code>{observed}</code>.</span>
  </div>;
}

/**
 * The Run settings of a started task as a label/value list. Nothing here is a control: the session works from the task as it was
 * when it started. `issue` is the GitHub issue row, `extra` the rows after it, and `notice` the observed-model notice under Run on. `conditionsListed` leaves out
 * the Complete when row when the Review panel already lists the conditions with their results.
 */
export function TaskRunSettingsRead({ task, board, models, conditionsListed, notice, issue, extra, onOpenTask }: {
  task: Pick<Task, "id" | "featureId" | "run" | "completeWhen">;
  board: BoardShape;
  models: TaskModelOptions;
  conditionsListed: boolean;
  notice?: ReactNode;
  issue: ReactNode;
  /** More rows of the same list after GitHub issue: Runs after and Sessions. */
  extra?: ReactNode;
  onOpenTask?: (task: Task, opener: HTMLElement) => void;
}) {
  const { run } = task;
  const feature = board.features.find((entry) => entry.id === task.featureId) ?? null;
  const runOn = run.provider === null ? null : runSelectOptions(models, run).find((option) => option.value === runSelectValue(run));
  const conditions = conditionList(task.completeWhen);
  return <RunSettings>
    <TaskRow label="Feature" top={feature ? "text" : undefined}>
      {feature ? feature.name : <TaskRowNone>No feature</TaskRowNone>}
      {feature && <FeatureSiblings key={feature.id} board={board} featureId={feature.id} selfId={task.id} onOpenTask={onOpenTask} />}
    </TaskRow>
    <TaskRow label="Run on" top={notice ? "text" : undefined}>
      {runOn ? `${runOn.group ? `${runOn.group} · ` : ""}${runOn.label}` : <TaskRowNone>Not set</TaskRowNone>}
      {notice}
    </TaskRow>
    <TaskRow label="Effort">{run.effort ? EFFORT_LABELS[run.effort] : <TaskRowNone>Not set</TaskRowNone>}</TaskRow>
    {canRemoteControl(run) && <TaskRow label={REMOTE_CONTROL_LABEL}>{run.remoteControl === true ? "On" : "Off"}</TaskRow>}
    <TaskRow label="When done">{run.keepWorktree === true ? KEEP_WORKTREE_LABEL : REMOVE_WORKTREE_LABEL}</TaskRow>
    {!conditionsListed && <TaskRow label="Complete when">{conditions ?? <TaskRowNone>None</TaskRowNone>}</TaskRow>}
    {issue}
    {extra}
  </RunSettings>;
}
