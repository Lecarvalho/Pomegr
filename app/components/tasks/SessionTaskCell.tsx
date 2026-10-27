import Link from "next/link";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { featureRouteId } from "./task-features";
import { taskStateLabels, validIssueNumber } from "./task-presentation";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

export function sessionTaskChip(state: SessionTaskReference["state"]): { label: string; tone: "warning" | "neutral" } | null {
  if (state === "needs_review" || state === "stalled") return { label: taskStateLabels[state], tone: "warning" };
  return state === "done" ? { label: taskStateLabels.done, tone: "neutral" } : null;
}

export function sessionTaskHref(task: SessionTaskReference): string | null {
  return REPOSITORY_ID.test(task.repositoryId) ? `/tasks?repository=${task.repositoryId}` : null;
}

/** The board address that also names a feature: the board opens that feature. Without a usable feature ID it is the board's own address. */
export function sessionFeatureHref(task: SessionTaskReference, featureId: string | null = task.featureId): string | null {
  const boardHref = sessionTaskHref(task);
  const feature = featureRouteId(featureId);
  return boardHref && feature ? `${boardHref}&feature=${feature}` : boardHref;
}

function TaskId({ task }: { task: SessionTaskReference }) {
  const href = sessionTaskHref(task);
  return href ? <Link className="commandTextLink commandSessionTaskId" href={href} aria-label={`Open task ${task.id} on its board`}>{task.id}</Link> : <span className="commandSessionTaskId">{task.id}</span>;
}

function TaskEntry({ task, omitFeature, assigned = false }: { task: SessionTaskReference; omitFeature: boolean; assigned?: boolean }) {
  const chip = sessionTaskChip(task.state);
  const placed = task.feature !== null && !omitFeature;
  const issue = validIssueNumber(task.issue);
  return <>
    <span className="commandSessionTaskHead">
      <TaskId task={task} />
      {issue !== null && <span className="commandSessionTaskIssue" title={`GitHub issue ${issue}`}>
        <span aria-hidden="true">#{issue}</span>
        <span className="commandVisuallyHidden">GitHub issue #{issue}</span>
      </span>}
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
      {task.role === "review" && <span className="commandSessionTaskFeature">Review</span>}
      {assigned && <span className="commandSessionTaskFeature">Assigned</span>}
    </span>
    {placed && <span className="commandSessionTaskFeature">{task.feature}</span>}
  </>;
}

const ASSIGNED_SHOWN = 16;

export function SessionTaskCell({ task, assigned: listed, omitFeature = false }: {
  task: SessionTaskReference | null | undefined;
  /** The tasks the session is assigned to, beside the one it was started for. */
  assigned?: SessionTaskReference[];
  omitFeature?: boolean;
}) {
  // A directory row is not validated field by field, so only a well-formed reference is drawn.
  const assigned = (Array.isArray(listed) ? listed : []).filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string" && typeof entry.repositoryId === "string").slice(0, ASSIGNED_SHOWN);
  if (!task && assigned.length === 0) return <span title="Not started from a task, reviewing one, or assigned to one">—</span>;
  // One assigned task and no started one reads like a started task, marked Assigned; more read as one line of IDs.
  const sole = !task && assigned.length === 1 ? assigned[0] : null;
  return <div className="commandSessionTask">
    {task && <TaskEntry task={task} omitFeature={omitFeature} />}
    {sole && <TaskEntry task={sole} omitFeature={omitFeature} assigned />}
    {!sole && assigned.length > 0 && <span className="commandSessionTaskHead commandSessionTaskAssigned">
      <span className="commandSessionTaskFeature">Assigned</span>
      {assigned.map((entry) => <TaskId key={`${entry.repositoryId}:${entry.id}`} task={entry} />)}
    </span>}
  </div>;
}

export function SessionTaskNote() {
  return <p className="commandUnavailableNote commandSessionTaskNote">Task shows the task a session was started for or reviewed (marked Review), and the tasks it is assigned to. A dash means none. While the session works on the task, State is the only status. A task chip appears only for an outcome the session cannot show: Needs review, Stalled, or Done.</p>;
}
