import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task, TaskBoard, TaskGateReason, TaskGates, TaskQueueWait } from "../../shared/task-contract";
import { applyMove, cardMove, readyUnits } from "../../app/components/tasks/task-board-model";
import { groupDesktopTasks, moveDesktopTask, ungroupDesktopTasks } from "../../app/components/tasks/task-desktop";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { waitingLine } from "../../app/components/tasks/task-gates-model";
import { waitCardLine } from "../../app/components/tasks/task-wait-model";
import { taskColumns } from "../../app/components/tasks/task-presentation";
import { GROUP_A, GROUP_B, READY, board, gates, repositoryId } from "./task-group-fixtures";

const readyIds = (value: TaskBoard) => taskColumns(value)[1].tasks.map((item) => item.id);
const groupOf = (value: TaskBoard, id: string) => value.tasks.find((item) => item.id === id)?.group;
const groupsOf = (value: TaskBoard) => Object.fromEntries(value.tasks.filter((item) => item.group !== null).map((item) => [item.id, item.group]));

describe("applyMove with a parallel group", () => {
  it("takes the card out of its group with group: leave, wherever it lands", () => {
    const after = applyMove(board(), { id: "T-2", columnId: "col-2", position: 1, group: "leave" });
    expect(groupOf(after, "T-2")).toBeNull();
    expect(groupOf(after, "T-1")).toBe(GROUP_A);
    // T-3 still runs in the group, so the group of T-1 keeps two tasks in the queue.
    expect(groupOf(after, "T-3")).toBe(GROUP_A);
    expect(readyIds(after)).toEqual(READY);
  });

  it("dissolves a group left with one task in the queue", () => {
    const after = applyMove(board(), { id: "T-8", columnId: "col-2", position: 6, group: "leave" });
    expect(groupOf(after, "T-8")).toBeNull();
    expect(groupOf(after, "T-9")).toBeNull();
  });

  it("moves the waiting cards of the group together with group: block, counting after the block leaves", () => {
    const after = applyMove(board(), { id: "T-1", columnId: "col-2", position: 2, group: "block" });
    expect(readyIds(after)).toEqual(["T-4", "T-5", "T-1", "T-2", "T-7", "T-6", "T-8", "T-9"]);
    expect(groupsOf(after)).toEqual(groupsOf(board()));
    const up = applyMove(board(), { id: "T-8", columnId: "col-2", position: 0, group: "block" });
    expect(readyIds(up)).toEqual(["T-8", "T-9", "T-1", "T-2", "T-4", "T-5", "T-7", "T-6"]);
    // The started sibling stays in its own lane.
    expect(taskColumns(after)[2].tasks.map((item) => item.id)).toEqual(["T-3"]);
  });

  it("leaves the group on a plain move away from every sibling", () => {
    const after = applyMove(board(), { id: "T-2", columnId: "col-2", position: 3 });
    expect(readyIds(after)).toEqual(["T-1", "T-4", "T-5", "T-2", "T-7", "T-6", "T-8", "T-9"]);
    expect(groupOf(after, "T-2")).toBeNull();
    expect(groupOf(after, "T-1")).toBe(GROUP_A);
  });

  it("dissolves a group of two when one member lands away from the other", () => {
    const after = applyMove(board(), { id: "T-8", columnId: "col-2", position: 0 });
    expect(groupOf(after, "T-8")).toBeNull();
    expect(groupOf(after, "T-9")).toBeNull();
  });

  it("keeps the group on a plain move beside a sibling, which only reorders the group", () => {
    const after = applyMove(board(), { id: "T-9", columnId: "col-2", position: 6 });
    expect(readyIds(after)).toEqual(["T-1", "T-2", "T-4", "T-5", "T-7", "T-6", "T-9", "T-8"]);
    expect(groupsOf(after)).toEqual(groupsOf(board()));
  });

  it("keeps a group's waiting cards together when another card is dropped between them", () => {
    const after = applyMove(board(), { id: "T-4", columnId: "col-2", position: 1 });
    expect(readyIds(after)).toEqual(["T-1", "T-2", "T-4", "T-5", "T-7", "T-6", "T-8", "T-9"]);
    expect(groupsOf(after)).toEqual(groupsOf(board()));
    const into = applyMove(board(), { id: "T-6", columnId: "col-2", position: 6 });
    // Dropped between T-8 and T-9, the card goes behind the group, which stands where its first card is.
    expect(readyIds(into).slice(5)).toEqual(["T-8", "T-9", "T-6"]);
  });

  it("changes nothing for a move to the place the card holds", () => {
    const value = board();
    expect(applyMove(value, { id: "T-4", columnId: "col-2", position: 2 })).toBe(value);
  });
});

describe("cardMove inside Ready", () => {
  const value = board();
  const position = (id: string, kind: "up" | "down") => cardMove(value, id, kind)?.position ?? null;

  it("steps a single card past a whole group, one place past a single card", () => {
    expect(position("T-4", "up")).toBe(0);
    expect(position("T-4", "down")).toBe(3);
    expect(position("T-6", "down")).toBe(7);
    expect(position("T-6", "up")).toBe(4);
    expect(position("T-5", "down")).toBe(4);
  });

  it("steps a member inside its group, and past the group at its edge", () => {
    expect(position("T-1", "down")).toBe(1);
    expect(position("T-2", "up")).toBe(0);
    expect(position("T-2", "down")).toBe(2);
    expect(position("T-8", "down")).toBe(7);
    expect(position("T-9", "up")).toBe(6);
    expect(position("T-8", "up")).toBe(5);
  });

  it("goes nowhere at the ends of the lane", () => {
    expect(position("T-1", "up")).toBeNull();
    expect(position("T-9", "down")).toBeNull();
  });

  it("carries no group key, and units hold only waiting members of one group together", () => {
    expect(cardMove(value, "T-4", "up")).toEqual({ id: "T-4", columnId: "col-2", position: 0 });
    expect(readyUnits(taskColumns(value)[1].tasks).map((unit) => unit.tasks.map((item) => item.id))).toEqual([["T-1", "T-2"], ["T-4"], ["T-5"], ["T-7"], ["T-6"], ["T-8", "T-9"]]);
  });
});

describe("waitingLine", () => {
  const reasons: TaskGateReason[] = ["earlier_task", "usage_over", "tree_dirty"];
  const queue = (overrides: Parameters<typeof gates>[1] = {}, next: NonNullable<TaskGates["next"]> = { taskId: "T-1", provider: "claude", blockedBy: "T-9", reasons }): TaskBoard["queue"] =>
    ({ status: "running", blockedBy: null, pauseReason: null, order: READY, gates: gates(next, overrides) });
  const over = { usage: { claude: { status: "over" as const, fiveHourPercent: 91, sevenDayPercent: 10 }, codex: { status: "ok" as const, fiveHourPercent: 1, sevenDayPercent: 1 } } };

  it("reads the monitor's reasons on the next task, with the earlier task by number", () => {
    expect(waitingLine(queue(over), "T-1")).toBe("Waiting: T-9 has not finished; Claude Code is above 85% of the five-hour window; the working tree has uncommitted changes");
    const unnamed = { taskId: "T-1", provider: "claude" as const, blockedBy: null, reasons: ["earlier_task" as const] };
    expect(waitingLine(queue({}, unnamed), "T-1")).toBe("Waiting: an earlier task has not finished");
  });

  it("reads nothing for another card, no reasons, or a queue that is not running", () => {
    expect(waitingLine(queue(), "T-2")).toBeNull();
    expect(waitingLine(queue(), "T-8")).toBeNull();
    expect(waitingLine({ ...queue(), status: "paused" }, "T-1")).toBeNull();
    expect(waitingLine({ ...queue(), gates: undefined }, "T-1")).toBeNull();
    expect(GROUP_B).not.toBe(GROUP_A);
  });
});

describe("waitCardLine in a parallel group", () => {
  const wait = (taskId: string, place: number | null, entries: TaskQueueWait["reasons"]): TaskQueueWait => ({ taskId, place, reasons: entries });
  const queue = (waits: TaskQueueWait[]): TaskBoard["queue"] => ({ status: "running", blockedBy: null, pauseReason: null, order: READY, gates: gates(null), waits });
  const byId = (id: string): Task => board().tasks.find((item) => item.id === id) as Task;

  it("reads a member of the running group by its own gate reasons, and its siblings by theirs", () => {
    const waits = [
      wait("T-1", 1, [{ reason: "usage_over", taskIds: [], more: 0 }]),
      wait("T-2", 2, [{ reason: "tree_dirty", taskIds: [], more: 0 }]),
    ];
    expect(waitCardLine(queue(waits), byId("T-1"))).toBe("Waiting: Claude Code is above 85% of the five-hour window");
    expect(waitCardLine(queue(waits), byId("T-2"))).toBe("2nd in queue · Waiting: the working tree has uncommitted changes");
  });

  it("never lists a sibling of its own group as ahead of the card", () => {
    const waits = [wait("T-8", 3, []), wait("T-9", 4, [{ reason: "earlier_tasks", taskIds: ["T-1", "T-2", "T-4"], more: 0 }])];
    expect(waitCardLine(queue(waits), byId("T-8"))).toBe("3rd in queue");
    expect(waitCardLine(queue(waits), byId("T-9"))).toBe("4th in queue · Waiting: earlier tasks start first (T-1, T-2, T-4)");
    expect(waitCardLine(queue(waits), byId("T-9"))).not.toContain("T-8");
  });

  it("reads null for a card with no wait when the monitor sent waits", () => {
    expect(waitCardLine(queue([]), byId("T-6"))).toBeNull();
  });
});

describe("the started suffix of a waiting group card", () => {
  const next = { taskId: "T-1", provider: "claude" as const, blockedBy: null, reasons: ["usage_over" as const] };
  const open = (waits?: TaskQueueWait[]) => board({ queue: { status: "running", blockedBy: null, pauseReason: null, order: READY, waits, gates: gates(next, { usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 10 }, codex: { status: "ok", fiveHourPercent: 1, sevenDayPercent: 1 } } }) } });
  const line = (id: string) => document.querySelector(`[data-task-id="${id}"] .taskCardWaiting`)?.textContent ?? null;

  it("ends a Waiting line with the members that started", () => {
    const waits: TaskQueueWait[] = [
      { taskId: "T-1", place: 1, reasons: [{ reason: "usage_over", taskIds: [], more: 0 }] },
      { taskId: "T-2", place: 2, reasons: [{ reason: "tree_dirty", taskIds: [], more: 0 }] },
      { taskId: "T-4", place: 3, reasons: [{ reason: "earlier_tasks", taskIds: ["T-1", "T-2"], more: 0 }] },
    ];
    render(<TaskBoardView board={open(waits)} />);
    expect(line("T-1")).toBe("Waiting: Claude Code is above 85% of the five-hour window · T-3 started");
    expect(line("T-2")).toBe("2nd in queue · Waiting: the working tree has uncommitted changes · T-3 started");
    // A card outside the group names no started member.
    expect(line("T-4")).toBe("3rd in queue · Waiting: earlier tasks start first (T-1, T-2)");
    expect(line("T-4")).not.toMatch(/started/);
  });

  it("adds no suffix to a card with no Waiting line", () => {
    const waits: TaskQueueWait[] = [{ taskId: "T-1", place: 1, reasons: [] }, { taskId: "T-2", place: 2, reasons: [] }];
    render(<TaskBoardView board={open(waits)} />);
    expect(line("T-1")).toBeNull();
    expect(line("T-2")).toBe("2nd in queue");
  });
});

describe("the group actions of the desktop bridge", () => {
  const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: boolean }>>(async () => ({ ok: true }));
  afterEach(() => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = undefined; vi.clearAllMocks(); });
  const bridge = () => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { taskAction }; };

  it("sends queue_group and queue_ungroup with a copy of the IDs", async () => {
    bridge();
    const ids = ["T-4", "T-5"];
    await expect(groupDesktopTasks(repositoryId, ids)).resolves.toEqual({ ok: true });
    await expect(ungroupDesktopTasks(repositoryId, ["T-1"])).resolves.toEqual({ ok: true });
    expect(taskAction).toHaveBeenNthCalledWith(1, repositoryId, "queue_group", { ids: ["T-4", "T-5"] });
    expect((taskAction.mock.calls[0][2] as { ids: string[] }).ids).not.toBe(ids);
    expect(taskAction).toHaveBeenNthCalledWith(2, repositoryId, "queue_ungroup", { ids: ["T-1"] });
  });

  it("answers the monitor's limit and conflict, and unavailable without a bridge", async () => {
    bridge();
    taskAction.mockResolvedValueOnce({ ok: false, error: "limit" } as never);
    await expect(groupDesktopTasks(repositoryId, ["T-1", "T-2"])).resolves.toEqual({ ok: false, error: "limit" });
    taskAction.mockResolvedValueOnce({ ok: false, error: "conflict" } as never);
    await expect(ungroupDesktopTasks(repositoryId, ["T-1"])).resolves.toEqual({ ok: false, error: "conflict" });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = undefined;
    await expect(groupDesktopTasks(repositoryId, ["T-1", "T-2"])).resolves.toEqual({ ok: false, error: "unavailable" });
  });

  it("carries group in a move only when it is set", async () => {
    bridge();
    await moveDesktopTask(repositoryId, { id: "T-1", columnId: "col-2", position: 3 });
    await moveDesktopTask(repositoryId, { id: "T-1", columnId: "col-2", position: 3, group: "block" });
    await moveDesktopTask(repositoryId, { id: "T-1", columnId: "col-2", position: 3, group: "leave" });
    expect(taskAction.mock.calls.map((call) => call[2])).toEqual([
      { id: "T-1", columnId: "col-2", position: 3 },
      { id: "T-1", columnId: "col-2", position: 3, group: "block" },
      { id: "T-1", columnId: "col-2", position: 3, group: "leave" },
    ]);
    expect(Object.keys(taskAction.mock.calls[0][2] as object)).not.toContain("group");
  });
});
