import { vi } from "vitest";
import type { Task, TaskBoard, TaskGates } from "../../shared/task-contract";
import type { TaskBoardEdits } from "../../app/components/tasks/use-task-board-edits";

/** Shared by the parallel-group tests: one board with two groups, a started sibling, and a card that does not wait. */
export const GROUP_A = "grp-aaaaaaaaaaaa";
export const GROUP_B = "grp-bbbbbbbbbbbb";
export const repositoryId = "repo-0123456789abcdef01234567";

export const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position, role: null }));
export const features = [{ id: "f1", name: "Tasks adjustments", done: false }, { id: "f2", name: "Aril chat polish", done: false }];
export const running = { id: "claude:s", title: null, state: "working", observedModel: null } as NonNullable<Task["session"]>;

export function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task ${id}`, columnId: "col-2", position: id, featureId: null, group: null,
    run: { provider: "claude", model: "model-large", effort: "high" }, completeWhen: { checks: ["pr_open"], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/** The Ready lane of the board below from top to bottom. */
export const READY = ["T-1", "T-2", "T-4", "T-5", "T-7", "T-6", "T-8", "T-9"];

/**
 * Ready, top to bottom: group A (T-1 of f1, T-2 of f2) with its sibling T-3 already In progress, the single cards T-4
 * and T-5, T-7 (not queued), the single card T-6, then group B (T-8, T-9). T-10 is Done.
 */
export const tasks = (): Task[] => [
  task(1, { featureId: "f1", group: GROUP_A, position: 0 }),
  task(2, { featureId: "f2", group: GROUP_A, position: 1 }),
  task(4, { featureId: "f1", position: 2 }),
  task(5, { position: 3 }),
  task(7, { state: "not_queued", position: 4 }),
  task(6, { position: 5 }),
  task(8, { group: GROUP_B, position: 6 }),
  task(9, { group: GROUP_B, position: 7 }),
  task(3, { featureId: "f1", group: GROUP_A, columnId: "col-3", position: 0, session: running }),
  task(10, { columnId: "col-5", position: 0, state: "done" }),
];

export const gates = (next: TaskGates["next"], overrides: Partial<TaskGates> = {}): TaskGates => ({
  threshold: 85,
  usage: { claude: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 } },
  providerStatus: { claude: "ok", codex: "ok" }, workingTree: "clean", next, ...overrides,
});

export function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns, features, tasks: tasks(),
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-1", "T-2", "T-4", "T-5", "T-6", "T-8", "T-9"] }, ...overrides,
  };
}

/** The board with its Ready lane in `ids` order (a card not named keeps its place after the named ones). */
export function withReady(ids: readonly string[]): TaskBoard {
  const value = board();
  return { ...value, tasks: value.tasks.map((item) => ids.includes(item.id) ? { ...item, position: ids.indexOf(item.id) } : item) };
}

/** Edits whose actions are spies that answer true. */
export function edits(value: TaskBoard): TaskBoardEdits {
  return {
    board: value, failure: null, busy: false, settled: 0,
    moveTask: vi.fn(async () => true), groupTasks: vi.fn(async () => true), ungroupTasks: vi.fn(async () => true), queueGroup: vi.fn(async () => true),
    setQueue: vi.fn(async () => true), setGateThreshold: vi.fn(async () => true), setQueueSchedule: vi.fn(async () => true), resolveTask: vi.fn(async () => true),
  };
}
