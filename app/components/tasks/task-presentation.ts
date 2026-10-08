import type { SessionActivityStatus } from "../../../shared/monitor-contract";
import type { Task, TaskBoard, TaskState } from "../../../shared/task-contract";
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

/** States that end a task's run. They stay on the card even while its session is still bound. */
const OUTCOME_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked", "done"]);
/** Outcomes that hold the queue and need the user, so the card carries the attention border. */
const ATTENTION_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked"]);
const SESSION_STATUSES = new Set<SessionActivityStatus>(["working", "needs_input", "idle", "open", "stopped", "closed", "unknown"]);

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
 * The chip is the task's own state, except that while a session is bound and the task has no outcome
 * yet it shows that session's state, borrowed. There is no Running task state, and nothing is derived
 * here: whatever the monitor committed is what the card shows. `nextQueued` is true for the one task the monitor
 * lists first in `queue.order`: it reads "Queued · next".
 */
export function taskChip(task: Task, nextQueued = false): TaskChip {
  if (task.session && !OUTCOME_STATES.has(task.state)) {
    const status = SESSION_STATUSES.has(task.session.state as SessionActivityStatus) ? task.session.state as SessionActivityStatus : "unknown";
    const { label, state } = sessionState({ activityStatus: status });
    const tone: ChipTone = state === "active" ? "positive" : state === "attention" ? "warning" : "neutral";
    return { label, tone, ink: false, border: state === "active" ? "live" : "none" };
  }
  const attention = ATTENTION_STATES.has(task.state);
  const tone: ChipTone = attention ? "warning" : task.state === "scheduled" ? "info" : "neutral";
  const label = task.state === "queued" && nextQueued ? "Queued · next" : taskStateLabels[task.state];
  return { label, tone, ink: task.state === "queued", border: attention ? "attention" : "none" };
}

/** The card shows the task text until its session has a title, then the session title. */
export function taskCardTitle(task: Task) {
  return task.session?.title || task.text;
}

export type TaskColumnView = { id: string; name: string; tasks: Task[] };

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
      tasks: (byColumn.get(column.id) ?? []).sort((left, right) => left.position - right.position || idNumber(left.id) - idNumber(right.id)),
    }));
}
