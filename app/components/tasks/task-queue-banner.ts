import type { Task, TaskBoard, TaskCheck, TaskQueuePauseReason } from "../../../shared/task-contract";
import type { TaskWorktreeOpenStatus } from "./task-desktop";
import { CHECK_LABELS } from "./task-fields";

// The words of the Queue banner (design contract D30-D34, D108-D114, D444) and the paused variant. Pure: every
// sentence is chosen from the committed queue status and the blocker task on the board, never from anything the
// client guessed, so a banner is not shown and then withdrawn.

/** The Board names how many checks failed; the Queue names which ones (D444). */
export type QueueBannerView = "board" | "queue";

export type QueueBannerModel = {
  title: string;
  body: string;
  /** The task the queue names, when the board holds it. */
  task: Task | null;
  /** The task needs the user, so Mark done and Requeue apply to it. */
  resolvable: boolean;
  /** The task whose worktree holds uncommitted changes, so the Open folder action applies; null for every other state. */
  dirtyWorktreeTaskId: string | null;
};

const SESSIONS_CONTINUE = "Running sessions continue.";

/** One clause per fixed pause reason; the monitor sends the value only, never an error text. */
const PAUSE_REASONS: Record<TaskQueuePauseReason, string> = {
  cli_missing: "the provider's command-line tool was not found on this computer.",
  plugin_missing: "the Pomegr plugin is not installed in this repository.",
  unsupported_platform: "starting sessions is available on Windows only.",
  start_failed: "the terminal window could not be opened.",
  session_not_linked: "its terminal opened, but the session did not report back.",
  worktree_dirty: "its worktree has uncommitted changes, and Pomegr never removes them.",
};
const UNKNOWN_PAUSE_REASON = "the start did not succeed.";

/** One line per fixed result of opening a task worktree's folder; the desktop never sends a path or an error text. */
export function worktreeOpenLine(status: TaskWorktreeOpenStatus): string {
  if (status === "opened") return "The folder is open.";
  if (status === "not_found") return "The worktree folder was not found.";
  return "The folder could not be opened.";
}

/** The tasks that hold a queue: the ones that end a run and need the user. */
const RESOLVABLE_STATES = new Set<Task["state"]>(["needs_review", "stalled", "blocked"]);

function failedChecks(task: Task): TaskCheck[] {
  return (task.report?.results ?? []).filter((result) => !result.passed).map((result) => result.check);
}

/** "one check did not pass" on the Board; `the check "Pull request open" did not pass` on the Queue. */
function failureClause(task: Task, view: QueueBannerView) {
  const failed = failedChecks(task);
  if (failed.length === 0) return "a check did not pass";
  if (view === "queue") return `${failed.length === 1 ? "the check" : "the checks"} ${failed.map((check) => `"${CHECK_LABELS[check]}"`).join(", ")} did not pass`;
  return failed.length === 1 ? "one check did not pass" : `${failed.length} checks did not pass`;
}

function blockedBody(task: Task | null, view: QueueBannerView) {
  if (!task || !RESOLVABLE_STATES.has(task.state)) return `A task needs you. ${SESSIONS_CONTINUE} Nothing new starts until it is resolved.`;
  const tail = `${SESSIONS_CONTINUE} Nothing new starts until you resolve ${task.id}.`;
  if (task.state === "needs_review") return `${task.id} reported complete, but ${failureClause(task, view)}. ${tail}`;
  if (task.state === "stalled") return `${task.id}'s session ended with no report. ${tail}`;
  return `${task.id}'s agent reported it cannot continue. ${tail}`;
}

/** The banner for a blocked or paused queue, or null for the others. */
export function queueBanner(board: Pick<TaskBoard, "queue" | "tasks">, view: QueueBannerView): QueueBannerModel | null {
  const { status, blockedBy, pauseReason } = board.queue;
  if (status !== "blocked" && status !== "paused") return null;
  const task = blockedBy === null ? null : board.tasks.find((entry) => entry.id === blockedBy) ?? null;
  if (status === "blocked") return { title: "Queue blocked", body: blockedBody(task, view), task, resolvable: task !== null && RESOLVABLE_STATES.has(task.state), dirtyWorktreeTaskId: null };
  const subject = blockedBy === null ? "A task" : blockedBy;
  const reason = pauseReason === null ? UNKNOWN_PAUSE_REASON : PAUSE_REASONS[pauseReason];
  return { title: "Queue paused", body: `${subject} could not start: ${reason} ${SESSIONS_CONTINUE} Turn the queue on again to retry.`, task, resolvable: false, dirtyWorktreeTaskId: pauseReason === "worktree_dirty" ? blockedBy : null };
}

/** The status line under the Tasks heading for a queue that holds nothing back; the banner words the other two. */
export function queueStatusLine(status: TaskBoard["queue"]["status"]): string | null {
  if (status === "idle") return "The queue is off. Queued tasks start only when you start them.";
  if (status === "running") return "The queue is on. The next queued task starts when the one before it is done.";
  return null;
}
