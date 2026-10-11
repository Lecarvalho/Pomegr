import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { moveChoices, isMovableQueueTask, queueFeatures, reorderMove, singleQueueTasks } from "../../app/components/tasks/task-queue-model";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished) runs in the order of its cards, one task per step: T-1 (done, step 1), T-3 (started, In
 * progress, step 2), then the waiting T-2, T-4 and T-6 in Ready (steps 3 to 5), then T-5 (not queued, Backlog, step 6).
 * Docs (unfinished): T-7 (queued, step 1). Old (done): T-8. Empty (unfinished, no task). Without a feature: T-9 and T-13
 * queued, T-10 scheduled, T-11 not queued, T-12 done.
 */
const tasks = () => [
  task(1, "Route", { featureId: "f1", state: "done", columnId: "col-4", position: 0 }),
  task(2, "Store", { featureId: "f1", state: "queued", columnId: "col-2", position: 0, run: { provider: "claude", model: "sonnet", effort: "medium" } }),
  task(3, "Columns", { featureId: "f1", state: "queued", columnId: "col-3", position: 0, session: { id: "claude:abc", title: "Column session", state: "working", observedModel: null } }),
  task(4, "Queue", { featureId: "f1", state: "queued", columnId: "col-2", position: 1 }),
  task(5, "Gates", { featureId: "f1", position: 0 }),
  task(6, "Schedule", { featureId: "f1", state: "queued", columnId: "col-2", position: 2, run: { provider: "codex", model: null, effort: "high" } }),
  task(7, "Guide", { featureId: "f2", state: "queued", columnId: "col-2", position: 3 }),
  task(8, "Old work", { featureId: "f3", state: "done", columnId: "col-4", position: 1 }),
  task(9, "Loose end", { state: "queued", columnId: "col-2", position: 5 }),
  task(10, "Nightly", { state: "scheduled", scheduledAt: "2026-10-09T02:00:00", columnId: "col-2", position: 6 }),
  task(11, "Idea", { position: 1 }),
  task(12, "Shipped", { state: "done", columnId: "col-4", position: 2 }),
  task(13, "First loose", { state: "queued", columnId: "col-2", position: 4 }),
];
const features = [
  { id: "f1", name: "Task board v1", done: false },
  { id: "f2", name: "Docs", done: false },
  { id: "f3", name: "Old", done: true },
  { id: "f4", name: "Empty", done: false },
];
const ORDER = ["T-2", "T-4", "T-6", "T-7", "T-13", "T-9"];

function setBoard(overrides: Partial<TaskBoard> = {}) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features, tasks: tasks(), queue: { status: "idle", blockedBy: null, pauseReason: null, order: ORDER }, ...overrides };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}
function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "uninitialized", dropEffect: "none", setData: vi.fn((type: string, value: string) => { data.set(type, value); }), getData: (type: string) => data.get(type) ?? "" };
}

beforeEach(() => {
  taskAction.mockResolvedValue({ ok: true });
  setBridge({ taskAction });
  setBoard();
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const step = (feature: string, number: number) => document.querySelector(`[data-feature-id="${feature}"] li[data-step="${number}"]`) as HTMLElement;
const chipText = (id: string) => card(id).querySelector(".commandChip")?.textContent;
const moves = () => taskAction.mock.calls.filter((call) => call[1] === "move");

async function showQueue() {
  render(<TaskBoardPane repositoryId={repositoryId} />);
  await userEvent.click(within(screen.getByRole("group", { name: "Tasks view" })).getByRole("button", { name: "Queue" }));
}

describe("a task that already started", () => {
  const gates = {
    threshold: 85 as const,
    usage: { claude: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 } },
    providerStatus: { claude: "ok" as const, codex: "ok" as const },
    workingTree: "dirty" as const,
    next: { taskId: "T-2", provider: "claude" as const, blockedBy: null, reasons: ["tree_dirty" as const] },
  };

  it("borrows its session state, is not next, and carries no Waiting line; the next waiting task carries it", async () => {
    setBoard({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ORDER, gates } });
    await showQueue();
    expect(chipText("T-3")).toBe("In progress");
    expect(within(card("T-3")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(within(card("T-2")).getByText(/Waiting: the working tree has uncommitted changes/)).toBeInTheDocument();
    expect(chipText("T-2")).toBe("Queued · next");
  });

  it("started by a live dispatch with no session yet keeps its own chip, no next marker and no Waiting line", async () => {
    const board = tasks().map((entry) => (entry.id === "T-9" ? { ...entry, state: "queued" as const } : entry));
    setBoard({ tasks: board, queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-2", "T-4", "T-6", "T-7", "T-13"], gates } });
    await showQueue();
    expect(chipText("T-9")).toBe("Queued");
    expect(within(card("T-9")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(card("T-9")).not.toHaveClass("isMovable");
    // Listed after the singles that wait, as every other single that is not in the order.
    expect(singleQueueTasks(setBoard({ tasks: board, queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-13"] } })).map((entry) => entry.id)).toEqual(["T-13", "T-9", "T-10"]);
  });
});

describe("the Board | Queue switch", () => {
  it("shows the same data as a board or as a queue and keeps the board-only action off the queue", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Tasks view" });
    expect(group).toHaveClass("commandSegmented");
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Queue" }));
    expect(within(group).getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "Task board" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New feature" })).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Board" }));
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  });

  it("is not drawn before the board is ready", () => {
    setBoard({ readiness: "loading", features: [], tasks: [] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("group", { name: "Tasks view" })).not.toBeInTheDocument();
  });
});

describe("the Queue view", () => {
  it("draws one panel per unfinished feature that holds a task, in board order", async () => {
    await showQueue();
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Task board v1", "Docs", "Single tasks", "When the queue blocks"]);
    const panel = within(screen.getByRole("region", { name: "Task board v1" }));
    expect(panel.getByText((_, element) => element?.className === "taskQueueCaption" && element.textContent === "1 of 6 tasks done")).toBeInTheDocument();
    expect(screen.getByText((_, element) => element?.className === "taskQueueCaption" && element.textContent === "0 of 1 task done")).toBeInTheDocument();
    expect(screen.queryByText("Old")).not.toBeInTheDocument();
    expect(screen.queryByText("Empty")).not.toBeInTheDocument();
  });

  it("numbers each step by the order of the cards, one task per step, with no parallel or worktree labels", async () => {
    await showQueue();
    const steps = within(screen.getByRole("list", { name: "Steps of Task board v1" }));
    const labels = [1, 2, 3, 4, 5, 6].map((n) => step("f1", n).querySelector(".taskQueueStepLabel")?.textContent);
    expect(labels).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 5", "Step 6"]);
    expect([1, 2, 3, 4, 5, 6].map((n) => [...step("f1", n).querySelectorAll("li[data-task-id]")].map((li) => li.getAttribute("data-task-id")))).toEqual([["T-1"], ["T-3"], ["T-2"], ["T-4"], ["T-6"], ["T-5"]]);
    expect(steps.getByRole("list", { name: "Step 3 task" })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/Parallel|One worktree each|One task|New last step/);
    expect(within(step("f2", 1)).getByText("Guide")).toBeInTheDocument();
  });

  it("draws ID, chip, title and run line on a step card, with the session title once it has one", async () => {
    await showQueue();
    expect(card("T-2")).toHaveTextContent("T-2");
    expect(within(card("T-2")).getByText("Store")).toBeInTheDocument();
    expect(card("T-2")).toHaveTextContent("Claude Code");
    expect(card("T-2")).toHaveTextContent("sonnet · medium");
    expect(card("T-6")).toHaveTextContent("Codex");
    expect(card("T-6")).toHaveTextContent("high");
    expect(card("T-4").querySelector(".taskCardRun")).toBeNull();
    expect(within(card("T-3")).getByText("Column session")).toBeInTheDocument();
    expect(within(card("T-3")).queryByText("Columns")).not.toBeInTheDocument();
  });

  it("marks exactly the first task of queue.order as Queued · next", async () => {
    await showQueue();
    expect(chipText("T-2")).toBe("Queued · next");
    expect([...document.querySelectorAll("li[data-task-id]")].filter((li) => li.querySelector(".commandChip")?.textContent === "Queued · next")).toHaveLength(1);
    expect(chipText("T-4")).toBe("Queued");
    expect(chipText("T-7")).toBe("Queued");
    expect(chipText("T-1")).toBe("Done");
    expect(chipText("T-5")).toBe("Not queued");
    expect(card("T-5").querySelector(".commandChip")).not.toHaveClass("isInk");
    expect(card("T-4").querySelector(".commandChip")).toHaveClass("isInk");
  });

  it("follows queue.order when another task is first", async () => {
    setBoard({ queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-6", "T-2", "T-4", "T-7", "T-13", "T-9"] } });
    await showQueue();
    expect(chipText("T-6")).toBe("Queued · next");
    expect(chipText("T-2")).toBe("Queued");
  });

  it("lists single tasks queued first in queue order, then the rest by number, without not queued or done ones", async () => {
    await showQueue();
    const panel = screen.getByRole("region", { name: "Single tasks" });
    expect(within(panel).getByText("Run after features, one at a time")).toBeInTheDocument();
    expect([...panel.querySelectorAll("li[data-task-id]")].map((li) => li.getAttribute("data-task-id"))).toEqual(["T-13", "T-9", "T-10"]);
    expect(within(panel).queryByText("Idea")).not.toBeInTheDocument();
    expect(within(panel).queryByText("Shipped")).not.toBeInTheDocument();
    expect(within(panel.querySelector('[data-task-id="T-10"]') as HTMLElement).getByText(/^Scheduled · Oct 9, 02:00$/)).toHaveClass("commandChip");
    expect(within(panel.querySelector('[data-task-id="T-13"]') as HTMLElement).getByText("Queued")).toBeInTheDocument();
  });

  it("says so when no single task is queued", async () => {
    setBoard({ tasks: tasks().filter((entry) => entry.featureId !== null), queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-2", "T-4", "T-6", "T-7"] } });
    await showQueue();
    expect(screen.getByText("No single task is queued.")).toBeInTheDocument();
  });

  it("shows an empty state when there is no feature panel and no single task", async () => {
    setBoard({ tasks: [task(1, "Idea"), task(2, "Shipped", { state: "done" })], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } });
    await showQueue();
    expect(screen.getByText(/Nothing is in the queue yet\. Open a task on the Board and choose Add to queue\./)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Single tasks" })).not.toBeInTheDocument();
  });

  it("explains the steps, with the exact note on the desktop", async () => {
    await showQueue();
    const notes = screen.getAllByText("Steps run in order, one task at a time. A task's step is the place of its card on the board. Drag a task that waits in the queue onto another step to change when it runs. Tasks that started or finished stay where they are.");
    expect(notes).toHaveLength(2);
    expect(screen.queryByText(/Drop a task here/)).not.toBeInTheDocument();
  });

  it("renders on the server without the desktop bridge", () => {
    expect(() => renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toThrow();
  });
});

describe("pure queue rules", () => {
  it("groups features in step order and accepts only moves the board would make", () => {
    const board = setBoard();
    const [first] = queueFeatures(board);
    expect(first.total).toBe(6);
    expect(first.done).toBe(1);
    expect(first.steps.map((entry) => [entry.step, entry.task.id])).toEqual([[1, "T-1"], [2, "T-3"], [3, "T-2"], [4, "T-4"], [5, "T-6"], [6, "T-5"]]);
    const byId = (id: string) => board.tasks.find((entry) => entry.id === id)!;
    expect(reorderMove(board, byId("T-4"), byId("T-2"))).toEqual({ id: "T-4", columnId: "col-2", position: 0 });
    expect(reorderMove(board, byId("T-2"), byId("T-6"))).toEqual({ id: "T-2", columnId: "col-2", position: 2 });
    expect(reorderMove(board, byId("T-4"), byId("T-4"))).toBeNull();
    // Another feature, a task that is not waiting, one that started and one that is finished never take part.
    expect(reorderMove(board, byId("T-4"), byId("T-7"))).toBeNull();
    expect(reorderMove(board, byId("T-4"), byId("T-5"))).toBeNull();
    expect(reorderMove(board, byId("T-4"), byId("T-3"))).toBeNull();
    expect(reorderMove(board, byId("T-4"), byId("T-1"))).toBeNull();
    expect(reorderMove(board, byId("T-5"), byId("T-2"))).toBeNull();
    expect(reorderMove(board, byId("T-3"), byId("T-2"))).toBeNull();
    expect(reorderMove({ ...board, columns: [] }, byId("T-4"), byId("T-2"))).toBeNull();
    expect(isMovableQueueTask(byId("T-4"))).toBe(true);
    expect([5, 3, 1, 9].map((n) => isMovableQueueTask(byId(`T-${n}`)))).toEqual([false, false, false, false]);
    expect(moveChoices(board, first, byId("T-4"))).toEqual([{ step: 3, label: "Step 3" }, { step: 5, label: "Step 5" }]);
    expect(moveChoices(board, first, byId("T-6")).map((choice) => choice.label)).toEqual(["Step 3", "Step 4"]);
    expect(moveChoices(board, first, byId("T-5"))).toEqual([]);
    expect(singleQueueTasks(board).map((entry) => entry.id)).toEqual(["T-13", "T-9", "T-10"]);
  });
});

describe("dragging a queued task", () => {
  it("moves it to another step with the move action of its card", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "T-4");
    expect(fireEvent.dragOver(step("f1", 3), { dataTransfer })).toBe(false);
    expect(step("f1", 3)).toHaveClass("isDragOver");
    fireEvent.drop(step("f1", 3), { dataTransfer });
    expect(step("f1", 3)).not.toHaveClass("isDragOver");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", { id: "T-4", columnId: "col-2", position: 0 }));
    expect(taskAction.mock.calls.some((call) => call[1] === "queue_reorder")).toBe(false);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // The card order decides the step, so the board already reads T-4 first among the waiting tasks.
    expect(step("f1", 3).querySelector("li[data-task-id]")).toHaveAttribute("data-task-id", "T-4");
    expect(step("f1", 4).querySelector("li[data-task-id]")).toHaveAttribute("data-task-id", "T-2");
  });

  it("clears the fill when the pointer leaves or the drag ends", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(step("f1", 3), { dataTransfer });
    const leave = createEvent.dragLeave(step("f1", 3));
    Object.defineProperty(leave, "relatedTarget", { value: null });
    fireEvent(step("f1", 3), leave);
    expect(step("f1", 3)).not.toHaveClass("isDragOver");
    fireEvent.dragOver(step("f1", 5), { dataTransfer });
    expect(step("f1", 5)).toHaveClass("isDragOver");
    fireEvent.dragEnd(card("T-4"), { dataTransfer });
    expect(step("f1", 5)).not.toHaveClass("isDragOver");
    expect(moves()).toHaveLength(0);
  });

  it("starts a drag only on cards that wait in the queue and shows the grab cursor only there", async () => {
    await showQueue();
    for (const id of ["T-2", "T-4", "T-6", "T-7"]) {
      expect(card(id)).toHaveAttribute("draggable", "true");
      expect(card(id)).toHaveClass("isMovable");
    }
    // T-3 started (queued state, linked session), T-5 is not queued and T-1 is done: none of them can be moved.
    for (const id of ["T-1", "T-3", "T-5"]) {
      expect(card(id)).not.toHaveAttribute("draggable");
      expect(card(id)).not.toHaveClass("isMovable");
    }
    // A drag that never started from a movable card offers no drop target, even for a foreign payload.
    const foreign = transfer();
    fireEvent.dragStart(card("T-3"), { dataTransfer: foreign });
    expect(fireEvent.dragOver(step("f1", 5), { dataTransfer: foreign })).toBe(true);
    fireEvent.drop(step("f1", 5), { dataTransfer: foreign });
    expect(moves()).toHaveLength(0);
  });

  it("ignores drag-over and drop on a step whose task is finished, started or not queued", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    for (const number of [1, 2, 6]) {
      expect(fireEvent.dragOver(step("f1", number), { dataTransfer })).toBe(true);
      expect(step("f1", number)).not.toHaveClass("isDragOver");
      fireEvent.drop(step("f1", number), { dataTransfer });
    }
    expect(moves()).toHaveLength(0);
  });

  it("ignores a drop on another feature's step and a drop that would change nothing", async () => {
    await showQueue();
    let dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(fireEvent.dragOver(step("f2", 1), { dataTransfer })).toBe(true);
    fireEvent.drop(step("f2", 1), { dataTransfer });
    fireEvent.dragEnd(card("T-4"), { dataTransfer });
    dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.drop(step("f1", 4), { dataTransfer });
    expect(moves()).toHaveLength(0);
  });

  it("shows one fixed message when the monitor refuses the move", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.drop(step("f1", 3), { dataTransfer });
    expect(await screen.findByRole("alert")).toHaveTextContent("The card could not be moved.");
  });
});

describe("moving a queued task from the keyboard", () => {
  it("offers the steps that accept it and sends the move of its card", async () => {
    await showQueue();
    const trigger = within(card("T-4")).getByRole("combobox", { name: "Move T-4 to step" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 3", "Step 5"]);
    fireEvent.click(trigger);
    chooseCommandOption(trigger, "Step 3");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", { id: "T-4", columnId: "col-2", position: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("T-4 moved to step 3.");
    expect(taskAction.mock.calls.some((call) => call[1] === "queue_reorder")).toBe(false);
  });

  it("is offered only on cards that wait in the queue", async () => {
    await showQueue();
    expect(within(card("T-2")).getByRole("combobox", { name: "Move T-2 to step" })).toBeInTheDocument();
    for (const id of ["T-1", "T-3", "T-5"]) expect(within(card(id)).queryByRole("combobox")).not.toBeInTheDocument();
    // The last waiting task of the feature can go earlier but not onto a task that started.
    const trigger = within(card("T-6")).getByRole("combobox", { name: "Move T-6 to step" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 3", "Step 4"]);
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("is read-only: nothing is draggable and there is no move control or New feature", async () => {
    await showQueue();
    expect(card("T-4")).toBeInTheDocument();
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Drag a task that waits/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Steps run in order, one task at a time. A task's step is the place of its card on the board. Tasks that started or finished stay where they are.")).toHaveLength(2);
    expect(chipText("T-2")).toBe("Queued · next");
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("offers the switch to every client", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.getByRole("group", { name: "Tasks view" })).toBeInTheDocument();
  });
});

describe("Queued · next on the board and in the Task modal", () => {
  it("reads Queued · next on one board card and Queued on the others", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(chipText("T-2")).toBe("Queued · next");
    expect(chipText("T-4")).toBe("Queued");
    expect(chipText("T-5")).toBe("Not queued");
    expect(chipText("T-9")).toBe("Queued");
  });

  it("reads it in the feature task list inside the Task modal", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: "Gates" }));
    const dialog = screen.getByRole("dialog", { name: "Task" });
    const list = within(dialog).getByText("In this feature").closest("details") as HTMLElement;
    const row = (id: string) => list.querySelector(`li[data-task-id="${id}"] .commandChip`)?.textContent;
    expect(row("T-2")).toBe("Queued · next");
    expect(row("T-4")).toBe("Queued");
  });
});

describe("Add to queue and Remove from queue", () => {
  async function openModal(title: string) {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: title }));
    return within(screen.getByRole("dialog", { name: "Task" }));
  }

  it("adds a Not queued task, after the Delete action", async () => {
    const dialog = await openModal("Idea");
    const add = dialog.getByRole("button", { name: "Add to queue" });
    expect(add).toHaveClass("commandSecondaryAction");
    expect(dialog.getByRole("button", { name: "Delete task" }).compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
    await userEvent.click(add);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_add", { id: "T-11" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("removes a queued task", async () => {
    const dialog = await openModal("Loose end");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_remove", { id: "T-9" }));
  });

  it("shows one line when the monitor refuses", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const dialog = await openModal("Idea");
    await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be added to the queue.");
  });

  it("offers neither action on a finished task", async () => {
    const dialog = await openModal("Shipped");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
  });
});
