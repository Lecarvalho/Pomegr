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
 */
export type TaskQueue = { status: TaskQueueStatus; blockedBy: string | null; order: string[] };

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
};

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
export const TASK_ACTION_ERRORS: readonly TaskActionError[] = ["invalid", "not_found", "limit", "conflict", "unsupported"];
/** Columns seeded, in this order, the first time a repository's board is read. */
export const DEFAULT_TASK_COLUMNS: readonly string[] = ["Backlog", "Ready", "In progress", "Review", "Done"];

/** A board with no content, for loading, unavailable, and desktop-only answers. */
export function createEmptyTaskBoard(repositoryId: string, readiness: TaskBoardReadiness): TaskBoard {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, order: [] } };
}
