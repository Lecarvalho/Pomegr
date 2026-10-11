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

export const AWAITING_REPORT_NOTE = "The session has not reported. Mark done and Requeue do not stop it.";

export function taskAwaitsReport(task: Pick<Task, "state" | "session">): boolean {
  return task.session !== null && (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled");
}

const OUTCOME_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked", "done"]);
const ATTENTION_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked"]);
const BORROWED_STATUSES = new Set<SessionActivityStatus>(["working", "needs_input", "idle", "open", "stopped", "closed"]);

type ChipTone = "neutral" | "info" | "positive" | "warning";

export type TaskChip = {
  label: string;
  tone: ChipTone;
  ink: boolean;
  border: "none" | "live" | "attention";
};

/** The session state a task borrows, in the Sessions list's own label and state. */
function borrowedSessionState(task: Task) {
  if (!task.session || OUTCOME_STATES.has(task.state)) return null;
  const status = task.session.state as SessionActivityStatus;
  return BORROWED_STATUSES.has(status) ? sessionState({ activityStatus: status }) : null;
}

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

const ISSUE_NUMBER_MAX = 999_999_999;

/** A GitHub issue number the product may print. */
export function validIssueNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= ISSUE_NUMBER_MAX ? value : null;
}

export function taskIssueNumber(task: Pick<Task, "source">): number | null {
  return task.source?.kind === "github_issue" ? validIssueNumber(task.source.number) : null;
}

/** The linked session's catalog title when it is a non-empty string, else null. */
export function taskSessionTitle(task: Task): string | null {
  const title = task.session?.title;
  return typeof title === "string" && title.trim() !== "" ? title : null;
}

export function taskCardTitle(task: Task) {
  return taskSessionTitle(task) ?? plainTaskText(task.text);
}

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
