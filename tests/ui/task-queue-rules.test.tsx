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
import { boardStepChoices, isBoardStepTask, isMovableQueueTask, queueFeatures, reorderTarget } from "../../app/components/tasks/task-queue-model";

/**
 * The rules of the queue that the Board shows. They were guarded on the Queue view before the Board became the only
 * view of the Tasks page.
 */
const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position, role: null }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-2", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished): step 1 T-1 (done), step 2 T-2 (queued, waits in Ready) and T-3 (started, In progress),
 * step 3 T-4 (queued) and T-5 (not queued, Backlog), step 4 T-6 (queued, alone in the last step). Docs (unfinished):
 * step 1 T-7 (queued). Old (done): T-8. Empty (unfinished, no task). Without a feature: T-9 and T-13 queued, T-10
 * scheduled, T-11 not queued (Backlog), T-12 done.
 */
const tasks = (): Task[] => [
  task(1, "Route", { featureId: "f1", step: 1, state: "done", columnId: "col-5" }),
  task(2, "Store", { featureId: "f1", step: 2, position: 0 }),
  task(3, "Columns", { featureId: "f1", step: 2, columnId: "col-3", session: { id: "claude:abc", title: "Column session", state: "working", observedModel: null } }),
  task(4, "Ranking", { featureId: "f1", step: 3, position: 1 }),
  task(5, "Gates", { featureId: "f1", step: 3, state: "not_queued", columnId: "col-1" }),
  task(6, "Schedule", { featureId: "f1", step: 4, position: 2 }),
  task(7, "Guide", { featureId: "f2", step: 1, position: 3 }),
  task(8, "Old work", { featureId: "f3", step: 1, state: "done", columnId: "col-5" }),
  task(9, "Loose end", { position: 5 }),
  task(10, "Nightly", { state: "scheduled", scheduledAt: "2026-10-09T02:00:00", position: 6 }),
  task(11, "Idea", { state: "not_queued", columnId: "col-1" }),
  task(12, "Shipped", { state: "done", columnId: "col-5" }),
  task(13, "First loose", { position: 4 }),
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
const chipText = (id: string) => card(id).querySelector(".commandChip")?.textContent;
const lane = () => screen.getByRole("region", { name: "Ready" }) as HTMLElement;
const group = (feature: string, step: number) => lane().querySelector(`.taskReadyGroup[data-step-feature="${feature}"][data-step="${step}"]`) as HTMLElement;
const reorders = () => taskAction.mock.calls.filter((call) => call[1] === "queue_reorder");
const stepSelect = (id: string) => within(card(id)).getByRole("combobox", { name: `Move ${id} to step` });
const renderBoard = () => render(<TaskBoardPane repositoryId={repositoryId} />);

describe("the page header", () => {
  const bridge = () => setBridge({ taskAction, taskIssues: vi.fn() });
  const switcher = <select aria-label="Repository"><option>Pomegr</option></select>;

  it("has no view switch and no Board or Queue button in the desktop app or in a browser", () => {
    for (const value of [{ taskAction }, undefined]) {
      setBridge(value);
      const view = render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
      expect(screen.queryByRole("group", { name: "Tasks view" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("holds the Repository select, the Queue switch, then Promote issues once a feature exists", () => {
    bridge();
    render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
    const actions = document.querySelector(".taskHeadActions") as HTMLElement;
    const repository = within(actions).getByRole("combobox", { name: "Repository" });
    const queueGroup = within(actions).getByRole("group", { name: "Queue" });
    const promote = within(actions).getByRole("link", { name: "Promote issues" });
    expect(repository.compareDocumentPosition(queueGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queueGroup.compareDocumentPosition(promote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
  });

  it("offers + New feature in the header only while the board has no feature", () => {
    bridge();
    setBoard({ features: [], tasks: [] });
    render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
    const actions = document.querySelector(".taskHeadActions") as HTMLElement;
    const queueGroup = within(actions).getByRole("group", { name: "Queue" });
    const add = within(actions).getByRole("button", { name: "+ New feature" });
    expect(queueGroup.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(within(actions).getByRole("link", { name: "Promote issues" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders on the server without the desktop bridge", () => {
    setBridge(undefined);
    expect(() => renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toThrow();
  });
});

describe("the Board footnote", () => {
  it("reads the drag rule, with the new step placed after the feature's last step, in the desktop app", () => {
    renderBoard();
    expect(screen.getByText("Drag a card to move it. In Ready, drop a card on a step to run it in parallel with that step, or after its feature's last step to give it a step of its own.")).toHaveClass("taskBoardFootnote");
  });

  it("is not drawn without the desktop bridge", () => {
    setBridge(undefined);
    renderBoard();
    expect(document.querySelector(".taskBoardFootnote")).toBeNull();
  });
});

describe("a task that already started", () => {
  const gates = {
    threshold: 85 as const,
    usage: { claude: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 } },
    providerStatus: { claude: "ok" as const, codex: "ok" as const },
    workingTree: "dirty" as const,
    next: { taskId: "T-2", provider: "claude" as const, blockedBy: null, reasons: ["tree_dirty" as const] },
  };

  it("borrows its session state, is not next, and carries no Waiting line; the next waiting task carries it", () => {
    setBoard({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ORDER, gates } });
    renderBoard();
    expect(chipText("T-3")).toBe("In progress");
    expect(within(card("T-3")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(card("T-3").closest(".taskReadyGroup")).toBeNull();
    expect(within(card("T-2")).getByText(/Waiting: the working tree has uncommitted changes/)).toBeInTheDocument();
    expect(card("T-2").closest(".taskReadyGroup")).not.toBeNull();
    expect(chipText("T-2")).toBe("Queued · next");
  });

  it("started by a live dispatch with no session yet keeps its own chip, no next marker and no Waiting line", () => {
    setBoard({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-2", "T-4", "T-6", "T-7", "T-13"], gates } });
    renderBoard();
    expect(chipText("T-9")).toBe("Queued");
    expect(within(card("T-9")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(within(card("T-9")).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Queued · next on the board and in the Task modal", () => {
  it("marks exactly the first task of queue.order as Queued · next", () => {
    renderBoard();
    expect(chipText("T-2")).toBe("Queued · next");
    expect([...document.querySelectorAll("li[data-task-id]")].filter((li) => li.querySelector(".commandChip")?.textContent === "Queued · next")).toHaveLength(1);
    expect(chipText("T-4")).toBe("Queued");
    expect(chipText("T-7")).toBe("Queued");
    expect(chipText("T-9")).toBe("Queued");
    expect(chipText("T-1")).toBe("Done");
    expect(chipText("T-5")).toBe("Not queued");
    expect(card("T-5").querySelector(".commandChip")).not.toHaveClass("isInk");
    expect(card("T-4").querySelector(".commandChip")).toHaveClass("isInk");
  });

  it("follows queue.order when another task is first", () => {
    setBoard({ queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-6", "T-2", "T-4", "T-7", "T-13", "T-9"] } });
    renderBoard();
    expect(chipText("T-6")).toBe("Queued · next");
    expect(chipText("T-2")).toBe("Queued");
  });

  it("reads it in the feature task list inside the Task modal", async () => {
    renderBoard();
    await userEvent.click(screen.getByRole("button", { name: "Gates" }));
    const dialog = screen.getByRole("dialog", { name: "Task" });
    const list = within(dialog).getByText("In this feature").closest("details") as HTMLElement;
    const row = (id: string) => list.querySelector(`li[data-task-id="${id}"] .commandChip`)?.textContent;
    expect(row("T-2")).toBe("Queued · next");
    expect(row("T-4")).toBe("Queued");
  });
});

describe("pure queue rules", () => {
  it("groups features and accepts only steps the monitor would", () => {
    const board = setBoard();
    const [first] = queueFeatures(board);
    expect(first.highest).toBe(4);
    expect(first.steps.map((entry) => [entry.step, entry.allDone])).toEqual([[1, true], [2, false], [3, false], [4, false]]);
    const find = (id: string) => board.tasks.find((entry) => entry.id === id)!;
    const t4 = find("T-4");
    expect(reorderTarget(first, t4, 1)).toBeNull();
    expect(reorderTarget(first, t4, 3)).toBeNull();
    expect(reorderTarget(first, t4, 2)).toBe(2);
    expect(reorderTarget(first, t4, null)).toBe(5);
    expect(reorderTarget(first, t4, 9)).toBeNull();
    const t6 = find("T-6");
    expect(reorderTarget(first, t6, null)).toBeNull();
    // Not queued and not started: it moves like a queued task. T-3 started, so it does not.
    expect(reorderTarget(first, find("T-5"), 2)).toBe(2);
    expect(reorderTarget(first, find("T-3"), 3)).toBeNull();
    expect(boardStepChoices(first, t4).map((choice) => choice.label)).toEqual(["Step 2 · running", "Step 4 · parallel with T-6", "New last step"]);
    expect(boardStepChoices(first, t6).map((choice) => choice.label)).toEqual(["Step 2 · running", "Step 3 · parallel with T-4, T-5"]);
  });

  it("offers a step to every card of a feature that has not started, queued or not, and to no other", () => {
    const board = setBoard();
    const find = (id: string) => board.tasks.find((entry) => entry.id === id)!;
    for (const id of ["T-2", "T-4", "T-5", "T-6", "T-7"]) expect(isMovableQueueTask(find(id)), id).toBe(true);
    for (const id of ["T-1", "T-3", "T-9", "T-10", "T-11", "T-12"]) expect(isMovableQueueTask(find(id)), id).toBe(false);
    // A drag drops on a step only for a waiting card; the select serves the others.
    expect(isBoardStepTask(find("T-4"))).toBe(true);
    expect(isBoardStepTask(find("T-5"))).toBe(false);
  });
});

describe("dropping a card on a step", () => {
  it("sends queue_reorder with the step and clears the target", async () => {
    renderBoard();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "T-4");
    fireEvent.dragOver(card("T-2"), { dataTransfer });
    expect(group("f1", 2)).toHaveClass("isStepTarget");
    fireEvent.drop(card("T-2"), { dataTransfer });
    expect(group("f1", 2)).not.toHaveClass("isStepTarget");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 2 }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("clears the target when the pointer leaves or the drag ends, and sends nothing", () => {
    renderBoard();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(card("T-2"), { dataTransfer });
    expect(group("f1", 2)).toHaveClass("isStepTarget");
    fireEvent.dragEnd(card("T-4"), { dataTransfer });
    expect(document.querySelector(".isStepTarget")).toBeNull();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(card("T-2"), { dataTransfer });
    const list = lane().querySelector(".taskColumnList") as HTMLElement;
    const leave = createEvent.dragLeave(list);
    Object.defineProperty(leave, "relatedTarget", { value: null });
    fireEvent(list, leave);
    expect(document.querySelector(".isStepTarget")).toBeNull();
    expect(reorders()).toHaveLength(0);
  });

  it("ignores a step whose tasks are all done", () => {
    renderBoard();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    // Step 1 of the feature is done and sits in the Done lane: it accepts neither a target nor a drop.
    fireEvent.dragOver(card("T-1"), { dataTransfer });
    expect(document.querySelector(".isStepTarget")).toBeNull();
    fireEvent.drop(card("T-1"), { dataTransfer });
    expect(reorders()).toHaveLength(0);
  });

  it("ignores a drop on another feature's step and a drop that would change nothing", () => {
    renderBoard();
    let dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(card("T-7"), { dataTransfer });
    expect(group("f2", 1)).not.toHaveClass("isStepTarget");
    fireEvent.drop(card("T-7"), { dataTransfer });
    fireEvent.dragEnd(card("T-4"), { dataTransfer });
    // Its own step.
    dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(card("T-4"), { dataTransfer });
    expect(group("f1", 3)).not.toHaveClass("isStepTarget");
    fireEvent.drop(card("T-4"), { dataTransfer });
    expect(reorders()).toHaveLength(0);
  });

  it("gives a card that started no step to drop on", () => {
    renderBoard();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-3"), { dataTransfer });
    fireEvent.dragOver(card("T-2"), { dataTransfer });
    expect(document.querySelector(".isStepTarget")).toBeNull();
    fireEvent.drop(card("T-2"), { dataTransfer });
    expect(reorders()).toHaveLength(0);
    expect(isBoardStepTask(tasks().find((entry) => entry.id === "T-3")!)).toBe(false);
  });

  it("shows one fixed message when the monitor refuses the move", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    renderBoard();
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-4"), { dataTransfer });
    fireEvent.dragOver(card("T-2"), { dataTransfer });
    fireEvent.drop(card("T-2"), { dataTransfer });
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be moved to that step.");
  });
});

describe("Move to step", () => {
  it("offers the steps that accept a queued card and a new last step, and sends the same action", async () => {
    renderBoard();
    const trigger = stepSelect("T-4");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 2 · running", "Step 4 · parallel with T-6", "New last step"]);
    fireEvent.click(trigger);
    chooseCommandOption(trigger, "Step 4 · parallel with T-6");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 4 }));
    chooseCommandOption(stepSelect("T-4"), "New last step");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-4", step: 5 }));
    expect(screen.getByRole("status")).toHaveTextContent("T-4 moved to step 5.");
  });

  it("is offered on a card that is not queued, which moves to a new last step", async () => {
    renderBoard();
    expect(card("T-5").closest("section")).toBe(screen.getByRole("region", { name: "Backlog" }));
    chooseCommandOption(stepSelect("T-5"), "New last step");
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_reorder", { id: "T-5", step: 5 }));
    expect(taskAction).toHaveBeenCalledTimes(1);
  });

  it("is offered only on cards of a feature that have not started", () => {
    renderBoard();
    for (const id of ["T-2", "T-4", "T-5", "T-6"]) expect(stepSelect(id)).toBeInTheDocument();
    // Started, done, alone in a feature with one step, not in a feature, or not queued without a feature: no step to move to.
    for (const id of ["T-1", "T-3", "T-7", "T-9", "T-10", "T-11", "T-12", "T-13"]) expect(within(card(id)).queryByRole("combobox"), id).not.toBeInTheDocument();
    // A queued task alone in the last step can still go earlier but has no new last step.
    fireEvent.click(stepSelect("T-6"));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Step 2 · running", "Step 3 · parallel with T-4, T-5"]);
  });

  it("is not offered to a card of a feature once a session started it", () => {
    setBoard({ tasks: tasks().map((entry) => (entry.id === "T-5" ? { ...entry, session: { id: "claude:x", title: null, state: "working", observedModel: null } } : entry)) });
    renderBoard();
    expect(within(card("T-5")).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("is read-only: nothing is draggable and there is no move control, New feature or footnote", () => {
    renderBoard();
    expect(card("T-4")).toBeInTheDocument();
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
    // The Feature filter is a combobox too; no card carries a Move to step select.
    expect(screen.queryAllByRole("combobox").filter((box) => /^Move T-d+ to step$/.test(box.getAttribute("aria-label") ?? ""))).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(document.querySelector(".taskBoardFootnote")).toBeNull();
    expect(chipText("T-2")).toBe("Queued · next");
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("Add to queue and Remove from queue", () => {
  async function openModal(title: string) {
    renderBoard();
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
