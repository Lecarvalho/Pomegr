import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { TASK_BOUNDS, type Task, type TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});

const columns = ["Backlog", "Ready", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const FOOTNOTE = "Drag a card to another column, or onto a card to place it before that card. Columns are yours; moving a card never changes its chip. While a session works on a task, the chip is that session's state.";

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id - 1, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/** Backlog: T-1, T-2, T-3. Ready: T-4. Done: T-5 (a finished task). */
const tasks = () => [task(1), task(2), task(3), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })];

function setBoard(overrides: Partial<TaskBoard> = {}) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: tasks(), queue: { status: "idle", blockedBy: null, order: [] }, ...overrides };
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

  it("draws no draggable card, move action, column control or footnote, and sends nothing", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add column|Edit column|Move / })).not.toBeInTheDocument();
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
    expect(renderToString(<TasksTab repositoryId={repositoryId} />)).not.toMatch(/draggable|Add column|Edit column|Move T-/);
  });

  it("treats a bridge without taskAction as no bridge", () => {
    setBridge({ getDesktopState: vi.fn() });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(document.querySelector("[draggable]")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add column" })).not.toBeInTheDocument();
  });
});

describe("dragging a card", () => {
  it("makes every card draggable, with the task ID as a plain-text move payload and no change to the card", () => {
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    dragTo("T-4", card("T-2"));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "move", { id: "T-4", columnId: "col-1", position: 1 });
    expect(order("Backlog")).toEqual(["T-1", "T-4", "T-2", "T-3"]);
    expect(order("Ready")).toEqual([]);
  });

  it("inserts before the card it is dropped on, inside one column, counting after the card is removed", async () => {
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    dragTo("T-2", card("T-2"));
    dragTo("T-1", card("T-2"));
    dragTo("T-3", column("Backlog"));
    dragTo("T-4", column("Ready"));
    expect(taskAction).not.toHaveBeenCalled();
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("ignores text dragged in from elsewhere: no column accepts it and nothing moves", () => {
    render(<TasksTab repositoryId={repositoryId} />);
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

  it("fills the column under a dragged card, also over one of its cards, and clears it on leave, drop and drag end", () => {
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    dragTo("T-3", card("T-1"));
    await waitFor(() => expect(alertText()).toBe("The card could not be moved."));
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("sends moves one at a time and takes back every move queued behind one that failed", async () => {
    const first = deferred<Result>();
    taskAction.mockReturnValueOnce(first.promise);
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    dragTo("T-2", column("Ready"));
    await act(async () => { second.resolve({ ok: false, error: "invalid" }); });
    expect(taskAction).toHaveBeenCalledTimes(2);
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(order("Backlog")).toEqual(["T-2", "T-3"]);
  });

  it("lets the committed board take over without a visible change once it shows the move", async () => {
    const view = render(<TasksTab repositoryId={repositoryId} />);
    dragTo("T-1", column("Ready"));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    setBoard({ tasks: [task(1, { columnId: "col-2", position: 1 }), task(2, { position: 0 }), task(3, { position: 1 }), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })] });
    view.rerender(<TasksTab repositoryId={repositoryId} />);
    expect(order("Ready")).toEqual(["T-4", "T-1"]);
    expect(order("Backlog")).toEqual(["T-2", "T-3"]);
    // Later committed changes are shown as they are, not held back by the finished move.
    setBoard({ tasks: [task(1, { position: 0 }), task(2, { position: 1 }), task(3, { position: 2 }), task(4, { columnId: "col-2", position: 0, state: "queued" }), task(5, { columnId: "col-3", position: 0, state: "done" })] });
    view.rerender(<TasksTab repositoryId={repositoryId} />);
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
  });

  it("never changes a card's chip, state or text when it moves", async () => {
    setBoard({ tasks: [task(1, { state: "done", text: "Ship the guide" }), task(2, { state: "needs_review", session: { id: "claude:abc", title: "Parser session", state: "working", observedModel: null } }), task(3, { state: "queued" })] });
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
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
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Move T-2 to the next column" }));
    await waitFor(() => expect(alertText()).toBe("The card could not be moved."));
    expect(order("Backlog")).toEqual(["T-1", "T-2", "T-3"]);
    expect(screen.getByRole("button", { name: "Move T-2 to the next column" })).toHaveFocus();
  });
});

describe("managing columns", () => {
  const edit = (name: string) => screen.getByRole("button", { name: `Edit column ${name}` });
  async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(edit(name));
    return within(screen.getByRole("group", { name: `Edit column ${name}` }));
  }

  it("draws Add column as a Secondary action and Edit column controls only in the desktop app", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.getByRole("button", { name: "Add column" })).toHaveClass("commandSecondaryAction");
    expect(screen.getByRole("button", { name: "New task" })).toHaveClass("commandPrimaryAction");
    for (const { name } of columns) expect(edit(name)).toHaveClass("commandIconAction");
    expect(edit("Backlog")).toHaveAttribute("aria-expanded", "false");
  });

  it("adds a column by name, appended last", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Add column" }));
    const input = screen.getByRole("textbox", { name: "Column name" });
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", String(TASK_BOUNDS.columnNameLength));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();
    await user.type(input, "  Blocked  ");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "column_create", { name: "Blocked" });
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Column name" })).not.toBeInTheDocument());
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Add column" })).toHaveFocus();
    expect(alertText()).toBeNull();
  });

  it("submits with Enter, cancels with Escape or Cancel, and keeps the form when the add fails", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.type(screen.getByRole("textbox", { name: "Column name" }), "Later{Escape}");
    expect(screen.queryByRole("textbox", { name: "Column name" })).not.toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add column" }));
    expect((screen.getByRole("textbox", { name: "Column name" }) as HTMLInputElement).value).toBe("");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: "Column name" })).not.toBeInTheDocument();
    taskAction.mockResolvedValueOnce({ ok: false, error: "invalid" });
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.type(screen.getByRole("textbox", { name: "Column name" }), "Later{Enter}");
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "column_create", { name: "Later" });
    await waitFor(() => expect(alertText()).toBe("The column could not be added."));
    expect((screen.getByRole("textbox", { name: "Column name" }) as HTMLInputElement).value).toBe("Later");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("makes Add column unavailable at twelve columns and says why", () => {
    const many = Array.from({ length: TASK_BOUNDS.columnsPerRepository }, (_, position) => ({ id: `col-${position + 1}`, name: `Column ${position + 1}`, position }));
    setBoard({ columns: many, tasks: [] });
    render(<TasksTab repositoryId={repositoryId} />);
    const add = screen.getByRole("button", { name: "Add column" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("The board holds 12 columns, the most it allows.");
  });

  it("says the board is full when the monitor answers limit", async () => {
    taskAction.mockResolvedValueOnce({ ok: false, error: "limit" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Add column" }));
    await user.type(screen.getByRole("textbox", { name: "Column name" }), "One more{Enter}");
    await waitFor(() => expect(alertText()).toBe("The board is full: it holds 12 columns."));
  });

  it("renames a column on Enter and on blur, once", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    let editor = await openEditor(user, "Ready");
    const input = editor.getByRole("textbox", { name: "Column name" });
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).value).toBe("Ready");
    expect(input).toHaveAttribute("maxlength", "40");
    await user.clear(input);
    await user.type(input, " Up next {Enter}");
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "column_rename", { id: "col-2", name: "Up next" });
    await user.click(screen.getByRole("heading", { name: "Backlog" }));
    expect(taskAction).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    editor = within(screen.getByRole("group", { name: "Edit column Ready" }));
    await user.clear(editor.getByRole("textbox", { name: "Column name" }));
    await user.type(editor.getByRole("textbox", { name: "Column name" }), "Next");
    await user.click(screen.getByRole("heading", { name: "Backlog" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "column_rename", { id: "col-2", name: "Next" });
  });

  it("refuses an empty name and discards a draft on Escape, sending nothing", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const editor = await openEditor(user, "Ready");
    const input = editor.getByRole("textbox", { name: "Column name" }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "   {Enter}");
    expect(alertText()).toBe("The column needs a name.");
    expect(input.value).toBe("Ready");
    await user.type(input, " later{Escape}");
    expect(screen.queryByRole("group", { name: "Edit column Ready" })).not.toBeInTheDocument();
    expect(edit("Ready")).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
    await user.click(edit("Ready"));
    expect((screen.getByRole("textbox", { name: "Column name" }) as HTMLInputElement).value).toBe("Ready");
  });

  it("restores the name and shows one fixed message when a rename fails", async () => {
    taskAction.mockResolvedValueOnce({ ok: false, error: "invalid" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const editor = await openEditor(user, "Ready");
    const input = editor.getByRole("textbox", { name: "Column name" }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Taken{Enter}");
    await waitFor(() => expect(alertText()).toBe("The column could not be renamed."));
    expect(input.value).toBe("Ready");
    expect(screen.getByRole("heading", { name: "Ready" })).toBeInTheDocument();
  });

  it("moves a column left or right and disables the moves at either end", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const backlog = await openEditor(user, "Backlog");
    expect(backlog.getByRole("button", { name: "Move Backlog left" })).toBeDisabled();
    await user.click(backlog.getByRole("button", { name: "Move Backlog right" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "column_reorder", { id: "col-1", position: 1 });
    const ready = await openEditor(user, "Ready");
    await user.click(ready.getByRole("button", { name: "Move Ready left" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "column_reorder", { id: "col-2", position: 0 });
    const done = await openEditor(user, "Done");
    expect(done.getByRole("button", { name: "Move Done right" })).toBeDisabled();
    await user.click(done.getByRole("button", { name: "Move Done left" }));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "column_reorder", { id: "col-3", position: 1 });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(3));
    expect(alertText()).toBeNull();
  });

  it("offers delete but keeps it unavailable while the column holds tasks, with the reason", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const backlog = await openEditor(user, "Backlog");
    const remove = backlog.getByRole("button", { name: "Delete column Backlog" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription("A column must be empty to be deleted.");
    await user.click(remove);
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("deletes an empty column, and an emptied column once its last card has moved out", async () => {
    setBoard({ tasks: [task(1)] });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const ready = await openEditor(user, "Ready");
    await user.click(ready.getByRole("button", { name: "Delete column Ready" }));
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "column_delete", { id: "col-2" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("region", { name: "Task board" })).toHaveFocus();
    // Backlog holds T-1 until it is moved out; the optimistic board then offers the delete.
    await user.click(screen.getByRole("button", { name: "Move T-1 to the next column" }));
    const backlog = await openEditor(user, "Backlog");
    expect(backlog.getByRole("button", { name: "Delete column Backlog" })).toBeEnabled();
  });

  it("shows one fixed message when the monitor refuses a delete", async () => {
    setBoard({ tasks: [] });
    taskAction.mockResolvedValueOnce({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const done = await openEditor(user, "Done");
    await user.click(done.getByRole("button", { name: "Delete column Done" }));
    await waitFor(() => expect(alertText()).toBe("The column could not be deleted. It must be empty, and a board keeps one column."));
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Done" })).toBeInTheDocument();
  });

  it("never offers to delete the last column", async () => {
    setBoard({ columns: [columns[0]], tasks: [] });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const only = await openEditor(user, "Backlog");
    const remove = only.getByRole("button", { name: "Delete column Backlog" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAccessibleDescription("A board keeps at least one column.");
    expect(only.getByRole("button", { name: "Move Backlog left" })).toBeDisabled();
    expect(only.getByRole("button", { name: "Move Backlog right" })).toBeDisabled();
  });

  it("keeps focus on the used move control when the column is re-drawn in its new place", async () => {
    const user = userEvent.setup();
    const view = render(<TasksTab repositoryId={repositoryId} />);
    // The monitor's committed board lists Ready first by the time the refresh resolves.
    refresh.mockImplementationOnce(async () => {
      setBoard({ columns: [{ id: "col-2", name: "Ready", position: 0 }, { id: "col-1", name: "Backlog", position: 1 }, columns[2]] });
      view.rerender(<TasksTab repositoryId={repositoryId} />);
    });
    const ready = await openEditor(user, "Ready");
    await user.click(ready.getByRole("button", { name: "Move Ready left" }));
    await waitFor(() => expect([...document.querySelectorAll(".taskColumn h3")].map((heading) => heading.textContent)).toEqual(["Ready", "Backlog", "Done"]));
    // Left is now unavailable for Ready, so focus falls to the control that still works.
    await waitFor(() => expect(screen.getByRole("button", { name: "Move Ready right" })).toHaveFocus());
    expect(screen.getByRole("group", { name: "Edit column Ready" })).toBeInTheDocument();
  });
});
