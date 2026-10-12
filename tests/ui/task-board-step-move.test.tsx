import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { boardStepChoices, isBoardStepTask, queueFeatures } from "../../app/components/tasks/task-queue-model";
import type { TaskBoardEdits } from "../../app/components/tasks/use-task-board-edits";

const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position, role: null }));
const features = [{ id: "f1", name: "Tasks adjustments", done: false }, { id: "f2", name: "Aril chat polish", done: false }];

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task ${id}`, columnId: "col-2", position: id, featureId: null, step: null,
    run: { provider: "claude", model: "model-large", effort: "high" }, completeWhen: { checks: ["pr_open"], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const session = { id: "claude:s", title: null, state: "working", observedModel: null };

/**
 * f1: step 1 is done (T-50), step 2 runs (T-55), step 3 waits in Ready (T-59, T-60), step 4 waits (T-63), step 5 is
 * not queued in Backlog (T-80). f2: step 1 waits in Ready (T-64). T-71 is a single task.
 */
const tasks = (): Task[] => [
  task(50, { featureId: "f1", step: 1, columnId: "col-5", state: "done", session }),
  task(55, { featureId: "f1", step: 2, columnId: "col-3", session }),
  task(59, { featureId: "f1", step: 3, position: 0 }),
  task(60, { featureId: "f1", step: 3, position: 1 }),
  task(63, { featureId: "f1", step: 4, position: 2 }),
  task(64, { featureId: "f2", step: 1, position: 3 }),
  task(71, { position: 4 }),
  task(80, { featureId: "f1", step: 5, columnId: "col-1", state: "not_queued" }),
];

function board(): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId: "repo-0123456789abcdef01234567", columns, features, tasks: tasks(),
    queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-59", "T-60", "T-63", "T-64", "T-71"] } };
}

const reorderQueueTask = vi.fn(async () => true);
const moveTask = vi.fn(async () => true);
function edits(value: TaskBoard): TaskBoardEdits {
  const none = async () => false;
  return { board: value, failure: null, busy: false, settled: 0, moveTask, addFeature: none, reorderQueueTask, setQueue: none, setGateThreshold: none, setQueueSchedule: none, resolveTask: none };
}
function renderBoard() {
  const value = board();
  return render(<TaskBoardView board={value} edits={edits(value)} />);
}

const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const lane = () => screen.getByRole("region", { name: "Ready" }) as HTMLElement;
const group = (feature: string, step: number) => lane().querySelector(`.taskReadyGroup[data-step-feature="${feature}"][data-step="${step}"]`) as HTMLElement;
const zone = () => lane().querySelector<HTMLElement>(".taskReadyNewStep");
const transfer = () => ({ effectAllowed: "uninitialized", dropEffect: "none", setData: vi.fn(), getData: () => "" });

/** A drag event at height `clientY`, which jsdom's generic drag events cannot carry by themselves. */
function dragAt(kind: "dragOver" | "drop", element: HTMLElement, clientY: number) {
  const event = createEvent[kind](element, { dataTransfer: transfer() });
  Object.defineProperty(event, "clientY", { value: clientY });
  fireEvent(element, event);
}
/** Lays the Ready groups out 100px tall with an 8px gap, as jsdom measures nothing. */
function layOut() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = [...lane().querySelectorAll(".taskColumnList > li:not(.taskReadyNewStep)")].indexOf(this);
    const top = index < 0 ? 0 : index * 108;
    return { top, bottom: top + 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: top, toJSON: () => ({}) };
  });
}

afterEach(() => { vi.restoreAllMocks(); reorderQueueTask.mockClear(); moveTask.mockClear(); });

describe("the Board's step choices", () => {
  const value = board();
  const panel = queueFeatures(value)[0];
  const find = (id: string) => value.tasks.find((candidate) => candidate.id === id) as Task;

  it("lists each unfinished step but the task's own, a running step disabled, then the new last step", () => {
    expect(boardStepChoices(panel, find("T-63"))).toEqual([
      { step: 2, label: "Step 2 · running", disabled: true },
      { step: 3, label: "Step 3 · parallel with T-59, T-60" },
      { step: 5, label: "Step 5 · parallel with T-80" },
      { step: 6, label: "New last step" },
    ]);
  });

  it("gives a step only to a waiting card of a feature", () => {
    expect(isBoardStepTask(find("T-59"))).toBe(true);
    expect(isBoardStepTask(find("T-71"))).toBe(false);
    expect(isBoardStepTask(find("T-80"))).toBe(false);
    expect(isBoardStepTask(find("T-55"))).toBe(false);
  });
});

describe("dropping a card on a step", () => {
  it("marks a step group of the card's feature and sends the step action on drop", () => {
    renderBoard();
    fireEvent.dragStart(card("T-63"), { dataTransfer: transfer() });
    fireEvent.dragOver(card("T-59"), { dataTransfer: transfer() });
    expect(group("f1", 3)).toHaveClass("isStepTarget");
    expect(document.querySelector(".isDropBefore, .isDropAfter")).toBeNull();
    fireEvent.drop(card("T-59"), { dataTransfer: transfer() });
    expect(reorderQueueTask).toHaveBeenCalledWith("T-63", 3);
    expect(moveTask).not.toHaveBeenCalled();
    expect(group("f1", 3)).not.toHaveClass("isStepTarget");
    expect(screen.getByRole("status")).toHaveTextContent("T-63 moved to step 3.");
  });

  it("offers no step of another feature, none to a single task, and not the card's own step", () => {
    renderBoard();
    fireEvent.dragStart(card("T-63"), { dataTransfer: transfer() });
    fireEvent.dragOver(card("T-64"), { dataTransfer: transfer() });
    expect(group("f2", 1)).not.toHaveClass("isStepTarget");
    fireEvent.dragOver(card("T-63"), { dataTransfer: transfer() });
    expect(group("f1", 4)).not.toHaveClass("isStepTarget");
    fireEvent.drop(card("T-64"), { dataTransfer: transfer() });
    fireEvent.dragStart(card("T-71"), { dataTransfer: transfer() });
    fireEvent.dragOver(card("T-59"), { dataTransfer: transfer() });
    expect(group("f1", 3)).not.toHaveClass("isStepTarget");
    fireEvent.drop(card("T-59"), { dataTransfer: transfer() });
    expect(reorderQueueTask).not.toHaveBeenCalled();
  });

  it("draws the new-step zone only over the gap after the feature's last step, and a drop there adds a last step", () => {
    renderBoard();
    layOut();
    const list = lane().querySelector(".taskColumnList") as HTMLElement;
    fireEvent.dragStart(card("T-59"), { dataTransfer: transfer() });
    expect(zone()).toBeNull();
    // Groups: f1 step 3 at 0-100, f1 step 4 at 108-208, f2 step 1 at 216-316.
    dragAt("dragOver", list, 104);
    expect(zone()).toBeNull();
    dragAt("dragOver", list, 212);
    expect(zone()).toHaveTextContent("New step 6 · after step 5");
    expect(zone()?.previousElementSibling).toBe(group("f1", 4));
    expect(within(zone() as HTMLElement).getByRole("group", { name: "New step" })).toBeInTheDocument();
    dragAt("dragOver", list, 320);
    expect(zone()).toBeNull();
    dragAt("dragOver", list, 212);
    fireEvent.drop(zone() as HTMLElement, { dataTransfer: transfer() });
    expect(reorderQueueTask).toHaveBeenCalledWith("T-59", 6);
    expect(zone()).toBeNull();
  });
});

describe("Move to step in the move toolbar", () => {
  it("sends the step action for a card that is not queued", () => {
    renderBoard();
    const select = within(card("T-80")).getByRole("combobox", { name: "Move T-80 to step" });
    chooseCommandOption(select, "Step 3 · parallel with T-59, T-60");
    expect(reorderQueueTask).toHaveBeenCalledWith("T-80", 3);
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("follows the four arrows for a card of a feature that has not started, queued or not", () => {
    renderBoard();
    const bar = within(card("T-63")).getByRole("toolbar", { name: "Move T-63" });
    const select = within(bar).getByRole("combobox", { name: "Move T-63 to step" });
    expect(select).toHaveTextContent("Move to step…");
    expect(select.closest(".commandSelect")).toHaveClass("taskMoveStep");
    expect(select.closest(".commandSelect")?.previousElementSibling).toHaveAttribute("data-move", "right");
    for (const id of ["T-71", "T-55"]) expect(within(card(id)).queryByRole("combobox")).toBeNull();
    // A card that is not queued but has a feature and no session takes a step too, from the Backlog.
    expect(within(card("T-80")).getByRole("combobox", { name: "Move T-80 to step" })).toBeInTheDocument();
  });

  it("lists the steps, leaves a running step disabled, and sends the step action", () => {
    renderBoard();
    const select = within(card("T-63")).getByRole("combobox", { name: "Move T-63 to step" });
    fireEvent.click(select);
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(["Step 2 · running", "Step 3 · parallel with T-59, T-60", "Step 5 · parallel with T-80", "New last step"]);
    expect(options[0]).toHaveAttribute("aria-disabled", "true");
    expect(options[1]).not.toHaveAttribute("aria-disabled");
    fireEvent.click(options[0]);
    expect(reorderQueueTask).not.toHaveBeenCalled();
    chooseCommandOption(select, "Step 3 · parallel with T-59, T-60");
    expect(reorderQueueTask).toHaveBeenCalledWith("T-63", 3);
  });

  it("keeps the arrow keys of an open list out of the toolbar", () => {
    renderBoard();
    const select = within(card("T-63")).getByRole("combobox", { name: "Move T-63 to step" });
    select.focus();
    fireEvent.keyDown(select, { key: "ArrowDown" });
    expect(select).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(select, { key: "ArrowLeft" });
    expect(select).toHaveFocus();
    fireEvent.keyDown(select, { key: "Escape" });
    fireEvent.keyDown(select, { key: "ArrowLeft" });
    expect(within(card("T-63")).getByRole("button", { name: "Move T-63 to the next column" })).toBeDisabled();
    expect(document.activeElement).toHaveAttribute("data-move");
  });

  it("offers no step move while a feature filter is on", () => {
    renderBoard();
    chooseCommandOption(screen.getByRole("combobox", { name: "Feature" }), "f1");
    expect(within(card("T-63")).queryByRole("combobox")).toBeNull();
    fireEvent.dragStart(card("T-63"), { dataTransfer: transfer() });
    fireEvent.dragOver(card("T-59"), { dataTransfer: transfer() });
    expect(group("f1", 3)).not.toHaveClass("isStepTarget");
  });
});
