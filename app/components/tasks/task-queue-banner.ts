import type { Task, TaskBoard, TaskQueuePauseReason } from "../../../shared/task-contract";
import type { TaskWorktreeOpenStatus } from "./task-desktop";

export type QueueBannerView = "board" | "queue";

export type QueueBannerModel = {
  title: string;
  body: string;
  task: Task | null;
  resolvable: boolean;
  dirtyWorktreeTaskId: string | null;
};

const SESSIONS_CONTINUE = "Running sessions continue.";

/** One clause per fixed pause reason. */
const PAUSE_REASONS: Record<TaskQueuePauseReason, string> = {
  cli_missing: "the provider's command-line tool was not found on this computer.",
  plugin_missing: "the Pomegr plugin is not installed in this repository, or needs an update.",
  unsupported_platform: "starting sessions is available on Windows only.",
  start_failed: "the terminal window could not be opened.",
  session_not_linked: "its terminal opened, but the session did not report back.",
  worktree_dirty: "its worktree has uncommitted changes, and Pomegr never removes them.",
};
const UNKNOWN_PAUSE_REASON = "the start did not succeed.";

/** One line per fixed result of opening a task worktree's folder. */
export function worktreeOpenLine(status: TaskWorktreeOpenStatus): string {
  if (status === "opened") return "The folder is open.";
  if (status === "not_found") return "The worktree folder was not found.";
  return "The folder could not be opened.";
}

const RESOLVABLE_STATES = new Set<Task["state"]>(["stalled", "blocked"]);

function blockedBody(task: Task | null) {
  if (!task || !RESOLVABLE_STATES.has(task.state)) return `A task needs you. ${SESSIONS_CONTINUE} Nothing new starts until it is resolved.`;
  const tail = `${SESSIONS_CONTINUE} Nothing new starts until you resolve ${task.id}.`;
  if (task.state === "stalled") return `${task.id}'s session ended with no report. ${tail}`;
  return `${task.id}'s agent reported it cannot continue. ${tail}`;
}

export function queueBanner(board: Pick<TaskBoard, "queue" | "tasks">): QueueBannerModel | null {
  const { status, blockedBy, pauseReason } = board.queue;
  if (status !== "blocked" && status !== "paused") return null;
  const task = blockedBy === null ? null : board.tasks.find((entry) => entry.id === blockedBy) ?? null;
  if (status === "blocked") return { title: "Queue blocked", body: blockedBody(task), task, resolvable: task !== null && RESOLVABLE_STATES.has(task.state), dirtyWorktreeTaskId: null };
  const subject = blockedBy === null ? "A task" : blockedBy;
  const reason = pauseReason === null ? UNKNOWN_PAUSE_REASON : PAUSE_REASONS[pauseReason];
  return { title: "Queue paused", body: `${subject} could not start: ${reason} ${SESSIONS_CONTINUE} Turn the queue on again to retry.`, task, resolvable: false, dirtyWorktreeTaskId: pauseReason === "worktree_dirty" ? blockedBy : null };
}

export function queueStatusLine(status: TaskBoard["queue"]["status"]): string | null {
  if (status === "idle") return "The queue is off. Queued tasks start only when you start them.";
  if (status === "running") return "The queue is on. The next queued task starts when the one before it is done or in review.";
  return null;
}
