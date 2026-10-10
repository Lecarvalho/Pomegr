/**
 * Per-repository task board served from the monitor's private task store.
 *
 * Privacy: task text, the own condition, and feature names are user-authored
 * content (a separate data class from observation). They reach the browser only through
 * `GET /api/tasks` and trusted desktop IPC, never through `/api/state`, session catalogs,
 * reports, logs, notifications, diagnostics, or checkpoints. A task's images are the same data class: the board
 * carries only each one's ID, fixed type, and size, and the bytes reach only the desktop app. Provider and model names,
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
 * whose session never reported back in time. `worktree_dirty` is a requeued parallel task whose own worktree has
 * uncommitted changes, which Pomegr never removes. A fixed value only; it never carries a path, command, or error text.
 */
export type TaskQueuePauseReason = "cli_missing" | "plugin_missing" | "unsupported_platform" | "start_failed" | "session_not_linked" | "worktree_dirty";
/** Fixed error of a mutation that changed nothing. */
export type TaskActionError = "invalid" | "not_found" | "limit" | "conflict" | "unsupported";

/**
 * Where Pomegr moves a card by itself: to the `in_progress` column when its session links, to `review` when it needs
 * review, and to `done` when it is done. The board has five fixed columns; exactly one holds each role.
 */
export type TaskColumnRole = "in_progress" | "review" | "done";
/** `role` is null for Backlog and Ready, where no card is moved by itself, and absent from an older monitor, which means the same. */
export type TaskColumn = { id: string; name: string; position: number; role?: TaskColumnRole | null };
export type TaskFeature = { id: string; name: string; done: boolean };
export type TaskRun = { provider: TaskProvider | null; model: string | null; effort: TaskEffort | null };
/**
 * `checks` is the monitor's reading of the task's checked conditions while the task waits for its report, by the rule
 * and from the facts that will judge the report. It is absent once a report or an outcome is recorded, when no
 * condition is checked, and from an older monitor. It is a reading as of this board, not a result.
 */
export type TaskSession = { id: string; title: string | null; state: string; observedModel: string | null; checks?: { check: TaskCheck; passed: boolean }[] };
/**
 * Where a task came from. A task promoted from a GitHub issue carries the issue number only; its title and body were
 * copied once into the task's text and nothing is read from the issue again. Null for a task made on the board.
 */
export type TaskSource = { kind: "github_issue"; number: number };
/**
 * `attention` is what the agent asked the owner to look at when it reported complete: one line of at most 200
 * characters, agent-authored like `blockReason`. A report that carries one puts the task in Review even when every
 * check passed. Null when the agent named nothing, and absent from an older monitor, which means the same.
 */
/** The image formats a task may hold. The monitor decides the type from the bytes, never from a name. */
export type TaskImageType = "png" | "jpeg" | "gif" | "webp";
/**
 * One image attached to a task: an opaque ID, its fixed type, and its size in bytes. The board carries only this; the
 * bytes are user-authored content like the task text and reach only the desktop app, through trusted IPC.
 */
export type TaskImage = { id: string; type: TaskImageType; bytes: number };
export type TaskReport = { at: string; results: { check: TaskCheck; passed: boolean }[]; blockReason: string | null; attention?: string | null };
/**
 * `order` holds the IDs of the tasks that wait to start now, in the order they would start: features in board
 * order, each feature's steps ascending, tasks of one step by task number, then tasks without a feature in the
 * order of their cards in the Ready column, which holds every waiting card in this same order. A queued task is in it, and a scheduled task once its own time has come. Its first entry
 * is the "Queued · next" task. It carries IDs only, at most one per task.
 *
 * `idle` is the queue turned off (the default); `running` is on. `blocked` names in `blockedBy` the task that
 * holds it (Stalled or Blocked by agent; a task that needs review never holds the queue). `paused` names in `blockedBy` the task whose start
 * did not succeed, with the fixed `pauseReason`; `pauseReason` is null in every other status.
 */
export type TaskQueue = {
  status: TaskQueueStatus;
  blockedBy: string | null;
  pauseReason: TaskQueuePauseReason | null;
  order: string[];
  /** The queue's own start and stop times. Absent when neither is set, and from an older monitor. */
  schedule?: TaskQueueSchedule;
  /** The start gates as the monitor last judged them. Absent from a board that is not ready and from an older monitor. */
  gates?: TaskGates;
};

/**
 * The queue starts nothing before `startAt` and nothing from `stopAfter` on; each is an instant or null for not set.
 * Both are one-time instants, not daily times, and a time that has passed stays as stored until the user changes it.
 * Neither ever stops a running session, and a start the user makes by hand is not held by them.
 */
export type TaskQueueSchedule = { startAt: string | null; stopAfter: string | null };

/** The usage a provider may have reached, in percent of its five-hour window, before no new session starts on it. */
export type TaskGateThreshold = 70 | 85 | 95;
/** `unknown` is missing, stale, or partial evidence. It holds a start like a failed gate and never counts as passed. */
export type TaskGateUsageStatus = "ok" | "over" | "unknown";
export type TaskGateProviderStatus = "ok" | "incident" | "unknown";
export type TaskGateWorkingTree = "clean" | "dirty" | "unknown";
/**
 * Why a start is held. Fixed values only; never a path, a command, or error text. The last two are the queue's own
 * schedule: its start time has not come, or its stop time has.
 */
export type TaskGateReason = "previous_step" | "usage_over" | "usage_unknown" | "provider_incident" | "provider_status_unknown" | "tree_dirty" | "tree_unknown"
  | "before_queue_start" | "after_queue_stop";
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
  /** The task's own start time while its state is `scheduled`: it is not started before it, by the queue or by hand. */
  scheduledAt: string | null;
  session: TaskSession | null; // borrowed from observation; never transcript content
  source: TaskSource | null;
  /** The task's images, at most four, in the order they were attached. Absent from an older monitor, which means none. */
  images?: TaskImage[];
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
  featuresPerRepository: 50,
  textLength: 4000,
  ownConditionLength: 500,
  featureNameLength: 80,
  blockReasonLength: 200,
  modelIdentifierLength: 120,
  imagesPerTask: 4,
  imageBytes: 5 * 1024 * 1024,
} as const;

export const TASK_IMAGE_TYPES: readonly TaskImageType[] = ["png", "jpeg", "gif", "webp"];

/**
 * Where an image sits in a task's text: `[image:<image ID>]`, ordinary task text that names one of `Task.images`.
 * The Task field draws the image in its place; every other surface shows the plain word (`plainTaskText`).
 */
export const TASK_IMAGE_ID_PATTERN = /^img-[0-9a-f]{12}$/u;
const TASK_IMAGE_MARKER = /\[image:(img-[0-9a-f]{12})\]/gu;
export const taskImageMarker = (imageId: string) => `[image:${imageId}]`;

/** The image IDs a task text names, once each, in the order they first appear. */
export function taskImageIds(text: string): string[] {
  return [...new Set([...text.matchAll(TASK_IMAGE_MARKER)].map((match) => match[1]))];
}

/** Task text split into its plain runs and its image markers, in order. */
export function taskTextParts(text: string): ({ text: string } | { imageId: string })[] {
  const parts: ({ text: string } | { imageId: string })[] = [];
  let at = 0;
  for (const match of text.matchAll(TASK_IMAGE_MARKER)) {
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ imageId: match[1] });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Task text for a surface that draws no image (a card, the search, a session's Task tab): a marker reads `[image]`. */
export function plainTaskText(text: string): string {
  return text.replace(TASK_IMAGE_MARKER, "[image]");
}

export const TASK_CHECKS: readonly TaskCheck[] = ["pr_open", "tree_clean", "commit_on_branch", "pr_merged", "ci_passed"];
export const TASK_STATES: readonly TaskState[] = ["not_queued", "queued", "scheduled", "needs_review", "stalled", "blocked", "done"];
export const TASK_PROVIDERS: readonly TaskProvider[] = ["claude", "codex"];
export const TASK_EFFORTS: readonly TaskEffort[] = ["low", "medium", "high", "xhigh"];
export const TASK_QUEUE_STATUSES: readonly TaskQueueStatus[] = ["idle", "running", "blocked", "paused"];
export const TASK_QUEUE_PAUSE_REASONS: readonly TaskQueuePauseReason[] = ["cli_missing", "plugin_missing", "unsupported_platform", "start_failed", "session_not_linked", "worktree_dirty"];
export const TASK_GATE_THRESHOLDS: readonly TaskGateThreshold[] = [70, 85, 95];
export const DEFAULT_TASK_GATE_THRESHOLD: TaskGateThreshold = 85;
export const TASK_GATE_REASONS: readonly TaskGateReason[] = ["previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown", "before_queue_start", "after_queue_stop"];
/** A start or stop time the user sets may lie at most this far ahead. */
export const TASK_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
export const TASK_ACTION_ERRORS: readonly TaskActionError[] = ["invalid", "not_found", "limit", "conflict", "unsupported"];
/** The five fixed columns of every board, in this order; none can be added, renamed, reordered, or removed. */
export const DEFAULT_TASK_COLUMNS: readonly string[] = ["Backlog", "Ready", "In progress", "Review", "Done"];
export const TASK_COLUMN_ROLES: readonly TaskColumnRole[] = ["in_progress", "review", "done"];
/** The roles the default columns are seeded with, in the order of `DEFAULT_TASK_COLUMNS`. */
export const DEFAULT_TASK_COLUMN_ROLES: readonly (TaskColumnRole | null)[] = [null, null, "in_progress", "review", "done"];

/** A board with no content, for loading, unavailable, and desktop-only answers. */
export function createEmptyTaskBoard(repositoryId: string, readiness: TaskBoardReadiness): TaskBoard {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] } };
}
