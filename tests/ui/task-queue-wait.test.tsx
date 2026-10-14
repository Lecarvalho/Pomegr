import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskGates, TaskQueue, TaskQueueWait, TaskQueueWaitReason } from "../../shared/task-contract";
import { TASK_QUEUE_WAIT_REASONS } from "../../shared/task-contract";
import { parseTaskBoard } from "../../app/tasks-store";
import { NO_KNOWN_HOLD, ordinal, waitCardLine, waitDetail } from "../../app/components/tasks/task-wait-model";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", async (original) => ({ ...(await original<typeof import("../../app/tasks-store")>()), useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
const FEATURE = "feat-0123456789ab";
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const setBridge = (bridge: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; };

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-2", position: id, featureId: null, step: null,
    run: { provider: "claude", model: null, effort: "medium" }, completeWhen: { checks: [], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const because = (reason: TaskQueueWaitReason, taskIds: string[] = [], more = 0) => ({ reason, taskIds, more });
const gates: TaskGates = {
  threshold: 85,
  usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 31 }, codex: { status: "ok", fiveHourPercent: 18, sevenDayPercent: 9 } },
  providerStatus: { claude: "ok", codex: "ok" }, workingTree: "unknown", next: null,
};
const queueOf = (waits: TaskQueueWait[], overrides: Partial<TaskQueue> = {}): TaskQueue =>
  ({ status: "running", blockedBy: null, pauseReason: null, order: [], gates, waits, ...overrides });

/** The example: the single task T-63 sits at the top of Ready, and the feature work T-66 to T-69 starts before it. */
const single = task(63, "Tidy the settings copy", { position: 0 });
const featureTasks = [66, 67, 68, 69].map((id, index) => task(id, `Queue controls ${id}`, { featureId: FEATURE, step: Math.max(1, index), position: index + 1 }));
const exampleWaits: TaskQueueWait[] = [
  { taskId: "T-63", place: 5, reasons: [because("feature_first", ["T-66", "T-67", "T-68", "T-69"])] },
  { taskId: "T-66", place: 1, reasons: [] },
  { taskId: "T-67", place: 2, reasons: [] },
  { taskId: "T-68", place: 3, reasons: [because("previous_step", ["T-66"])] },
  { taskId: "T-69", place: 4, reasons: [because("previous_step", ["T-66"])] },
];
function setBoard(queue: TaskQueue, tasks: Task[] = [single, ...featureTasks]) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [{ id: FEATURE, name: "Queue controls", done: false }], tasks, queue };
  useTasks.mockReturnValue({ board, refresh: vi.fn(async () => {}) });
}

beforeEach(() => { setBridge({ taskAction: vi.fn(async () => ({ ok: true })) }); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

const cardText = (id: string) => document.querySelector(`[data-task-id="${id}"] .taskCardWaiting`)?.textContent ?? null;

describe("the Waiting line of a card in Ready", () => {
  it("says why the single task at the top of Ready is not next", () => {
    setBoard(queueOf(exampleWaits, { order: ["T-66", "T-67", "T-68", "T-69", "T-63"] }));
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(cardText("T-63")).toBe("5th in queue · Waiting: feature tasks start first (T-66, T-67, T-68 and 1 more)");
    // The next task has no hold, so its chip alone says it is next; its step-mate shows only its place.
    expect(cardText("T-66")).toBeNull();
    expect(cardText("T-67")).toBe("2nd in queue");
    expect(cardText("T-68")).toBe("3rd in queue · Waiting: step before it is not done (T-66)");
  });

  it("words a held start, a queue that is off or paused, scheduled work, and missing facts", () => {
    const line = (reasons: TaskQueueWait["reasons"], place: number | null = 1, queue: Partial<TaskQueue> = {}) =>
      waitCardLine(queueOf([{ taskId: "T-63", place, reasons }], queue), single);
    expect(line([because("usage_over"), because("tree_unknown")])).toBe("Waiting: Claude Code is above 85% of the five-hour window; the working tree state is not known yet");
    expect(line([because("queue_off")])).toBe("Waiting: the queue is off");
    expect(line([because("queue_paused", ["T-3"]), because("earlier_tasks", ["T-3"])], 2)).toBe("2nd in queue · Waiting: the queue is paused at T-3; earlier tasks start first (T-3)");
    expect(line([because("queue_blocked", ["T-2"])])).toBe("Waiting: the queue is blocked by T-2");
    expect(line([because("queue_blocked")])).toBe("Waiting: the queue is blocked");
    expect(line([because("running_work", ["T-5"])])).toBe("Waiting: T-5 is running");
    expect(line([because("running_work", ["T-5", "T-6"])])).toBe("Waiting: T-5, T-6 are running");
    expect(line([because("before_queue_start")], 1, { schedule: { startAt: null, stopAfter: null } })).toBe("Waiting: the queue's start time has not come");
    expect(line([because("unknown")])).toBe("Waiting: the reason is not known yet");
    // The Starts line already says a task's own time, so the card repeats only what else holds it.
    expect(line([because("own_schedule")], null)).toBeNull();
    expect(line([because("queue_off"), because("own_schedule")], null)).toBe("Waiting: the queue is off");
    // Without the gate readings a usage hold names no threshold.
    expect(line([because("usage_over")], 1, { gates: undefined })).toBe("Waiting: Claude Code is above its usage threshold");
  });

  it("keeps the gate line of the next task when the monitor sends no waits, and draws nothing for a task with no wait", () => {
    const next: TaskGates = { ...gates, next: { taskId: "T-63", provider: "claude", blockedBy: null, reasons: ["tree_dirty"] } };
    expect(waitCardLine({ ...queueOf([]), waits: undefined, gates: next }, single)).toBe("Waiting: the working tree has uncommitted changes");
    expect(waitCardLine(queueOf(exampleWaits), task(70, "Not listed"))).toBeNull();
  });
});

describe("the Queue block of the task modal", () => {
  const detail = (reasons: TaskQueueWait["reasons"], place: number | null = 1, queue: Partial<TaskQueue> = {}) =>
    waitDetail(queueOf([{ taskId: "T-63", place, reasons }], queue), single);

  it("explains the example in the open task", async () => {
    setBoard(queueOf(exampleWaits, { order: ["T-66", "T-67", "T-68", "T-69", "T-63"] }));
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: "Tidy the settings copy" }));
    const block = within(within(screen.getByRole("dialog", { name: "Task" })).getByRole("group", { name: "Queue" }));
    expect(block.getByText("5th to start")).toBeTruthy();
    expect(block.getByText("Feature tasks start before single tasks, wherever the card is in Ready: T-66, T-67, T-68, T-69.")).toBeTruthy();
  });

  it("draws no block for a task that does not wait", async () => {
    setBoard(queueOf(exampleWaits), [task(70, "Draft the notes", { state: "not_queued", columnId: "col-1" }), single, ...featureTasks]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: "Draft the notes" }));
    expect(within(screen.getByRole("dialog", { name: "Task" })).queryByRole("group", { name: "Queue" })).toBeNull();
  });

  it("words the place and one line for each reason", () => {
    expect(detail([because("queue_off")])).toEqual({ place: "Next to start", lines: ["The queue is off, so Pomegr starts no task by itself."] });
    expect(detail([because("queue_blocked", ["T-2"])])?.lines).toEqual(["The queue is blocked by T-2. Nothing starts until that task is resolved."]);
    expect(detail([because("queue_paused", ["T-3"])])?.lines).toEqual(["The queue is paused at T-3. Select On to retry."]);
    expect(detail([because("own_schedule")], null)).toEqual({ place: "Not in the start order yet", lines: ["Its own start time has not come."] });
    expect(detail([because("previous_step", ["T-12"]), because("earlier_tasks", ["T-3", "T-4"], 2)], 4)).toEqual({
      place: "4th to start", lines: ["An earlier step of its feature is not done: T-12.", "These start first: T-3, T-4 and 2 more."],
    });
    expect(detail([because("running_work", ["T-5"])])?.lines).toEqual(["T-5 is running. The queue starts one step at a time."]);
    expect(detail([because("usage_over"), because("provider_status_unknown"), because("tree_unknown")])?.lines).toEqual([
      "Start gate: Claude Code is above 85% of the five-hour window.", "Start gate: Claude Code status is not known yet.", "Start gate: the working tree state is not known yet.",
    ]);
    expect(detail([because("after_queue_stop")])?.lines).toEqual(["Schedule: the queue's stop time has passed."]);
  });

  it("never reads a missing reason as a passed gate", () => {
    expect(detail([because("unknown")])?.lines).toEqual(["The reason is not known yet."]);
    expect(detail([])?.lines).toEqual([NO_KNOWN_HOLD]);
    expect(NO_KNOWN_HOLD).not.toMatch(/pass/iu);
    expect(waitDetail(undefined, single)).toBeNull();
    expect(waitDetail(queueOf([]), single)).toBeNull();
  });

  it("has words for every reason of the contract", () => {
    for (const reason of TASK_QUEUE_WAIT_REASONS) {
      expect(detail([because(reason, ["T-1"])])?.lines[0]).toMatch(/\.$/u);
      if (reason !== "own_schedule") expect(waitCardLine(queueOf([{ taskId: "T-63", place: 1, reasons: [because(reason, ["T-1"])] }]), single)).toMatch(/^Waiting: /u);
    }
  });
});

describe("ordinal", () => {
  it("names a place", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
  });
});

describe("parseTaskBoard", () => {
  const body = (waits: unknown) => ({
    version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [single],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-63"], waits },
  });

  it("keeps valid waits and drops them whole when one value is outside the contract", () => {
    const valid = [{ taskId: "T-63", place: 1, reasons: [because("queue_off"), because("feature_first", ["T-66"], 2)] }, { taskId: "T-7", place: null, reasons: [] }];
    expect(parseTaskBoard(body(valid), repositoryId)?.queue.waits).toEqual(valid);
    expect(parseTaskBoard(body(valid.map((wait) => ({ ...wait, text: "secret" }))), repositoryId)?.queue.waits).toEqual(valid);
    for (const broken of [
      undefined, [], "waits",
      [{ ...valid[0], taskId: "63" }],
      [{ ...valid[0], place: 0 }],
      [{ ...valid[0], reasons: [because("git status failed" as TaskQueueWaitReason)] }],
      [{ ...valid[0], reasons: [because("feature_first", ["C:/secret"])] }],
      [{ ...valid[0], reasons: [because("feature_first", Array.from({ length: 9 }, (_, index) => `T-${index + 1}`))] }],
      [{ ...valid[0], reasons: [because("feature_first", ["T-1"], -1)] }],
    ]) {
      const board = parseTaskBoard(body(broken), repositoryId);
      expect(board?.readiness).toBe("ready");
      expect(board?.queue.waits).toBeUndefined();
    }
  });
});
