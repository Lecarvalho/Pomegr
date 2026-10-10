import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});

const columns = ["Backlog", "Ready", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const FOOTNOTE = "Drag a card to another column, or onto a card to place it before that card. Pomegr moves a card when its session starts, when it needs review, and when it is done. Moving a card never changes its chip. While a session works on a task, the chip is that session's state.";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id - 1, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/** Backlog: T-1, T-2, T-3. Ready: T-4. Done: T-5 (a finished task). */
const tasks = () => [task(1), task(2), task(3), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })];

function setBoard(overrides: Partial<TaskBoard> = {}) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: tasks(), queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, ...overrides };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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

const column = (name: string) => screen.getByRole("region", { name });
const order = (name: string) => [...column(name).querySelectorAll("li[data-task-id]")].map((card) => card.getAttribute("data-task-id"));
const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const alertText = () => screen.queryByRole("alert")?.textContent ?? null;

/** A DataTransfer stand-in: jsdom has none, and the board reads and writes only text/plain, effectAllowed and dropEffect. */
function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "uninitialized", dropEffect: "none", setData: vi.fn((type: string, value: string) => { data.set(type, value); }), getData: (type: string) => data.get(type) ?? "" };
}
type Transfer = ReturnType<typeof transfer>;

/** Leaves `element` for `to`, which jsdom's generic drag events cannot carry as `relatedTarget` by themselves. */
function dragLeave(element: HTMLElement, to: HTMLElement | null) {
  const event = createEvent.dragLeave(element);
  Object.defineProperty(event, "relatedTarget", { value: to });
  fireEvent(element, event);
}

/** Starts a drag of `from` and drops it on `target` (a card or a column section). */
function dragTo(from: string, target: HTMLElement, dataTransfer: Transfer = transfer()) {
  fireEvent.dragStart(card(from), { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  fireEvent.drop(target, { dataTransfer });
}

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("draws no draggable card, move action or footnote, and sends nothing", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Move / })).not.toBeInTheDocument();
    expect(screen.queryByText(FOOTNOTE)).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    dragTo("T-1", column("Ready"));
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("stays read-only for a board shown without edits and in the server pass", () => {
    render(<TaskBoardView board={setBoard()} />);
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toMatch(/draggable|Move T-/);
  });

  it("treats a bridge without taskAction as no bridge", () => {
    setBridge({ getDesktopState: vi.fn() });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(document.querySelector("[draggable]")).toBeNull();
  });
});

describe("dragging a card", () => {
  it("makes every card draggable, with the task ID as a plain-text move payload and no change to the card", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    for (const id of ["T-1", "T-2", "T-3", "T-4", "T-5"]) expect(card(id)).toHaveAttribute("draggable", "true");
    const dataTransfer = transfer();
    const className = card("T-2").className;
    fireEvent.dragStart(card("T-2"), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith("text/plain", "T-2");
    expect(dataTransfer.effectAllowed).toBe("move");
    expect(card("T-2").className).toBe(className);
    expect(screen.getByText(FOOTNOTE)).toHaveClass("taskBoardFootnote");
  });

  it("appends the card to the column it is dropped on", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", { id: "T-1", columnId: "col-2", position: 1 });
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(order("Backlog")).toEqual(["T-2", "T-3"]);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(within(column("Ready")).getByText("2")).toBeInTheDocument();
    expect(within(column("Backlog")).getByText("2")).toBeInTheDocument();
  });

  it("appends to an empty column and within the same column when dropped on the column itself", async () => {
    setBoard({ tasks: [task(1), task(2)], columns });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Done"));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-1", columnId: "col-3", position: 0 });
    expect(order("Done")).toEqual(["T-1"]);
    dragTo("T-2", column("Done"));
    expect(order("Done")).toEqual(["T-1", "T-2"]);
    // The second move waits for the first to be answered, then goes out in order.
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-2", columnId: "col-3", position: 1 });
  });

  it("inserts before the card it is dropped on, across columns", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-4", card("T-2"));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", { id: "T-4", columnId: "col-1", position: 1 });
    expect(order("Backlog")).toEqual(["T-1", "T-4", "T-2", "T-3"]);
    expect(order("Ready")).toEqual([]);
  });

  it("inserts before the card it is dropped on, inside one column, counting after the card is removed", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-3", card("T-1"));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-3", columnId: "col-1", position: 0 });
    expect(order("Backlog")).toEqual(["T-3", "T-1", "T-2"]);
    // Downward: T-3 is first and goes before T-2, which sits at index 1 once T-3 is out of the way.
    dragTo("T-3", card("T-2"));
    expect(order("Backlog")).toEqual(["T-1", "T-3", "T-2"]);
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-3", columnId: "col-1", position: 1 });
  });

  it("sends nothing for a drop that leaves the card where it is", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-2", card("T-2"));
    dragTo("T-1", card("T-2"));
    dragTo("T-3", column("Backlog"));
    dragTo("T-4", column("Ready"));
    expect(taskAction).not.toHaveBeenCalled();
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("ignores text dragged in from elsewhere: no column accepts it and nothing moves", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const foreign = transfer();
    foreign.setData("text/plain", "T-4");
    // A drop is possible only where dragover was cancelled; a drag the board did not start is not.
    expect(fireEvent.dragOver(column("Done"), { dataTransfer: foreign })).toBe(true);
    expect(column("Done")).not.toHaveClass("isDropTarget");
    fireEvent.drop(column("Done"), { dataTransfer: foreign });
    fireEvent.drop(card("T-1"), { dataTransfer: foreign });
    expect(taskAction).not.toHaveBeenCalled();
    expect(order("Done")).toEqual(["T-5"]);
    expect(order("Ready")).toEqual(["T-4"]);
    fireEvent.dragStart(card("T-1"), { dataTransfer: foreign });
    expect(fireEvent.dragOver(column("Done"), { dataTransfer: foreign })).toBe(false);
  });

  it("marks the lane under a dragged card, also over one of its cards, and clears it on leave, drop and drag end", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dataTransfer = transfer();
    fireEvent.dragStart(card("T-1"), { dataTransfer });
    expect(column("Ready")).not.toHaveClass("isDropTarget");
    fireEvent.dragOver(column("Ready"), { dataTransfer });
    expect(column("Ready")).toHaveClass("isDropTarget");
    expect(dataTransfer.dropEffect).toBe("move");
    fireEvent.dragOver(card("T-4"), { dataTransfer });
    expect(column("Ready")).toHaveClass("isDropTarget");
    // Moving from the column onto one of its own cards is not leaving it.
    dragLeave(column("Ready"), card("T-4"));
    expect(column("Ready")).toHaveClass("isDropTarget");
    dragLeave(column("Ready"), column("Done"));
    expect(column("Ready")).not.toHaveClass("isDropTarget");
    fireEvent.dragOver(column("Done"), { dataTransfer });
    expect(column("Done")).toHaveClass("isDropTarget");
    expect(column("Ready")).not.toHaveClass("isDropTarget");
    fireEvent.drop(column("Done"), { dataTransfer });
    expect(column("Done")).not.toHaveClass("isDropTarget");
    fireEvent.dragStart(card("T-2"), { dataTransfer });
    fireEvent.dragOver(column("Ready"), { dataTransfer });
    fireEvent.dragEnd(card("T-2"));
    expect(column("Ready")).not.toHaveClass("isDropTarget");
  });
});

describe("optimistic move", () => {
  it("shows the card in its new place at once, before the monitor answers", async () => {
    const answer = deferred<Result>();
    taskAction.mockReturnValueOnce(answer.promise);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(refresh).not.toHaveBeenCalled();
    expect(alertText()).toBeNull();
    await act(async () => { answer.resolve({ ok: true }); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(alertText()).toBeNull();
  });

  it("rolls the card back to where it was and shows one fixed message when the move fails", async () => {
    const answer = deferred<Result>();
    taskAction.mockReturnValueOnce(answer.promise);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-2", column("Ready"));
    expect(order("Ready")).toEqual(["T-4", "T-2"]);
    await act(async () => { answer.resolve({ ok: false, error: "not_found" }); });
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(order("Ready")).toEqual(["T-4"]);
    expect(alertText()).toBe("The card could not be moved.");
    expect(refresh).not.toHaveBeenCalled();
    // The next action starts clean.
    dragTo("T-1", column("Ready"));
    expect(alertText()).toBeNull();
  });

  it("rolls back when the desktop cannot be reached", async () => {
    taskAction.mockRejectedValueOnce(new Error("ipc"));
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-3", card("T-1"));
    await waitFor(() => expect(alertText()).toBe("The card could not be moved."));
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("sends moves one at a time and takes back every move queued behind one that failed", async () => {
    const first = deferred<Result>();
    taskAction.mockReturnValueOnce(first.promise);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    dragTo("T-2", column("Ready"));
    expect(order("Ready")).toEqual(["T-4", "T-1", "T-2"]);
    expect(taskAction).toHaveBeenCalledTimes(1);
    await act(async () => { first.resolve({ ok: false, error: "conflict" }); });
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(order("Ready")).toEqual(["T-4"]);
    expect(alertText()).toBe("The card could not be moved.");
  });

  it("keeps an earlier acknowledged move when a later one fails", async () => {
    const second = deferred<Result>();
    taskAction.mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(second.promise);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    dragTo("T-2", column("Ready"));
    await act(async () => { second.resolve({ ok: false, error: "invalid" }); });
    expect(taskAction).toHaveBeenCalledTimes(2);
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(order("Backlog")).toEqual(["T-2", "T-3"]);
  });

  it("lets the committed board take over without a visible change once it shows the move", async () => {
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    setBoard({ tasks: [task(1, { columnId: "col-2", position: 1 }), task(2, { position: 0 }), task(3, { position: 1 }), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })] });
    view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(order("Backlog")).toEqual(["T-2", "T-3"]);
    // Later committed changes are shown as they are, not held back by the finished move.
    setBoard({ tasks: [task(1, { position: 0 }), task(2, { position: 1 }), task(3, { position: 2 }), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })] });
    view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("never changes a card's chip, state or text when it moves", async () => {
    setBoard({ tasks: [task(1, { state: "done", text: "Ship the guide" }), task(2, { state: "needs_review", session: { id: "claude:abc", title: "Parser session", state: "working", observedModel: null } }), task(3, { state: "queued" })] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const chips = () => ["T-1", "T-2", "T-3"].map((id) => card(id).querySelector(".commandChip")?.textContent);
    const before = chips();
    expect(before).toEqual(["Done", "Needs review", "Queued"]);
    dragTo("T-1", column("Ready"));
    dragTo("T-2", column("Done"));
    dragTo("T-3", card("T-1"));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(chips()).toEqual(before);
    expect(card("T-1")).toHaveClass("isDone");
    expect(card("T-2")).toHaveClass("isAttention");
    expect(card("T-1")).toHaveAttribute("data-task-state", "done");
    expect(within(column("Ready")).getByText("Ship the guide")).toBeInTheDocument();
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
    for (const [, , payload] of taskAction.mock.calls) expect(Object.keys(payload as object).sort()).toEqual(["columnId", "id", "position"]);
  });
});

describe("keyboard moves", () => {
  const bar = (id: string) => within(screen.getByRole("toolbar", { name: `Move ${id}` }));

  it("gives each card a toolbar of four named actions, disabled where the card cannot go", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const t2 = bar("T-2");
    expect(t2.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Move T-2 up", "Move T-2 down", "Move T-2 to the previous column", "Move T-2 to the next column",
    ]);
    for (const button of t2.getAllByRole("button")) expect(button).toHaveClass("commandIconAction");
    expect(t2.getByRole("button", { name: "Move T-2 up" })).toBeEnabled();
    expect(t2.getByRole("button", { name: "Move T-2 to the previous column" })).toBeDisabled();
    expect(bar("T-1").getByRole("button", { name: "Move T-1 up" })).toBeDisabled();
    expect(bar("T-3").getByRole("button", { name: "Move T-3 down" })).toBeDisabled();
    expect(bar("T-5").getByRole("button", { name: "Move T-5 to the next column" })).toBeDisabled();
    expect(bar("T-4").getByRole("button", { name: "Move T-4 to the previous column" })).toBeEnabled();
    expect(bar("T-4").getByRole("button", { name: "Move T-4 to the next column" })).toBeEnabled();
  });

  it("is reachable by keyboard from the card, with one tab stop and arrow keys inside", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const stops = within(screen.getByRole("toolbar", { name: "Move T-2" })).getAllByRole("button").filter((button) => button.tabIndex === 0);
    expect(stops.map((button) => button.getAttribute("aria-label"))).toEqual(["Move T-2 up"]);
    within(card("T-2")).getByRole("button", { name: "Task text 2" }).focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Move T-2 up" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Move T-2 down" })).toHaveFocus();
    // The disabled previous-column action is skipped, and the ends wrap.
    await user.keyboard("{End}");
    expect(screen.getByRole("button", { name: "Move T-2 to the next column" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Move T-2 up" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Move T-2 to the next column" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("button", { name: "Move T-2 up" })).toHaveFocus();
    // The last control used is the toolbar's tab stop.
    await user.keyboard("{ArrowRight}");
    const used = within(screen.getByRole("toolbar", { name: "Move T-2" })).getAllByRole("button").filter((button) => button.tabIndex === 0);
    expect(used.map((button) => button.getAttribute("aria-label"))).toEqual(["Move T-2 down"]);
  });

  it("moves a card up and down within its column", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-2 up" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-2", columnId: "col-1", position: 0 });
    expect(order("Backlog")).toEqual(["T-2", "T-1", "T-3"]);
    await user.click(screen.getByRole("button", { name: "Move T-1 down" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-1", columnId: "col-1", position: 2 });
    expect(order("Backlog")).toEqual(["T-2", "T-3", "T-1"]);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
  });

  it("moves a card to the previous or next column at the same row, or last when that column is shorter", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-3 to the next column" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-3", columnId: "col-2", position: 1 });
    expect(order("Ready")).toEqual(["T-4", "T-3"]);
    await user.click(screen.getByRole("button", { name: "Move T-4 to the next column" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-4", columnId: "col-3", position: 0 });
    await user.click(screen.getByRole("button", { name: "Move T-3 to the previous column" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "move", { id: "T-3", columnId: "col-1", position: 0 });
    expect(order("Backlog")).toEqual(["T-3", "T-1", "T-2"]);
  });

  it("keeps focus on the control that was used when the card is re-drawn in another column", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-2 to the next column" }));
    expect(order("Ready")).toEqual(["T-4", "T-2"]);
    expect(screen.getByRole("button", { name: "Move T-2 to the next column" })).toHaveFocus();
    // At the top the Up action is gone, so focus falls to the next action that still works.
    await user.click(screen.getByRole("button", { name: "Move T-2 up" }));
    expect(screen.getByRole("button", { name: "Move T-2 down" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("T-2 moved to Ready, position 1.");
  });

  it("puts focus back on the card's control after a failed move re-draws it", async () => {
    taskAction.mockResolvedValueOnce({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-2 to the next column" }));
    await waitFor(() => expect(alertText()).toBe("The card could not be moved."));
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(screen.getByRole("button", { name: "Move T-2 to the next column" })).toHaveFocus();
  });
});

describe("fixed columns", () => {
  it("draws no Add column button and no Edit column control, only each column's name and count", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: /Add column|Edit column|Delete column/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Edit column/ })).not.toBeInTheDocument();
    const headers = [...document.querySelectorAll(".taskColumn")].map((section) => {
      const header = section.querySelector("header")!;
      return [header.querySelector("h3")?.textContent, header.querySelector(".taskColumnCount")?.firstChild?.textContent, header.querySelectorAll("button").length];
    });
    expect(headers).toEqual([["Backlog", "3", 0], ["Ready", "1", 0], ["Done", "1", 0]]);
  });
});

describe("New task in the first lane", () => {
  const add = () => screen.getByRole("button", { name: "New task" });

  it("is a quiet action after the last card of the first lane only, and the header holds no primary action", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.getAllByRole("button", { name: "New task" })).toHaveLength(1);
    const lane = column("Backlog");
    expect(within(lane).getByRole("button", { name: "New task" })).toBe(add());
    expect(add()).toHaveClass("commandQuietAction", "taskColumnAdd");
    expect(add()).toHaveAttribute("aria-haspopup", "dialog");
    expect(add().querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    // After the lane's last card, not before them.
    expect(lane.lastElementChild).toBe(add());
    for (const name of ["Ready", "Done"]) expect(within(column(name)).queryByRole("button", { name: "New task" })).toBeNull();
    expect(document.querySelector(".commandPageHeader .commandPrimaryAction")).toBeNull();
    expect(document.querySelector(".taskHeadActions .commandPrimaryAction")).toBeNull();
  });

  it("is also drawn when the first lane is empty", () => {
    setBoard({ tasks: [task(4, { columnId: "col-2", position: 0, state: "queued" })] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(within(column("Backlog")).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(column("Backlog")).getByRole("button", { name: "New task" })).toBe(add());
  });

  it("opens the New task modal, and focus returns to it when the modal closes", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(add());
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument());
    expect(add()).toHaveFocus();
  });

  it("opens from the keyboard and stays reachable while hidden: it is in the tab order and never removed from the tree", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    add().focus();
    expect(add()).toHaveFocus();
    expect(add().tabIndex).toBe(0);
    expect(add()).not.toHaveAttribute("hidden");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
  });

  it("stays while a feature filter is on, because creating a task is not a move", async () => {
    const user = userEvent.setup();
    setBoard({
      features: [{ id: "feature-1", name: "Upload reliability", done: false }],
      tasks: [task(1, { featureId: "feature-1", step: 1 }), task(2)],
    });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: /^Upload reliability/ }));
    expect(screen.getByText("Moving cards is off while a feature filter is on.")).toBeInTheDocument();
    expect(add()).toBeInTheDocument();
  });

  it("is on the Board only: the Queue view has no lanes, and the Board brings it back", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Board" }));
    expect(add()).toBeInTheDocument();
  });

  it("is not drawn in a board shown without edits or in the server pass", () => {
    render(<TaskBoardView board={setBoard()} />);
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toMatch(/New task/);
  });
});
