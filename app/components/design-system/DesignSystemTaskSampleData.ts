import { DEFAULT_TASK_COLUMN_ROLES, createEmptyTaskBoard, type Task, type TaskBoard, type TaskGates, type TaskQueue } from "../../../shared/task-contract";
import type { TaskBoardEdits } from "../tasks/use-task-board-edits";

// Synthetic task-board data shared by the task samples on /design-system. Every value is invented: no repository, path,
// session, or task text comes from the app. Times in the far future never pass, so the samples read the same on any day.

export const SAMPLE_REPOSITORY_ID = "repo-0123456789abcdef01234567";
export const SAMPLE_FEATURE_ID = "feature-upload";
const CREATED = "2026-10-08T09:00:00.000Z";
export const SAMPLE_FUTURE = "2099-01-01T02:00:00.000Z";
export const SAMPLE_FUTURE_STOP = "2099-01-01T18:00:00.000Z";

const COLUMNS = [["col-backlog", "Backlog"], ["col-ready", "Ready"], ["col-progress", "In progress"], ["col-review", "Review"], ["col-done", "Done"]]
  .map(([id, name], position) => ({ id, name, position, role: DEFAULT_TASK_COLUMN_ROLES[position] ?? null }));
const FEATURES = [{ id: SAMPLE_FEATURE_ID, name: "Upload reliability", done: false }, { id: "feature-cleanup", name: "Client cleanup", done: false }];
const NO_RUN = { provider: null, model: null, effort: null } as const;

export function sampleTask(id: string, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id, text, columnId: "col-ready", position: 0, featureId: null, step: null, run: NO_RUN, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null, createdAt: CREATED, updatedAt: CREATED, ...overrides,
  };
}

const session = (id: string, title: string, state: string, observedModel: string | null = "model-large") => ({ id: `claude:design-system-${id}`, title, state, observedModel });
const passed = [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: true }];

// One task per card state. T-2 is the one that changes with the queue: it needs review while the queue is blocked.
export const T1_DONE = sampleTask("T-1", "Add retry to the upload client", {
  columnId: "col-done", featureId: SAMPLE_FEATURE_ID, step: 1, state: "done", run: { provider: "claude", model: "model-large", effort: "high" },
  doneWhen: { checks: ["pr_open", "tree_clean"], own: null }, session: session("t1", "Upload retry", "closed"), report: { at: CREATED, results: passed, blockReason: null },
});
const T2_QUEUED = sampleTask("T-2", "Back off between upload retries", {
  featureId: SAMPLE_FEATURE_ID, step: 2, state: "queued", run: { provider: "claude", model: "model-large", effort: "medium" }, doneWhen: { checks: ["pr_open", "ci_passed"], own: "Retries stop after five attempts." },
});
export const T2_REVIEW = { ...T2_QUEUED, columnId: "col-review", state: "needs_review", session: session("t2", "Retry back-off", "closed"),
  report: { at: CREATED, results: [{ check: "pr_open", passed: true }, { check: "ci_passed", passed: false }], blockReason: null } } satisfies Task;
export const T2_STALLED = { ...T2_REVIEW, state: "stalled", report: null } satisfies Task;
export const T2_BLOCKED = { ...T2_REVIEW, state: "blocked", report: { at: CREATED, results: [], blockReason: "The upload service rejects every retry in the test environment." } } satisfies Task;
export const T3_QUEUED = sampleTask("T-3", "Show the retry count in the upload log", {
  featureId: SAMPLE_FEATURE_ID, step: 2, state: "queued", run: { provider: "codex", model: "model-code", effort: "medium" }, doneWhen: { checks: ["pr_open"], own: null },
});
export const T4_QUEUED = sampleTask("T-4", "Document the retry settings", { featureId: SAMPLE_FEATURE_ID, step: 3, state: "queued", run: { provider: "claude", model: null, effort: null } });
export const T5_IDLE = sampleTask("T-5", "Remove the unused upload helper", { columnId: "col-backlog", featureId: "feature-cleanup", step: 1 });
export const T6_WORKING = sampleTask("T-6", "Check the cache headers", {
  columnId: "col-progress", state: "queued", run: { provider: "claude", model: "model-large", effort: "high" }, doneWhen: { checks: ["tree_clean"], own: null },
  session: session("t6", "Cache header check", "working", "model-small"),
});
export const T7_SCHEDULED = sampleTask("T-7", "Rotate the sample logs nightly", { state: "scheduled", scheduledAt: SAMPLE_FUTURE, run: { provider: "codex", model: null, effort: null } });
export const T8_IDLE = sampleTask("T-8", "Rename the config key", { columnId: "col-backlog" });

export const GATES_HELD: TaskGates = {
  threshold: 85, usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 37 }, codex: { status: "ok", fiveHourPercent: 38, sevenDayPercent: 12 } },
  providerStatus: { claude: "ok", codex: "ok" }, workingTree: "clean", next: { taskId: "T-2", provider: "claude", blockedBy: null, reasons: ["usage_over"] },
};
export const GATES_OPEN: TaskGates = {
  ...GATES_HELD, usage: { claude: { status: "ok", fiveHourPercent: 41, sevenDayPercent: 18 }, codex: { status: "ok", fiveHourPercent: 38, sevenDayPercent: 12 } },
  next: { taskId: "T-2", provider: "claude", blockedBy: null, reasons: [] },
};
export const GATES_UNKNOWN: TaskGates = {
  threshold: 70, usage: { claude: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null }, codex: { status: "unknown", fiveHourPercent: null, sevenDayPercent: null } },
  providerStatus: { claude: "unknown", codex: "unknown" }, workingTree: "unknown", next: null,
};
export const GATES_STOPPED: TaskGates = {
  ...GATES_OPEN, providerStatus: { claude: "incident", codex: "ok" }, workingTree: "dirty", next: { taskId: "T-3", provider: "codex", blockedBy: "T-2", reasons: ["previous_step", "provider_incident", "tree_dirty"] },
};

export const QUEUE_RUNNING: TaskQueue = { status: "running", blockedBy: null, pauseReason: null, order: ["T-2", "T-3", "T-4"], gates: GATES_HELD };
export const QUEUE_BLOCKED: TaskQueue = { status: "blocked", blockedBy: "T-2", pauseReason: null, order: ["T-3", "T-4"], gates: GATES_OPEN };
export const QUEUE_PAUSED: TaskQueue = { status: "paused", blockedBy: "T-3", pauseReason: "cli_missing", order: ["T-3", "T-4"], gates: GATES_OPEN };
export const QUEUE_IDLE: TaskQueue = { status: "idle", blockedBy: null, pauseReason: null, order: [], gates: GATES_OPEN };

const base: Omit<TaskBoard, "tasks" | "queue"> = { version: 1, readiness: "ready", repositoryId: SAMPLE_REPOSITORY_ID, columns: COLUMNS, features: FEATURES, runModels: { codex: [] } };
const place = (tasks: Task[]) => tasks.map((task, index) => ({ ...task, position: index }));

/** The queue is on and the next task waits on a gate. */
export const BOARD_RUNNING: TaskBoard = { ...base, queue: QUEUE_RUNNING, tasks: place([T1_DONE, T2_QUEUED, T3_QUEUED, T4_QUEUED, T5_IDLE, T6_WORKING, T7_SCHEDULED, T8_IDLE]) };
/** A finished task needs review, so the queue is blocked on it. */
export const BOARD_BLOCKED: TaskBoard = { ...BOARD_RUNNING, queue: QUEUE_BLOCKED, tasks: place([T1_DONE, T2_REVIEW, T3_QUEUED, T4_QUEUED, T5_IDLE, T6_WORKING, T7_SCHEDULED, T8_IDLE]) };
export const BOARD_PAUSED: TaskBoard = { ...BOARD_RUNNING, queue: QUEUE_PAUSED };
export const BOARD_EMPTY: TaskBoard = { ...createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "ready"), columns: COLUMNS };

/** The desktop app's board edits with every action answered "no": the controls draw exactly as in the app and change nothing. */
export function inertEdits(board: TaskBoard): TaskBoardEdits {
  const none = async () => false;
  return {
    board, failure: null, busy: false, settled: 0, moveTask: none, addFeature: none,
    reorderQueueTask: none, setQueue: none, setGateThreshold: none, setQueueSchedule: none, resolveTask: none,
  };
}
