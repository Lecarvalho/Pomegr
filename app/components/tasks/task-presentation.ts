import type { SessionActivityStatus } from "../../../shared/monitor-contract";
import { plainTaskText, type Task, type TaskBoard, type TaskColumnRole, type TaskState } from "../../../shared/task-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { sessionState } from "../../dashboard-utils";
import { splitTaskTitle } from "./task-tags";

export const taskStateLabels: Record<TaskState, string> = {
  not_queued: "Not queued",
  queued: "Queued",
  scheduled: "Scheduled",
  needs_review: "Needs review",
  stalled: "Stalled",
  blocked: "Blocked by agent",
  done: "Done",
};

export const AWAITING_REPORT_NOTE = "The session has not reported. Mark done ends it; Requeue does not.";

export function taskAwaitsReport(task: Pick<Task, "state" | "session">): boolean {
  return task.session !== null && (task.state === "not_queued" || task.state === "queued" || task.state === "scheduled");
}

const OUTCOME_STATES = new Set<TaskState>(["needs_review", "stalled", "blocked", "done"]);

/** The lock line of a started task, beside the lock glyph under its Task label. */
export const STARTED_NOTE = "Started, so read-only.";
export const STARTED_REQUEUE_NOTE = `${STARTED_NOTE} Requeue to edit.`;
/** The footer note of a modal whose task started while it held unsaved edits: the session works from the stored text, so the edits are dropped. */
export const EDITS_DROPPED_NOTE = "This task started before your changes were saved.";

/** A task with a session or an outcome has started: the monitor refuses a change to it until it is requeued. */
export function taskStarted(task: Pick<Task, "state" | "session">): boolean {
  return task.session !== null || OUTCOME_STATES.has(task.state);
}
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

/** The label of the one task the monitor names as next, on every surface but the board. */
export const QUEUED_NEXT_LABEL = "Queued · next";
/** The same task's label on the board, where the Ready lane already says it is queued. */
export const BOARD_NEXT_LABEL = "Next";

export function taskChip(task: Task, nextQueued = false, nextLabel = QUEUED_NEXT_LABEL): TaskChip {
  const borrowed = borrowedSessionState(task);
  if (borrowed) {
    const tone: ChipTone = borrowed.state === "active" ? "positive" : borrowed.state === "attention" ? "warning" : "neutral";
    return { label: borrowed.label, tone, ink: false, border: borrowed.state === "active" ? "live" : borrowed.state === "attention" ? "attention" : "none" };
  }
  const attention = ATTENTION_STATES.has(task.state);
  const tone: ChipTone = attention ? "warning" : task.state === "scheduled" ? "info" : "neutral";
  const label = task.state === "queued" && nextQueued ? nextLabel : taskStateLabels[task.state];
  return { label, tone, ink: task.state === "queued", border: attention ? "attention" : "none" };
}

/** The five fixed lanes of a board, by the state each one already says. */
export type TaskLane = "backlog" | "ready" | "in_progress" | "review" | "done";

const LANE_STATE_WORDS: Record<TaskLane, string> = {
  backlog: taskStateLabels.not_queued,
  ready: taskStateLabels.queued,
  in_progress: sessionState({ activityStatus: "working" }).label,
  review: taskStateLabels.needs_review,
  done: taskStateLabels.done,
};

/** A board card draws its chip only when the lane it sits in does not already say that state. */
export function laneSaysChip(lane: TaskLane, chip: Pick<TaskChip, "label">): boolean {
  return chip.label === LANE_STATE_WORDS[lane];
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

/** The title a card, a search result, or a related row names a task by: the session title, else the task text from its title line on (see `splitTaskTitle`). */
export function taskCardTitle(task: Task) {
  const { title, rest } = splitTaskTitle(plainTaskText(task.text));
  return taskSessionTitle(task) ?? (rest.trim() === "" ? title : `${title}\n${rest.trimEnd()}`);
}

export type TaskTextPreview = { lead: string; rest: string; tags: string[] };

const LEAD_MIN = 24;
const SENTENCE_START = /^[\p{Lu}\p{N}`"'“(\[*-]/u;

/** The index after the first sentence of a line, outside a code span, or -1 when the line is one sentence. */
function sentenceEnd(line: string): number {
  let inCode = false;
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];
    if (character === "`") inCode = !inCode;
    else if (!inCode && index >= LEAD_MIN && (character === "." || character === "!" || character === "?") && /\s/u.test(line[index + 1]) && SENTENCE_START.test(line.slice(index + 1).trimStart())) return index + 1;
  }
  return -1;
}

/**
 * A task text as a card draws it: the tags of its first line, then the first sentence of the title line (`splitTaskTitle`), then the remaining text on one line.
 * A heuristic split, not a summary.
 */
export function taskTextPreview(text: string): TaskTextPreview {
  const { tags, title, rest } = splitTaskTitle(plainTaskText(text));
  const end = sentenceEnd(title);
  const lead = end === -1 ? title : title.slice(0, end);
  const lines = rest.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return { lead, rest: [end === -1 ? "" : title.slice(end).trim(), ...lines].filter((line) => line !== "").join(" "), tags };
}

/** A line split at its backtick code spans: the odd entries are code. */
export function inlineCodeParts(text: string): string[] {
  return text.split(/`([^`]+)`/u);
}

export function taskSessionHref(sessionId: string): string | null {
  try {
    return `/sessions/${encodeSessionRoute(sessionId)}`;
  } catch {
    return null;
  }
}

export type TaskColumnView = { id: string; name: string; role: TaskColumnRole | null; /** The fixed lane the column is: its role, else Backlog first and Ready second. */ lane: TaskLane | null; tasks: Task[] };

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
    .map((column, index) => ({
      id: column.id,
      name: column.name,
      role: column.role ?? null,
      lane: column.role ?? (index === 0 ? "backlog" as const : index === 1 ? "ready" as const : null),
      tasks: (byColumn.get(column.id) ?? []).sort((left, right) => left.position - right.position || idNumber(left.id) - idNumber(right.id)),
    }));
}
