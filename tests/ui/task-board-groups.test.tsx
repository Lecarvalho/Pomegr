import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { TaskBoard } from "../../shared/task-contract";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { GROUP_A, GROUP_B, board, edits, withReady } from "./task-group-fixtures";

const lane = (name: string) => screen.getByRole("region", { name }) as HTMLElement;
const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const frame = (group: string) => document.querySelector(`[data-ready-group="${group}"]`) as HTMLElement;
const links = () => [...document.querySelectorAll<HTMLElement>("[data-ready-link]")].map((item) => item.getAttribute("data-ready-link"));
const status = () => screen.getAllByRole("status").map((item) => item.textContent).join(" ");

function open(value: TaskBoard = board(), props: { featureSelection?: { id: string } } = {}) {
  const actions = edits(value);
  render(<TaskBoardView board={value} edits={actions} {...props} />);
  return actions;
}

describe("Run in parallel", () => {
  it("is drawn between adjacent waiting cards and groups, and not next to a card that does not wait", () => {
    open();
    expect(links()).toEqual(["T-1 T-2 T-4", "T-4 T-5", "T-6 T-8 T-9"]);
    const link = screen.getAllByRole("button", { name: /in parallel$/ })[1];
    expect(link).toHaveTextContent("Run in parallel");
    expect(link).toHaveAccessibleName("Run T-4 and T-5 in parallel");
    expect(link).toHaveClass("commandQuietAction", "taskReadyLinkAction");
    expect(link.closest("li")).toHaveClass("taskReadyLink");
    // T-5 / T-7 and T-7 / T-6 sit next to a card that does not wait.
    expect(card("T-7").previousElementSibling).not.toHaveClass("taskReadyLink");
    expect(card("T-7").nextElementSibling).not.toHaveClass("taskReadyLink");
  });

  it("is drawn neither without edits nor while a feature filter is on", () => {
    const view = render(<TaskBoardView board={board()} />);
    expect(document.querySelector(".taskReadyLink")).toBeNull();
    view.unmount();
    open(board(), { featureSelection: { id: "f1" } });
    expect(document.querySelector(".taskReadyLink, .taskReadyUngroup, [data-group-move], .taskMoveLeave, [draggable]")).toBeNull();
  });

  it("groups the cards on both sides, in lane order, and announces it", async () => {
    const actions = open();
    await userEvent.click(screen.getAllByRole("button", { name: /in parallel$/ })[1]);
    expect(actions.groupTasks).toHaveBeenCalledWith(["T-4", "T-5"]);
    expect(status()).toContain("T-4 and T-5 run in parallel.");
    await userEvent.click(screen.getByRole("button", { name: "Run T-1, T-2, and T-4 in parallel" }));
    expect(actions.groupTasks).toHaveBeenLastCalledWith(["T-1", "T-2", "T-4"]);
    await userEvent.click(screen.getByRole("button", { name: "Run T-6, T-8, and T-9 in parallel" }));
    expect(actions.groupTasks).toHaveBeenLastCalledWith(["T-6", "T-8", "T-9"]);
    expect(actions.moveTask).not.toHaveBeenCalled();
  });
});

describe("a group's actions", () => {
  it("shows the caption, one toolbar with two arrows and Ungroup, and no step text", () => {
    open();
    const group = frame(GROUP_A);
    expect(group.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 2 · T-3 started");
    const toolbar = within(group).getByRole("toolbar", { name: "Parallel group of T-1 and T-2" });
    expect([...toolbar.querySelectorAll("[data-group-move]")].map((item) => item.getAttribute("data-group-move"))).toEqual(["up", "down"]);
    expect(within(toolbar).getByRole("button", { name: "Ungroup" })).toHaveClass("commandQuietAction", "taskReadyUngroup");
    for (const word of ["Step", "Move to step", "Single tasks", "One at a time"]) expect(document.body.textContent, word).not.toContain(word);
  });

  it("ungroups every waiting member", async () => {
    const actions = open();
    await userEvent.click(within(frame(GROUP_A)).getByRole("button", { name: "Ungroup" }));
    expect(actions.ungroupTasks).toHaveBeenCalledWith(["T-1", "T-2"]);
    expect(status()).toContain("T-1 and T-2 no longer run in parallel.");
    await userEvent.click(within(frame(GROUP_B)).getByRole("button", { name: "Ungroup" }));
    expect(actions.ungroupTasks).toHaveBeenLastCalledWith(["T-8", "T-9"]);
  });

  it("takes one card out of its group, and offers that on a waiting member only", async () => {
    const actions = open();
    const out = within(card("T-2")).getByRole("button", { name: "Take T-2 out of its parallel group" });
    expect(out).toHaveTextContent("Take out of group");
    expect(out).toHaveClass("commandQuietAction", "taskMoveLeave");
    await userEvent.click(out);
    expect(actions.ungroupTasks).toHaveBeenCalledWith(["T-2"]);
    expect(status()).toContain("T-2 taken out of its parallel group.");
    expect(within(card("T-4")).queryByRole("button", { name: /out of its parallel group/ })).not.toBeInTheDocument();
    // T-3 started: it is in the group, but it no longer waits.
    expect(within(card("T-3")).queryByRole("button", { name: /out of its parallel group/ })).not.toBeInTheDocument();
  });

  it("moves the group as one block past a card, with the position counted after the block leaves", async () => {
    const actions = open();
    const first = within(frame(GROUP_A));
    expect(first.getByRole("button", { name: "Move the group up" })).toBeDisabled();
    await userEvent.click(first.getByRole("button", { name: "Move the group down" }));
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-1", columnId: "col-2", position: 1, group: "block" });
    expect(status()).toContain("The parallel group of T-1 and T-2 moved down.");
    const last = within(frame(GROUP_B));
    expect(last.getByRole("button", { name: "Move the group down" })).toBeDisabled();
    await userEvent.click(last.getByRole("button", { name: "Move the group up" }));
    // T-6 is the card above the group; the lane holds 8 cards and the group starts at index 6.
    expect(actions.moveTask).toHaveBeenLastCalledWith({ id: "T-8", columnId: "col-2", position: 5, group: "block" });
  });

  it("moves the group past another group by that group's size", async () => {
    const actions = open(withReady(["T-1", "T-2", "T-8", "T-9", "T-4", "T-5", "T-7", "T-6"]));
    await userEvent.click(within(frame(GROUP_A)).getByRole("button", { name: "Move the group down" }));
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-1", columnId: "col-2", position: 2, group: "block" });
    await userEvent.click(within(frame(GROUP_B)).getByRole("button", { name: "Move the group up" }));
    expect(actions.moveTask).toHaveBeenLastCalledWith({ id: "T-8", columnId: "col-2", position: 0, group: "block" });
    expect(status()).toContain("The parallel group of T-8 and T-9 moved up.");
  });
});

/** A DataTransfer stand-in: jsdom has none. */
function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "uninitialized", dropEffect: "none", setData: (type: string, value: string) => { data.set(type, value); }, getData: (type: string) => data.get(type) ?? "" };
}

/** Starts a drag on `source` and moves over `target`; `drop` ends it there. */
function drag(source: HTMLElement, target: HTMLElement) {
  const dataTransfer = transfer();
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer });
  return { drop: () => fireEvent.drop(target, { dataTransfer }), end: () => fireEvent.dragEnd(source, { dataTransfer }) };
}
const dropLines = () => document.querySelectorAll(".isDropBefore, .isDropAfter");

describe("dragging in Ready", () => {
  it("joins a group by dropping a waiting card on its frame, with the join class and no drop line", () => {
    const actions = open();
    const move = drag(card("T-5"), frame(GROUP_B));
    expect(frame(GROUP_B)).toHaveClass("isJoinTarget");
    expect(dropLines()).toHaveLength(0);
    move.drop();
    expect(actions.groupTasks).toHaveBeenCalledWith(["T-8", "T-5"]);
    expect(actions.moveTask).not.toHaveBeenCalled();
    expect(frame(GROUP_B)).not.toHaveClass("isJoinTarget");
    expect(status()).toContain("T-8 and T-5 run in parallel.");
  });

  it("joins from a drop on a card inside the frame, and from a member of another group", () => {
    const actions = open();
    drag(card("T-4"), card("T-9")).drop();
    expect(actions.groupTasks).toHaveBeenLastCalledWith(["T-8", "T-4"]);
    drag(card("T-2"), frame(GROUP_B)).drop();
    expect(actions.groupTasks).toHaveBeenLastCalledWith(["T-8", "T-2"]);
  });

  it("clears the join target when the drag ends or leaves, and sends nothing", () => {
    const actions = open();
    const move = drag(card("T-5"), frame(GROUP_B));
    expect(frame(GROUP_B)).toHaveClass("isJoinTarget");
    move.end();
    const leave = createEvent.dragLeave(lane("Ready"));
    Object.defineProperty(leave, "relatedTarget", { value: null });
    fireEvent(lane("Ready"), leave);
    expect(frame(GROUP_B)).not.toHaveClass("isJoinTarget");
    expect(actions.groupTasks).not.toHaveBeenCalled();
    expect(actions.moveTask).not.toHaveBeenCalled();
  });

  it("takes a member out when it is dropped outside its frame, also when its place in the lane stays", () => {
    const actions = open();
    // Dropped before T-4, T-2 would stay second in the lane.
    const move = drag(card("T-2"), card("T-4"));
    expect(frame(GROUP_A)).not.toHaveClass("isJoinTarget");
    move.drop();
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-2", columnId: "col-2", position: 1, group: "leave" });
    expect(actions.groupTasks).not.toHaveBeenCalled();
  });

  it("takes a member out to another place in the lane", () => {
    const actions = open();
    drag(card("T-1"), card("T-6")).drop();
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-1", columnId: "col-2", position: 4, group: "leave" });
  });

  it("makes a plain move of a member dropped inside its own frame", () => {
    const actions = open();
    drag(card("T-2"), card("T-1")).drop();
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-2", columnId: "col-2", position: 0 });
    expect(actions.groupTasks).not.toHaveBeenCalled();
  });

  it("moves the whole block when the frame itself is dragged", () => {
    const actions = open();
    expect(frame(GROUP_A)).toHaveAttribute("draggable", "true");
    drag(frame(GROUP_A), card("T-5")).drop();
    expect(actions.moveTask).toHaveBeenCalledWith({ id: "T-1", columnId: "col-2", position: 1, group: "block" });
    drag(frame(GROUP_B), card("T-4")).drop();
    expect(actions.moveTask).toHaveBeenLastCalledWith({ id: "T-8", columnId: "col-2", position: 2, group: "block" });
  });

  it("does nothing when the frame is dropped back on its own cards", () => {
    const actions = open();
    drag(frame(GROUP_A), card("T-2")).drop();
    expect(actions.moveTask).not.toHaveBeenCalled();
    expect(actions.groupTasks).not.toHaveBeenCalled();
  });

  it("never joins a frame to another frame: a dragged group is a block move", () => {
    const actions = open();
    const move = drag(frame(GROUP_B), frame(GROUP_A));
    expect(frame(GROUP_A)).not.toHaveClass("isJoinTarget");
    move.drop();
    expect(actions.groupTasks).not.toHaveBeenCalled();
  });

  it("never joins a card that does not wait: not queued in Ready, or already started", () => {
    const actions = open();
    const notQueued = drag(card("T-7"), frame(GROUP_B));
    expect(frame(GROUP_B)).not.toHaveClass("isJoinTarget");
    notQueued.drop();
    expect(actions.groupTasks).not.toHaveBeenCalled();
    expect(actions.moveTask).toHaveBeenLastCalledWith({ id: "T-7", columnId: "col-2", position: 7 });
    const started = drag(card("T-3"), frame(GROUP_B));
    expect(frame(GROUP_B)).not.toHaveClass("isJoinTarget");
    started.drop();
    expect(actions.groupTasks).not.toHaveBeenCalled();
  });

  it("draws a drop line for a plain move and none for a join", () => {
    open();
    drag(card("T-5"), card("T-4"));
    expect(card("T-4")).toHaveClass("isDropBefore");
    expect(document.querySelector(".isJoinTarget")).toBeNull();
  });

  it("reads the footnote about running cards together", () => {
    open();
    expect(screen.getByText(/To run cards together, choose Run in parallel between them or drop a card on a group\./)).toHaveClass("taskBoardFootnote");
  });
});
