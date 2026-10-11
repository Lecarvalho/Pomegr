import Link from "next/link";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { taskStateLabels, validIssueNumber } from "./task-presentation";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

export function sessionTaskChip(state: SessionTaskReference["state"]): { label: string; tone: "warning" | "neutral" } | null {
  if (state === "needs_review" || state === "stalled") return { label: taskStateLabels[state], tone: "warning" };
  return state === "done" ? { label: taskStateLabels.done, tone: "neutral" } : null;
}

export function sessionTaskHref(task: SessionTaskReference): string | null {
  return REPOSITORY_ID.test(task.repositoryId) ? `/tasks?repository=${task.repositoryId}` : null;
}

export function SessionTaskCell({ task, omitFeature = false }: { task: SessionTaskReference | null | undefined; omitFeature?: boolean }) {
  if (!task) return <span title="Not started from a task">—</span>;
  const chip = sessionTaskChip(task.state);
  const href = sessionTaskHref(task);
  const placed = task.feature !== null && task.step !== null;
  const issue = validIssueNumber(task.issue);
  return <div className="commandSessionTask">
    <span className="commandSessionTaskHead">
      {href ? <Link className="commandTextLink commandSessionTaskId" href={href} aria-label={`Open task ${task.id} on its board`}>{task.id}</Link> : <span className="commandSessionTaskId">{task.id}</span>}
      {issue !== null && <span className="commandSessionTaskIssue" title={`GitHub issue ${issue}`}>
        <span aria-hidden="true">#{issue}</span>
        <span className="commandVisuallyHidden">GitHub issue #{issue}</span>
      </span>}
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
    </span>
    {placed && <span className="commandSessionTaskFeature">{omitFeature ? `Step ${task.step}` : `${task.feature} · step ${task.step}`}</span>}
  </div>;
}

export function SessionTaskNote() {
  return <p className="commandUnavailableNote commandSessionTaskNote">Task shows the task a session was started for. A dash means you started the session yourself. While the session works on the task, State is the only status. A task chip appears only for an outcome the session cannot show: Needs review, Stalled, or Done.</p>;
}
