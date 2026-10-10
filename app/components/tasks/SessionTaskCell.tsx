import Link from "next/link";
import type { SessionTaskReference } from "../../../shared/session-catalog-contract";
import { taskStateLabels } from "./task-presentation";

const REPOSITORY_ID = /^repo-[a-f0-9]{24}$/u;

/**
 * The chip of the Sessions list's Task cell (D331, D332, D457): only for an outcome the session's own state cannot
 * show. Needs review and Stalled wait for the user, so they carry the warning tone; Done is a plain outline chip.
 * Blocked by agent is served but has no chip here: the product owner's list names these three.
 */
export function sessionTaskChip(state: SessionTaskReference["state"]): { label: string; tone: "warning" | "neutral" } | null {
  if (state === "needs_review" || state === "stalled") return { label: taskStateLabels[state], tone: "warning" };
  return state === "done" ? { label: taskStateLabels.done, tone: "neutral" } : null;
}

/** The repository board that holds the task, or null for an ID the route cannot carry. */
export function sessionTaskHref(task: SessionTaskReference): string | null {
  return REPOSITORY_ID.test(task.repositoryId) ? `/tasks?repository=${task.repositoryId}` : null;
}

/**
 * The Task cell (D330 to D333): the task ID, the outcome chip, and the feature and step. A session the user
 * started has a dash. `omitFeature` drops the name a Feature group header already shows.
 */
export function SessionTaskCell({ task, omitFeature = false }: { task: SessionTaskReference | null | undefined; omitFeature?: boolean }) {
  if (!task) return <span title="Not started from a task">—</span>;
  const chip = sessionTaskChip(task.state);
  const href = sessionTaskHref(task);
  const placed = task.feature !== null && task.step !== null;
  return <div className="commandSessionTask">
    <span className="commandSessionTaskHead">
      {href ? <Link className="commandTextLink commandSessionTaskId" href={href} aria-label={`Open task ${task.id} on its board`}>{task.id}</Link> : <span className="commandSessionTaskId">{task.id}</span>}
      {chip && <span className={`commandChip ${chip.tone}`}>{chip.label}</span>}
    </span>
    {placed && <span className="commandSessionTaskFeature">{omitFeature ? `Step ${task.step}` : `${task.feature} · step ${task.step}`}</span>}
  </div>;
}

/** The footnote under the table (D343), shown with the Task column. */
export function SessionTaskNote() {
  return <p className="commandUnavailableNote commandSessionTaskNote">Task shows the task a session was started for. A dash means you started the session yourself. While the session works on the task, State is the only status. A task chip appears only for an outcome the session cannot show: Needs review, Stalled, or Done.</p>;
}
