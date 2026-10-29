import { DEFAULT_TASK_COLUMN_ROLES, createEmptyTaskBoard, type Task, type TaskBoard, type TaskGates, type TaskQueue, type TaskQueueWait } from "../../../shared/task-contract";
import type { TaskBoardEdits } from "../tasks/use-task-board-edits";

// Synthetic task-board data shared by the task samples on /design-system.

export const SAMPLE_REPOSITORY_ID = "repo-0123456789abcdef01234567";
export const SAMPLE_FEATURE_ID = "feature-upload";
export const SAMPLE_GROUP_ID = "grp-0123456789ab";
const CREATED = "2026-10-08T09:00:00.000Z";
export const SAMPLE_FUTURE = "2099-01-01T02:00:00.000Z";
export const SAMPLE_FUTURE_STOP = "2099-01-01T18:00:00.000Z";

const COLUMNS = [["col-backlog", "Backlog"], ["col-ready", "Ready"], ["col-progress", "In progress"], ["col-review", "Review"], ["col-done", "Done"]]
  .map(([id, name], position) => ({ id, name, position, role: DEFAULT_TASK_COLUMN_ROLES[position] ?? null }));
const FEATURES = [{ id: SAMPLE_FEATURE_ID, name: "Upload reliability", done: false }, { id: "feature-cleanup", name: "Client cleanup", done: false }];
const NO_RUN = { provider: null, model: null, effort: null } as const;

export function sampleTask(id: string, text: string, overrides: Partial<Task> = {}): Task {
  return { review: null,
    id, text, columnId: "col-ready", position: 0, featureId: null, group: null, run: NO_RUN, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null, createdAt: CREATED, updatedAt: CREATED, ...overrides,
  };
}

const session = (id: string, title: string, state: string, observedModel: string | null = "model-large") => ({ id: `claude:design-system-${id}`, title, state, observedModel, observedEffort: null });
const passed = [{ check: "pr_open" as const, passed: true }, { check: "tree_clean" as const, passed: true }];

export const T1_DONE = sampleTask("T-1", "Add retry to the upload client", {
  columnId: "col-done", featureId: SAMPLE_FEATURE_ID, state: "done", run: { provider: "claude", model: "model-large", effort: "high" },
  completeWhen: { checks: ["pr_open", "tree_clean"], own: null }, session: session("t1", "Upload retry", "closed"), report: { at: CREATED, results: passed, blockReason: null },
});
const T2_QUEUED = sampleTask("T-2", "Back off between upload retries", {
  featureId: SAMPLE_FEATURE_ID, group: SAMPLE_GROUP_ID, state: "queued", run: { provider: "claude", model: "model-large", effort: "medium" }, completeWhen: { checks: ["pr_open", "ci_passed"], own: "Retries stop after five attempts." },
});
export const T2_REVIEW = { ...T2_QUEUED, group: null, columnId: "col-review", state: "needs_review", session: session("t2", "Retry back-off", "closed"),
  report: { at: CREATED, results: [{ check: "pr_open", passed: true }, { check: "ci_passed", passed: false }], blockReason: null } } satisfies Task;
export const T2_STALLED = { ...T2_REVIEW, state: "stalled", report: null } satisfies Task;
export const T2_BLOCKED = { ...T2_REVIEW, state: "blocked", report: { at: CREATED, results: [], blockReason: "The upload service rejects every retry in the test environment." } } satisfies Task;
const T2_BLOCKED_IN_PROGRESS = { ...T2_BLOCKED, columnId: "col-progress" } satisfies Task;
export const T3_QUEUED = sampleTask("T-3", "Show the retry count in the upload log", {
  featureId: "feature-cleanup", group: SAMPLE_GROUP_ID, state: "queued", run: { provider: "codex", model: "model-code", effort: "medium" }, completeWhen: { checks: ["pr_open"], own: null },
});
export const T4_QUEUED = sampleTask("T-4", "Document the retry settings", { featureId: SAMPLE_FEATURE_ID, state: "queued", run: { provider: "claude", model: null, effort: null } });
export const T5_IDLE = sampleTask("T-5", "Remove the unused upload helper", { columnId: "col-backlog", featureId: "feature-cleanup" });
export const T6_WORKING = sampleTask("T-6", "Check the cache headers", {
  columnId: "col-progress", state: "queued", run: { provider: "claude", model: "model-large", effort: "high" }, completeWhen: { checks: ["tree_clean"], own: null },
  session: session("t6", "Cache header check", "working", "model-small"),
});
export const T7_SCHEDULED = sampleTask("T-7", "Rotate the sample logs nightly", { state: "scheduled", scheduledAt: SAMPLE_FUTURE, run: { provider: "codex", model: null, effort: null } });
export const T8_IDLE = sampleTask("T-8", "Rename the config key", { columnId: "col-backlog" });
export const T11_LONG = sampleTask("T-11", "Show a row in the upload log when a job calls `retry_upload`. Today the log adds a row for `start_upload` and `cancel_upload` only, so a reader cannot see a retry.\n\n- Map `retry_upload` to a new `retried` action.\n- Cover it with a test.", { columnId: "col-backlog" });
export const T9_ISSUE = sampleTask("T-10", "Retry a failed upload from the queue", { columnId: "col-backlog", source: { kind: "github_issue", number: 142 } });
// Tags are the bracket words at the start of the first line: the card draws them as chips and leaves them out of the title.
export const T17_TAGGED = sampleTask("T-17", "[ frontend ] [ tech-debt ] Make plan-intent consume atomic across browser tabs", { columnId: "col-backlog", featureId: "feature-cleanup" });
// A card of Ready that is planned but not queued: the lane does not say it, so its chip stays.
export const T18_PLANNED = sampleTask("T-18", "Review the export wording", { run: { provider: "claude", model: "model-small", effort: "medium" } });
// The bound session waits for the owner: the amber border and the Needs input chip.
export const T19_NEEDS_INPUT = { ...T6_WORKING, id: "T-19", session: session("t19", "Cache header check", "needs_input", "model-large") } satisfies Task;

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
  ...GATES_OPEN, providerStatus: { claude: "incident", codex: "ok" }, workingTree: "dirty", next: { taskId: "T-3", provider: "codex", blockedBy: "T-2", reasons: ["earlier_task", "provider_incident", "tree_dirty"] },
};

// Why each waiting card of the running board has not started: a held gate, a place only, an earlier step, and its own time.
export const WAITS_RUNNING: TaskQueueWait[] = [
  { taskId: "T-2", place: 1, reasons: [{ reason: "usage_over", taskIds: [], more: 0 }] },
  { taskId: "T-3", place: 2, reasons: [] },
  { taskId: "T-4", place: 3, reasons: [{ reason: "earlier_tasks", taskIds: ["T-2", "T-3"], more: 0 }] },
  { taskId: "T-7", place: null, reasons: [{ reason: "own_schedule", taskIds: [], more: 0 }] },
];
export const QUEUE_RUNNING: TaskQueue = { status: "running", blockedBy: null, pauseReason: null, order: ["T-2", "T-3", "T-4"], gates: GATES_HELD, waits: WAITS_RUNNING };
export const QUEUE_BLOCKED: TaskQueue = { status: "blocked", blockedBy: "T-2", pauseReason: null, order: ["T-3", "T-4"], gates: GATES_OPEN };
export const QUEUE_PAUSED: TaskQueue = { status: "paused", blockedBy: "T-3", pauseReason: "cli_missing", order: ["T-3", "T-4"], gates: GATES_OPEN };
export const QUEUE_IDLE: TaskQueue = { status: "idle", blockedBy: null, pauseReason: null, order: [], gates: GATES_OPEN };

const base: Omit<TaskBoard, "tasks" | "queue"> = { version: 1, readiness: "ready", repositoryId: SAMPLE_REPOSITORY_ID, columns: COLUMNS, features: FEATURES, runModels: { codex: [] } };
const place = (tasks: Task[]) => tasks.map((task, index) => ({ ...task, position: index }));

export const BOARD_RUNNING: TaskBoard = { ...base, queue: QUEUE_RUNNING, tasks: place([T1_DONE, T2_QUEUED, T3_QUEUED, T4_QUEUED, T5_IDLE, T6_WORKING, T7_SCHEDULED, T8_IDLE]) };
export const BOARD_BLOCKED: TaskBoard = { ...BOARD_RUNNING, queue: QUEUE_BLOCKED, tasks: place([T1_DONE, T2_BLOCKED_IN_PROGRESS, { ...T3_QUEUED, group: null }, T4_QUEUED, T5_IDLE, T6_WORKING, T7_SCHEDULED, T8_IDLE]) };
// A group whose Codex member started while its Claude Code member is held by a start gate.
const T3_STARTED = { ...T3_QUEUED, columnId: "col-progress", session: session("t3", "Retry count in the log", "working", "model-code") } satisfies Task;
export const BOARD_HELD_MEMBER: TaskBoard = { ...BOARD_RUNNING, queue: { ...QUEUE_RUNNING, order: ["T-2", "T-4"] }, tasks: place([T1_DONE, T2_QUEUED, T3_STARTED, T4_QUEUED, T5_IDLE, T7_SCHEDULED, T8_IDLE]) };
export const BOARD_PAUSED: TaskBoard = { ...BOARD_RUNNING, queue: QUEUE_PAUSED };
export const BOARD_EMPTY: TaskBoard = { ...createEmptyTaskBoard(SAMPLE_REPOSITORY_ID, "ready"), columns: COLUMNS };

export function inertEdits(board: TaskBoard): TaskBoardEdits {
  const none = async () => false;
  return {
    board, failure: null, busy: false, settled: 0, doneAsk: null, moveTask: none,
    groupTasks: none, ungroupTasks: none, queueGroup: none, setQueue: none, setGateThreshold: none, setQueueSchedule: none, resolveTask: none,
  };
}

// Planning before Ready: a parallel group of cards that are not queued yet, in Backlog, and tasks that run after others.
export const SAMPLE_PLAN_GROUP_ID = "grp-abcdef012345";
const P12 = sampleTask("T-12", "Add the export schema", { columnId: "col-backlog", run: { provider: "claude", model: "model-large", effort: "medium" } });
const P13 = sampleTask("T-13", "Export to CSV", { columnId: "col-backlog", group: SAMPLE_PLAN_GROUP_ID, run: { provider: "claude", model: "model-small", effort: "medium" } });
const P14 = sampleTask("T-14", "Export to JSON", { columnId: "col-backlog", group: SAMPLE_PLAN_GROUP_ID, run: { provider: "codex", model: null, effort: "medium" } });
export const P15_AFTER = sampleTask("T-15", "Document the export formats", { columnId: "col-backlog", after: ["T-13", "T-14"], run: { provider: "claude", model: "model-small", effort: "low" } });
const P16 = sampleTask("T-16", "Tidy the settings copy", { columnId: "col-backlog" });
const P21 = sampleTask("T-21", "Write the new parser", { columnId: "col-progress", state: "queued", run: { provider: "claude", model: "model-large", effort: "high" }, session: session("t21", "New parser", "working") });
export const P9_WAITING = sampleTask("T-9", "Switch the importer to the new parser", { state: "queued", after: ["T-21"], run: { provider: "claude", model: "model-large", effort: "high" } });
const P10 = sampleTask("T-10", "Fix the date filter", { state: "queued", run: { provider: "claude", model: "model-small", effort: "medium" } });
const WAITS_PLAN: TaskQueueWait[] = [
  { taskId: "T-9", place: null, reasons: [{ reason: "runs_after", taskIds: ["T-21"], more: 0 }] },
  { taskId: "T-10", place: 1, reasons: [{ reason: "running_work", taskIds: ["T-21"], more: 0 }] },
];
export const BOARD_PLAN: TaskBoard = {
  ...base, features: [], queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-10"], gates: GATES_OPEN, waits: WAITS_PLAN },
  tasks: [...place([P12, P13, P14, P15_AFTER, P16]), ...place([P9_WAITING, P10]), { ...P21, position: 0 }],
};
