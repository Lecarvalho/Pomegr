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

import { TasksTab } from "../../app/components/tasks/TasksTab";
import { moveChoices, queueFeatures, reorderTarget, singleQueueTasks } from "../../app/components/tasks/task-queue-model";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished): step 1 T-1 (done), step 2 T-2 and T-3 (queued), step 3 T-4 (queued) and T-5 (not queued),
 * step 4 T-6 (queued, alone in the last step). Docs (unfinished): step 1 T-7 (queued). Old (done): T-8.
 * Empty (unfinished, no task). Without a feature: T-9 and T-13 queued, T-10 scheduled, T-11 not queued, T-12 done.
 */
const tasks = () => [
  task(1, "Route", { featureId: "f1", step: 1, state: "done" }),
  task(2, "Store", { featureId: "f1", step: 2, state: "queued", run: { provider: "claude", model: "sonnet", effort: "medium" } }),
  task(3, "Columns", { featureId: "f1", step: 2, state: "queued", session: { id: "claude:abc", title: "Column session", state: "working", observedModel: null } }),
  task(4, "Queue", { featureId: "f1", step: 3, state: "queued" }),
  task(5, "Gates", { featureId: "f1", step: 3 }),
  task(6, "Schedule", { featureId: "f1", step: 4, state: "queued", run: { provider: "codex", model: null, effort: "high" } }),
  task(7, "Guide", { featureId: "f2", step: 1, state: "queued" }),
  task(8, "Old work", { featureId: "f3", step: 1, state: "done" }),
  task(9, "Loose end", { state: "queued" }),
  task(10, "Nightly", { state: "scheduled", scheduledAt: "2026-10-09T02:00:00" }),
  task(11, "Idea"),
  task(12, "Shipped", { state: "done" }),
  task(13, "First loose", { state: "queued" }),
];
const features = [
  { id: "f1", name: "Task board v1", done: false },
  { id: "f2", name: "Docs", done: false },
  { id: "f3", name: "Old", done: true },
  { id: "f4", name: "Empty", done: false },
];
const ORDER = ["T-2", "T-3", "T-4", "T-6", "T-7", "T-13", "T-9"];

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
const zone = (feature: string) => within(document.querySelector(`[data-feature-id="${feature}"]`) as HTMLElement).getByRole("group", { name: "New last step" }).closest("li") as HTMLElement;
const chipText = (id: string) => card(id).querySelector(".commandChip")?.textContent;
const reorders = () => taskAction.mock.calls.filter((call) => call[1] === "queue_reorder");

async function showQueue() {
  render(<TasksTab repositoryId={repositoryId} />);
  await userEvent.click(within(screen.getByRole("group", { name: "Tasks view" })).getByRole("button", { name: "Queue" }));
}

describe("the Board | Queue switch", () => {
  it("shows the same data as a board or as a queue and keeps the board-only action off the queue", async () => {
    render(<TasksTab repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Tasks view" });
    expect(group).toHaveClass("commandSegmented");
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add column" })).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Queue" }));
    expect(within(group).getByRole("button", { name: "Queue" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("region", { name: "Task board" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add column" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New feature" })).toBeInTheDocument();

    await userEvent.click(within(group).getByRole("button", { name: "Board" }));
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  });

  it("is not drawn before the board is ready", () => {
    setBoard({ readiness: "loading", features: [], tasks: [] });
    render(<TasksTab repositoryId={repositoryId} />);
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

  it("names each step, its mode and the worktree note only for a parallel step", async () => {
    await showQueue();
    const board = within(screen.getByRole("list", { name: "Steps of Task board v1" }));
    const labels = [1, 2, 3, 4].map((n) => step("f1", n).querySelector(".taskQueueStepLabel")?.textContent);
    expect(labels).toEqual(["Step 1One task", "Step 2Parallel · 2One worktree each", "Step 3Parallel · 2One worktree each", "Step 4One task"]);
    expect(board.getAllByText("One worktree each")).toHaveLength(2);
    expect(within(step("f2", 1)).queryByText("One worktree each")).not.toBeInTheDocument();
    expect([...step("f1", 2).querySelectorAll("li[data-task-id]")].map((li) => li.getAttribute("data-task-id"))).toEqual(["T-2", "T-3"]);
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
    setBoard({ queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-6", "T-2", "T-3", "T-4", "T-7", "T-13", "T-9"] } });
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
    setBoard({ tasks: tasks().filter((entry) => entry.featureId !== null), queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-2", "T-3", "T-4", "T-6", "T-7"] } });
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
    const notes = screen.getAllByText("Steps run in order. Tasks inside one step run at the same time. Drag a queued task to another step to change when it runs. Tasks that started or finished stay where they are.");
    expect(notes).toHaveLength(2);
    expect(screen.getAllByText("Drop a queued task here to add a step at the end")).toHaveLength(2);
  });

  it("renders on the server without the desktop bridge", () => {
    expect(() => renderToString(<TasksTab repositoryId={repositoryId} />)).not.toThrow();
  });
});

describe("pure queue rules", () => {
  it("groups features and accepts only steps the monitor would", () => {
    const board = setBoard();
    const [first] = queueFeatures(board);
    expect(first.highest).toBe(4);
    expect(first.steps.map((entry) => [entry.step, entry.allDone])).toEqual([[1, true], [2, false], [3, false], [4, false]]);
    const t4 = board.tasks.find((entry) => entry.id === "T-4")!;
    expect(reorderTarget(first, t4, 1)).toBeNull();
    expect(reorderTarget(first, t4, 3)).toBeNull();
    expect(reorderTarget(first, t4, 2)).toBe(2);
    expect(reorderTarget(first, t4, null)).toBe(5);
    expect(reorderTarget(first, t4, 9)).toBeNull();
    const t6 = board.tasks.find((entry) => entry.id === "T-6")!;
    expect(reorderTarget(first, t6, null)).toBeNull();
    expect(reorderTarget(first, board.tasks.find((entry) => entry.id === "T-5")!, 2)).toBeNull();
    expect(moveChoices(first, t4).map((choice) => choice.label)).toEqual(["Step 2", "Step 4", "New last step"]);
    expect(moveChoices(first, t6).map((choice) => choice.label)).toEqual(["Step 2", "Step 3"]);
    expect(singleQueueTasks(board).map((entry) => entry.id)).toEqual(["T-13", "T-9", "T-10"]);
  });
});

describe("dragging a queued task", () => {
  it("moves it to another step with queue_reorder", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "T-4");
    expect(fireEvent.dragOver(step("f1", 2), { dataTransfer })).toBe(false);
    expect(step("f1", 2)).toHaveClass("isDragOver");
    fireEvent.drop(step("f1", 2), { dataTransfer });
    expect(step("f1", 2)).not.toHaveClass("isDragOver");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 2 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("appends a new last step when dropped on the dashed zone", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(fireEvent.dragOver(zone("f1"), { dataTransfer })).toBe(false);
    expect(zone("f1")).toHaveClass("isDragOver");
    fireEvent.drop(zone("f1"), { dataTransfer });
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 5 }));
  });

  it("clears the fill when the pointer leaves or the drag ends", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(step("f1", 2), { dataTransfer });
    const leave = createEvent.dragLeave(step("f1", 2));
    Object.defineProperty(leave, "relatedTarget", { value: null });
    fireEvent(step("f1", 2), leave);
    expect(step("f1", 2)).not.toHaveClass("isDragOver");
    fireEvent.dragOver(zone("f1"), { dataTransfer });
    fireEvent.dragEnd(card("T-4"), { dataTransfer });
    expect(zone("f1")).not.toHaveClass("isDragOver");
    expect(reorders()).toHaveLength(0);
  });

  it("starts a drag only on queued cards and shows the grab cursor only there", async () => {
    await showQueue();
    for (const id of ["T-2", "T-3", "T-4", "T-6", "T-7"]) {
      expect(card(id)).toHaveAttribute("draggable", "true");
      expect(card(id)).toHaveClass("isMovable");
    }
    for (const id of ["T-1", "T-5"]) {
      expect(card(id)).not.toHaveAttribute("draggable");
      expect(card(id)).not.toHaveClass("isMovable");
    }
    // A drag that never started from a queued card offers no drop target, even for a foreign payload.
    const foreign = transfer();
    fireEvent.dragStart(card("T-5"), { dataTransfer: foreign });
    expect(fireEvent.dragOver(step("f1", 2), { dataTransfer: foreign })).toBe(true);
    fireEvent.drop(step("f1", 2), { dataTransfer: foreign });
    expect(reorders()).toHaveLength(0);
  });

  it("ignores drag-over and drop on a step whose tasks are all done", async () => {
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(fireEvent.dragOver(step("f1", 1), { dataTransfer })).toBe(true);
    expect(step("f1", 1)).not.toHaveClass("isDragOver");
    fireEvent.drop(step("f1", 1), { dataTransfer });
    expect(reorders()).toHaveLength(0);
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
    fireEvent.drop(step("f1", 3), { dataTransfer });
    dataTransfer = transfer();
    fireEvent.dragStart(card("T-6"), { dataTransfer });
    fireEvent.drop(zone("f1"), { dataTransfer });
    expect(reorders()).toHaveLength(0);
  });

  it("shows one fixed message when the monitor refuses the move", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    await showQueue();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.drop(step("f1", 2), { dataTransfer });
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be moved to that step.");
  });
});

describe("moving a queued task from the keyboard", () => {
  it("offers the steps that accept it and a new last step, and sends the same action", async () => {
    await showQueue();
    const trigger = within(card("T-4")).getByRole("combobox", { name: "Move T-4 to step" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 2", "Step 4", "New last step"]);
    fireEvent.click(trigger);
    chooseCommandOption(trigger, "Step 2");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 2 }));
    chooseCommandOption(within(card("T-4")).getByRole("combobox", { name: "Move T-4 to step" }), "New last step");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 5 }));
    expect(screen.getByRole("status")).toHaveTextContent("T-4 moved to step 5.");
  });

  it("is offered on queued cards only", async () => {
    await showQueue();
    expect(within(card("T-5")).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(card("T-1")).queryByRole("combobox")).not.toBeInTheDocument();
    // A queued task alone in the last step can still go earlier but has no new last step.
    const trigger = within(card("T-6")).getByRole("combobox", { name: "Move T-6 to step" });
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 2", "Step 3"]);
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("is read-only: nothing is draggable and there is no move control, drop zone or New feature", async () => {
    await showQueue();
    expect(card("T-4")).toBeInTheDocument();
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Drop a queued task here to add a step at the end")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Drag a queued task/)).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Steps run in order\./)).toHaveLength(2);
    expect(chipText("T-2")).toBe("Queued · next");
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("offers the switch to every client", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.getByRole("group", { name: "Tasks view" })).toBeInTheDocument();
  });
});

describe("Queued · next on the board and in the Task panel", () => {
  it("reads Queued · next on one board card and Queued on the others", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    expect(chipText("T-2")).toBe("Queued · next");
    expect(chipText("T-4")).toBe("Queued");
    expect(chipText("T-5")).toBe("Not queued");
    expect(chipText("T-9")).toBe("Queued");
  });

  it("reads it in the feature task list inside the Task panel", async () => {
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: "Gates" }));
    const dialog = screen.getByRole("dialog", { name: "Task T-5" });
    const list = within(dialog).getByText("In this feature").closest("details") as HTMLElement;
    const row = (id: string) => list.querySelector(`li[data-task-id="${id}"] .commandChip`)?.textContent;
    expect(row("T-2")).toBe("Queued · next");
    expect(row("T-4")).toBe("Queued");
  });
});

describe("Add to queue and Remove from queue", () => {
  async function openPanel(title: string, id: string) {
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: title }));
    return within(screen.getByRole("dialog", { name: `Task ${id}` }));
  }

  it("adds a Not queued task, before the Delete action", async () => {
    const dialog = await openPanel("Idea", "T-11");
    const add = dialog.getByRole("button", { name: "Add to queue" });
    expect(add).toHaveClass("commandSecondaryAction");
    expect(add.compareDocumentPosition(dialog.getByRole("button", { name: "Delete task" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
    await userEvent.click(add);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_add", { id: "T-11" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("removes a queued task", async () => {
    const dialog = await openPanel("Loose end", "T-9");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_remove", { id: "T-9" }));
  });

  it("shows one line when the monitor refuses", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const dialog = await openPanel("Idea", "T-11");
    await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be added to the queue.");
  });

  it("offers neither action on a finished task", async () => {
    const dialog = await openPanel("Shipped", "T-12");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
  });
});
