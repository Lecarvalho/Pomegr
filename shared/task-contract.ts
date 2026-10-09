/**
 * Per-repository task board served from the monitor's private task store.
 *
 * Privacy: task text, the own condition, and column and feature names are user-authored
 * content (a separate data class from observation). They reach the browser only through
 * `GET /api/tasks` and trusted desktop IPC, never through `/api/state`, session catalogs,
 * reports, logs, notifications, diagnostics, or checkpoints. Provider and model names,
 * effort, check results, and times are normalized enums or identifiers. The board never
 * carries commands, command output, diffs, provider payloads, paths, or the private
 * dispatch token. See AGENTS.md ("Task board and dispatch") and
 * docs/internal/architecture/tasks.md.
 */

export type TaskCheck = "pr_open" | "tree_clean" | "commit_on_branch" | "pr_merged" | "ci_passed";
export type TaskState = "not_queued" | "queued" | "scheduled" | "needs_review" | "stalled" | "blocked" | "done";
export type TaskProvider = "claude" | "codex";
export type TaskEffort = "low" | "medium" | "high" | "xhigh";
export type TaskBoardReadiness = "ready" | "loading" | "unavailable" | "desktop_only";
export type TaskQueueStatus = "idle" | "running" | "blocked" | "paused";
/**
 * Why a queue is paused: a start the queue made did not succeed. `session_not_linked` is a started terminal
 * whose session never reported back in time. A fixed value only; it never carries a path, command, or error text.
 */
export type TaskQueuePauseReason = "cli_missing" | "plugin_missing" | "unsupported_platform" | "start_failed" | "session_not_linked";
/** Fixed error of a mutation that changed nothing. */
export type TaskActionError = "invalid" | "not_found" | "limit" | "conflict" | "unsupported";

export type TaskColumn = { id: string; name: string; position: number };
export type TaskFeature = { id: string; name: string; done: boolean };
export type TaskRun = { provider: TaskProvider | null; model: string | null; effort: TaskEffort | null };
export type TaskSession = { id: string; title: string | null; state: string; observedModel: string | null };
export type TaskReport = { at: string; results: { check: TaskCheck; passed: boolean }[]; blockReason: string | null };
/**
 * `order` holds the IDs of the queued tasks in the order they would start: features in board order, each
 * feature's steps ascending, tasks of one step by task number, then tasks without a feature in the order they
 * were queued. Its first entry is the "Queued · next" task. It carries IDs only, at most one per task.
 *
 * `idle` is the queue turned off (the default); `running` is on. `blocked` names in `blockedBy` the task that
 * needs the user (Needs review, Stalled, or Blocked by agent). `paused` names in `blockedBy` the task whose start
 * did not succeed, with the fixed `pauseReason`; `pauseReason` is null in every other status.
 */
export type TaskQueue = {
  status: TaskQueueStatus;
  blockedBy: string | null;
  pauseReason: TaskQueuePauseReason | null;
  order: string[];
  /** The start gates as the monitor last judged them. Absent from a board that is not ready and from an older monitor. */
  gates?: TaskGates;
};

/** The usage a provider may have reached, in percent of its five-hour window, before no new session starts on it. */
export type TaskGateThreshold = 70 | 85 | 95;
/** `unknown` is missing, stale, or partial evidence. It holds a start like a failed gate and never counts as passed. */
export type TaskGateUsageStatus = "ok" | "over" | "unknown";
export type TaskGateProviderStatus = "ok" | "incident" | "unknown";
export type TaskGateWorkingTree = "clean" | "dirty" | "unknown";
/** Why a start is held. Fixed values only; never a path, a command, or error text. */
export type TaskGateReason = "previous_step" | "usage_over" | "usage_unknown" | "provider_incident" | "provider_status_unknown" | "tree_dirty" | "tree_unknown";
/** The whole percentages Usage limits already shows for the five-hour and seven-day windows, or null when not observed. */
export type TaskGateUsage = { status: TaskGateUsageStatus; fiveHourPercent: number | null; sevenDayPercent: number | null };
/**
 * Every start is checked against these gates, from facts the monitor already committed. `next` is the task the
 * queue would start next (`order[0]`), the earlier task of its feature it waits on, and the gates that hold it;
 * no reason means it may start. `next` is null when no task is queued.
 */
export type TaskGates = {
  threshold: TaskGateThreshold;
  usage: Record<TaskProvider, TaskGateUsage>;
  providerStatus: Record<TaskProvider, TaskGateProviderStatus>;
  workingTree: TaskGateWorkingTree;
  next: { taskId: string; provider: TaskProvider; blockedBy: string | null; reasons: TaskGateReason[] } | null;
};

export type Task = {
  id: string; // "T-<n>", monotonic per repository
  text: string;
  columnId: string;
  position: number;
  featureId: string | null;
  step: number | null; // step >= 1
  run: TaskRun;
  doneWhen: { checks: TaskCheck[]; own: string | null };
  state: TaskState;
  scheduledAt: string | null;
  session: TaskSession | null; // borrowed from observation; never transcript content
  report: TaskReport | null;
  createdAt: string;
  updatedAt: string;
};

/** GET /api/tasks?repositoryId=repo-<24 hex> */
export type TaskBoard = {
  version: 1;
  readiness: TaskBoardReadiness;
  repositoryId: string;
  columns: TaskColumn[];
  features: TaskFeature[];
  tasks: Task[];
  queue: TaskQueue;
  /** Last committed Codex client-catalog models for the Run on list; never entitlement. Absent from an older monitor, which means empty. */
  runModels?: TaskRunModels;
};

/** At most 64 rows; `id` is a validated model identifier (120 characters), `label` a safe one-line name (64) or null. */
export type TaskRunModels = { codex: { id: string; label: string | null }[] };

/** Repository identity accepted by the board; the same pattern every repository route uses. */
export const TASK_REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
export const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;

/** Bounds per repository and per field; the monitor enforces them on every write. */
export const TASK_BOUNDS = {
  tasksPerRepository: 500,
  columnsPerRepository: 12,
  featuresPerRepository: 50,
  textLength: 4000,
  ownConditionLength: 500,
  columnNameLength: 40,
  featureNameLength: 80,
  blockReasonLength: 200,
  modelIdentifierLength: 120,
} as const;

export const TASK_CHECKS: readonly TaskCheck[] = ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"];
export const TASK_STATES: readonly TaskState[] = ["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"];
export const TASK_PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];
export const TASK_EFFORTS: readonly TaskEffort[] = ["low", "medium", "high", "xhigh"];
export const TASK_QUEUE_STATUSES: readonly TaskQueueStatus[] = ["idle", "running", "blocked", "paused"];
export const TASK_QUEUE_PAUSE_REASONS: readonly TaskQueuePauseReason[] = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked"];
export const TASK_GATE_THRESHOLDS: readonly TaskGateThreshold[] = [70, 85, 95];
export const DEFAULT_TASK_GATE_THRESHOLD: TaskGateThreshold = 85;
export const TASK_GATE_REASONS: readonly TaskGateReason[] = ["previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown"];
export const TASK_ACTION_ERRORS: readonly TaskActionError[] = ["invalid", "not_found", "limit", "conflict", "unsupported"];
/** Columns seeded, in this order, the first time a repository's board is read. */
export const DEFAULT_TASK_COLUMNS: readonly string[] = ["Backlog", "Ready", "In progress", "Review", "Done"];

/** A board with no content, for loading, unavailable, and desktop-only answers. */
export function createEmptyTaskBoard(repositoryId: string, readiness: TaskBoardReadiness): TaskBoard {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] } };
}
