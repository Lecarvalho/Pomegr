import type { SessionActivityStatus } from "../../../shared/monitor-contract";
import { plainTaskText, type Task, type TaskBoard, type TaskColumnRole, type TaskState } from "../../../shared/task-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { sessionState } from "../../dashboard-utils";

export const taskStateLabels: Record<TaskState, string> = {
  not_queued: "Not queued",
  queued: "Queued",
  scheduled: "Scheduled",
  needs_review: "Needs review",
  stalled: "Stalled",
  blocked: "Blocked by agent",
  done: "Done",
};

/** Footer line for a linked task whose session has not reported: it can hold the queue, and the two exits leave the session running. */
export const AWAITING_REPORT_NOTE = "The session has not reported. Mark done and Requeue do not stop it.";

/** A task with a linked session and no outcome yet: the same set the monitor lets the user resolve without a report. */
export function taskAwaitsReport(task: Pick<Task, "state" | "session">): boolean {
  return task.session !== null && (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled");
}

/** States that end a task's run. They stay on the card even while its session is still bound. */
const OUTCOME_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked", "done"]);
/** Outcomes that need the user, so the card carries the attention border. Only Stalled and Blocked by agent hold the queue. */
const ATTENTION_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked"]);
/** What the Sessions list State column shows once the monitor holds committed facts. `unknown` is the monitor saying it has none yet. */
const BORROWED_STATUSES = new Set<SessionActivityStatus>(["working", "needs_input", "idle", "open", "stopped", "closed"]);

type ChipTone = "neutral" | "info" | "positive" | "warning";

export type TaskChip = {
  label: string;
  /** Existing `.commandChip` tone: chips stay outline labels and a tone recolors the text only. */
  tone: ChipTone;
  /** Queued reads in ink rather than muted so it differs from Not queued; still an outline chip. */
  ink: boolean;
  /** Card border signal: green while the bound session works, amber for a state that needs the user. */
  border: "none" | "live" | "attention";
};

/**
 * The session state a task borrows, in the Sessions list's own label and state. Only a task with a linked session and no
 * outcome of its own borrows, and only once the monitor holds committed facts for that session: `unknown` (or any value
 * the list does not render) keeps the task's own chip, so a session state is never shown and then retracted.
 */
function borrowedSessionState(task: Task) {
  if (!task.session || OUTCOME_STATES.has(task.state)) return null;
  const status = task.session.state as SessionActivityStatus;
  return BORROWED_STATUSES.has(status) ? sessionState({ activityStatus: status }) : null;
}

/**
 * The chip is the task's own state, except that while a session is bound and the task has no outcome
 * yet it shows that session's state, borrowed. There is no Running task state, and nothing is derived
 * here: whatever the monitor committed is what the card shows. `nextQueued` is true for the one task the monitor
 * lists first in `queue.order`: it reads "Queued · next".
 */
export function taskChip(task: Task, nextQueued = false): TaskChip {
  const borrowed = borrowedSessionState(task);
  if (borrowed) {
    const tone: ChipTone = borrowed.state === "active" ? "positive" : borrowed.state === "attention" ? "warning" : "neutral";
    return { label: borrowed.label, tone, ink: false, border: borrowed.state === "active" ? "live" : "none" };
  }
  const attention = ATTENTION_STATES.has(task.state);
  const tone: ChipTone = attention ? "warning" : task.state === "scheduled" ? "info" : "neutral";
  const label = task.state === "queued" && nextQueued ? "Queued · next" : taskStateLabels[task.state];
  return { label, tone, ink: task.state === "queued", border: attention ? "attention" : "none" };
}

/** The highest GitHub issue number the monitor accepts as a task source (`shared/task-contract.ts`, `server/tasks/task-source.mjs`). */
const ISSUE_NUMBER_MAX = 999_999_999;

/** A GitHub issue number the product may print: an integer from 1 to 999999999. Anything else is no source. */
export function validIssueNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= ISSUE_NUMBER_MAX ? value : null;
}

/** The number of the GitHub issue a task was promoted from (`Task.source`), or null. */
export function taskIssueNumber(task: Pick<Task, "source">): number | null {
  return task.source?.kind === "github_issue" ? validIssueNumber(task.source.number) : null;
}

/** The linked session's catalog title when it is a non-empty string, else null. */
export function taskSessionTitle(task: Task): string | null {
  const title = task.session?.title;
  return typeof title === "string" && title.trim() !== "" ? title : null;
}

/** The card shows the task text until its session has a title, then the session title. */
export function taskCardTitle(task: Task) {
  return taskSessionTitle(task) ?? plainTaskText(task.text);
}

/** The session view the Sessions list links its row to for this ID, or null for an ID the route cannot carry. */
export function taskSessionHref(sessionId: string): string | null {
  try {
    return `/sessions/${encodeSessionRoute(sessionId)}`;
  } catch {
    return null;
  }
}

export type TaskColumnView = { id: string; name: string; role: TaskColumnRole | null; tasks: Task[] };

function idNumber(id: string) {
  return Number(id.slice(2));
}

/** Columns in board order, each with its tasks in position order. A task in no known column is not drawn. */
export function taskColumns(board: Pick<TaskBoard, "columns" | "tasks">): TaskColumnView[] {
  const byColumn = new Map<string, Task[]>();
  for (const task of board.tasks) {
    byColumn.set(task.columnId, [...(byColumn.get(task.columnId) ?? []), task]);
  }
  return [...board.columns]
    .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id))
    .map((column) => ({
      id: column.id,
      name: column.name,
      role: column.role ?? null,
      tasks: (byColumn.get(column.id) ?? []).sort((left, right) => left.position - right.position || idNumber(left.id) - idNumber(right.id)),
    }));
}
