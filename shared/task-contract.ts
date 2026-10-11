// Per-repository task board served from the monitor's private task store.

export type TaskCheck = "pr_open" | "tree_clean" | "commit_on_branch" | "pr_merged" | "ci_passed";
export type TaskState = "not_queued" | "queued" | "scheduled" | "needs_review" | "stalled" | "blocked" | "done";
export type TaskProvider = "claude" | "codex";
export type TaskEffort = "low" | "medium" | "high" | "xhigh";
export type TaskBoardReadiness = "ready" | "loading" | "unavailable" | "desktop_only";
export type TaskQueueStatus = "idle" | "running" | "blocked" | "paused";
// Why a queue is paused: a start the queue made did not succeed.
export type TaskQueuePauseReason = "cli_missing" | "plugin_missing" | "unsupported_platform" | "start_failed" | "session_not_linked" | "worktree_dirty";
export type TaskActionError = "invalid" | "not_found" | "limit" | "conflict" | "unsupported";

export type TaskColumnRole = "in_progress" | "review" | "done";
export type TaskColumn = { id: string; name: string; position: number; role?: TaskColumnRole | null };
export type TaskFeature = { id: string; name: string; done: boolean };
export type TaskRun = { provider: TaskProvider | null; model: string | null; effort: TaskEffort | null; remoteControl?: boolean };
export type TaskSession = { id: string; title: string | null; state: string; observedModel: string | null; checks?: { check: TaskCheck; passed: boolean }[] };
export type TaskSource = { kind: "github_issue"; number: number };
// The image formats a task may hold.
export type TaskImageType = "png" | "jpeg" | "gif" | "webp";
// One image attached to a task: an opaque ID, its fixed type, and its size in bytes.
export type TaskImage = { id: string; type: TaskImageType; bytes: number };
export type TaskReport = { at: string; results: { check: TaskCheck; passed: boolean }[]; blockReason: string | null; attention?: string | null };
export type TaskQueue = {
  status: TaskQueueStatus;
  blockedBy: string | null;
  pauseReason: TaskQueuePauseReason | null;
  order: string[];
  schedule?: TaskQueueSchedule;
  // The start gates as the monitor last judged them.
  gates?: TaskGates;
};

export type TaskQueueSchedule = { startAt: string | null; stopAfter: string | null };

// The usage a provider may have reached, in percent of its five-hour window, before no new session starts on it.
export type TaskGateThreshold = 70 | 85 | 95;
// `unknown` is missing, stale, or partial evidence.
export type TaskGateUsageStatus = "ok" | "over" | "unknown";
export type TaskGateProviderStatus = "ok" | "incident" | "unknown";
export type TaskGateWorkingTree = "clean" | "dirty" | "unknown";
// Why a start is held.
export type TaskGateReason = "previous_step" | "usage_over" | "usage_unknown" | "provider_incident" | "provider_status_unknown" | "tree_dirty" | "tree_unknown"
  | "before_queue_start" | "after_queue_stop";
export type TaskGateUsage = { status: TaskGateUsageStatus; fiveHourPercent: number | null; sevenDayPercent: number | null };
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
  completeWhen: { checks: TaskCheck[]; own: string | null };
  state: TaskState;
  scheduledAt: string | null;
  session: TaskSession | null; // borrowed from observation; never transcript content
  source: TaskSource | null;
  images?: TaskImage[];
  report: TaskReport | null;
  createdAt: string;
  updatedAt: string;
};

export type TaskBoard = {
  version: 1;
  readiness: TaskBoardReadiness;
  repositoryId: string;
  columns: TaskColumn[];
  features: TaskFeature[];
  tasks: Task[];
  queue: TaskQueue;
  // Last committed Codex client-catalog models for the Run on list; never entitlement.
  runModels?: TaskRunModels;
};

export type TaskRunModels = { codex: { id: string; label: string | null }[] };

export const TASK_REPOSITORY_ID_PATTERN = /^repo-[a-f0-9]{24}$/u;
export const TASK_ID_PATTERN = /^T-[1-9][0-9]{0,8}$/u;

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

export const TASK_IMAGE_ID_PATTERN = /^img-[0-9a-f]{12}$/u;
const TASK_IMAGE_MARKER = /\[image:(img-[0-9a-f]{12})\]/gu;
export const taskImageMarker = (imageId: string) => `[image:${imageId}]`;

export function taskImageIds(text: string): string[] {
  return [...new Set([...text.matchAll(TASK_IMAGE_MARKER)].map((match) => match[1]))];
}

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
export const TASK_SCHEDULE_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
export const TASK_ACTION_ERRORS: readonly TaskActionError[] = ["invalid", "not_found", "limit", "conflict", "unsupported"];
export const DEFAULT_TASK_COLUMNS: readonly string[] = ["Backlog", "Ready", "In progress", "Review", "Done"];
export const TASK_COLUMN_ROLES: readonly TaskColumnRole[] = ["in_progress", "review", "done"];
export const DEFAULT_TASK_COLUMN_ROLES: readonly (TaskColumnRole | null)[] = [null, null, "in_progress", "review", "done"];

// A board with no content, for loading, unavailable, and desktop-only answers.
export function createEmptyTaskBoard(repositoryId: string, readiness: TaskBoardReadiness): TaskBoard {
  return { version: 1, readiness, repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] } };
}
