import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { TaskAfterField } from "../../app/components/tasks/TaskAfterField";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { AFTER_HELPER, AFTER_LOOP_MESSAGE, afterCandidates, afterCardLine, afterMakesLoop, afterStartLine, unfinishedAfter } from "../../app/components/tasks/task-after-model";
import { waitCardLine, waitDetail } from "../../app/components/tasks/task-wait-model";
import { columns, edits, repositoryId, task } from "./task-group-fixtures";

// Runs after and planning before Ready (T-101): the card line, the modal field, the wait wording, and the Backlog plan.

const PLAN = "grp-cccccccccccc";
const because = (reason: "runs_after", taskIds: string[]) => ({ reason, taskIds, more: 0 });

function planBoard(): TaskBoard {
  const tasks: Task[] = [
    task(12, { columnId: "col-1", state: "not_queued", position: 0 }),
    task(13, { columnId: "col-1", state: "not_queued", group: PLAN, position: 1 }),
    task(14, { columnId: "col-1", state: "not_queued", group: PLAN, position: 2 }),
    task(15, { columnId: "col-1", state: "not_queued", after: ["T-13", "T-14"], position: 3 }),
    task(9, { after: ["T-21"], position: 0 }),
    task(10, { position: 1 }),
    task(21, { columnId: "col-3", position: 0, session: { id: "claude:s", title: null, state: "working", observedModel: null } }),
    task(22, { columnId: "col-5", position: 0, state: "done" }),
  ];
  return {
    version: 1, readiness: "ready", repositoryId, columns, features: [], tasks,
    queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-10"], waits: [
      { taskId: "T-9", place: null, reasons: [because("runs_after", ["T-21"])] },
      { taskId: "T-10", place: 1, reasons: [] },
    ] },
  };
}

const card = (id: string) => document.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
const frame = () => document.querySelector(`[data-ready-group="${PLAN}"]`) as HTMLElement;

describe("the model", () => {
  const tasks = planBoard().tasks;
  it("names only the tasks that are on the board and not Done", () => {
    expect(unfinishedAfter({ after: ["T-13", "T-22", "T-99"] }, tasks)).toEqual(["T-13"]);
    expect(afterCardLine(tasks.find((entry) => entry.id === "T-15")!, tasks)).toBe("Runs after T-13 and T-14");
    expect(afterCardLine({ id: "T-1", state: "not_queued", after: ["T-22"] }, tasks)).toBeNull();
    expect(afterStartLine(["T-13"])).toBe("It runs after T-13, which is not done, so it cannot start yet.");
    expect(afterStartLine([])).toBeNull();
  });

  it("finds a loop, direct or through other tasks", () => {
    expect(afterMakesLoop(tasks, "T-13", ["T-15"])).toBe(true);
    expect(afterMakesLoop([...tasks, task(16, { after: ["T-15"] })], "T-13", ["T-16"])).toBe(true);
    expect(afterMakesLoop(tasks, "T-13", ["T-12"])).toBe(false);
  });

  it("offers every other open task that is not listed yet, by number", () => {
    expect(afterCandidates(tasks, tasks.find((entry) => entry.id === "T-15")!).map((entry) => entry.id)).toEqual(["T-9", "T-10", "T-12", "T-21"]);
  });

  it("words the wait on the card and in the modal", () => {
    const { queue } = planBoard();
    const t9 = planBoard().tasks.find((entry) => entry.id === "T-9")!;
    expect(waitCardLine(queue, t9)).toBe("Waiting: runs after T-21, which is not done");
    expect(waitDetail(queue, t9)).toEqual({ place: "Not in the start order yet", lines: ["It runs after T-21, which is not done. It can start when that task is Done."] });
  });
});

describe("the board", () => {
  it("draws a plan's frame in Backlog with Queue group, and the Runs after line on a card", () => {
    const value = planBoard();
    const actions = edits(value);
    render(<TaskBoardView board={value} edits={actions} onOpenTask={() => undefined} />);
    expect(frame()).toHaveClass("taskReadyGroup");
    expect(frame().closest("[data-column-id]")).toHaveAttribute("data-column-id", "col-1");
    expect(within(frame()).getByText("Parallel ·")).toBeInTheDocument();
    fireEvent.click(within(frame()).getByRole("button", { name: "Queue group" }));
    expect(actions.queueGroup).toHaveBeenCalledWith("T-13");
    expect(within(card("T-15")).getByText("Runs after T-13 and T-14")).toHaveClass("taskCardWaiting", "taskCardAfter");
    // A waiting card says it in its wait line, once.
    expect(within(card("T-9")).getByText("Waiting: runs after T-21, which is not done")).toBeInTheDocument();
    expect(within(card("T-9")).queryByText(/^Runs after T-/)).toBeNull();
  });

  it("draws Run in parallel between two planned cards of Backlog, adjacency alone makes no group", () => {
    const value = planBoard();
    const actions = edits(value);
    render(<TaskBoardView board={value} edits={actions} />);
    const link = screen.getByRole("button", { name: "Run T-12, T-13, and T-14 in parallel" });
    fireEvent.click(link);
    expect(actions.groupTasks).toHaveBeenCalledWith(["T-12", "T-13", "T-14"]);
    expect(card("T-12").closest("[data-ready-group]")).toBeNull();
  });

  it("opens the Task modal at Runs after from a card's toolbar", () => {
    const value = planBoard();
    const open = vi.fn();
    render(<TaskBoardView board={value} edits={edits(value)} onOpenTask={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Choose what T-15 runs after" }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: "T-15" }), expect.any(HTMLElement), "after");
    // A task that has started has no Runs after action.
    expect(screen.queryByRole("button", { name: "Choose what T-21 runs after" })).toBeNull();
  });
});

describe("the Runs after field", () => {
  const tasks = planBoard().tasks;
  const t15 = tasks.find((entry) => entry.id === "T-15")!;
  const columnName = (id: string) => columns.find((column) => column.id === id)?.name ?? null;

  it("lists each task with its ID, column, and chip, and removes one by itself", () => {
    const onChange = vi.fn();
    render(<TaskAfterField task={t15} tasks={tasks} columnName={columnName} editable onChange={onChange} />);
    const group = screen.getByRole("group", { name: "Runs after" });
    expect(within(group).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
      expect.stringContaining("T-13 · Backlog"), expect.stringContaining("T-14 · Backlog"),
    ]);
    expect(within(group).getByText(AFTER_HELPER)).toHaveClass("newTaskHelper");
    fireEvent.click(within(group).getByRole("button", { name: "Remove T-13" }));
    expect(onChange).toHaveBeenCalledWith(["T-14"]);
    expect(within(group).getByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("shows the fixed loop line, and draws a started task read-only", () => {
    const { unmount } = render(<TaskAfterField task={t15} tasks={tasks} columnName={columnName} editable error={AFTER_LOOP_MESSAGE} onChange={() => undefined} />);
    expect(screen.getByRole("alert")).toHaveTextContent("These tasks would wait for each other, so nothing was changed.");
    unmount();
    render(<TaskAfterField task={t15} tasks={tasks} columnName={columnName} editable={false} />);
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("draws nothing for a started task that runs after none", () => {
    const { container } = render(<TaskAfterField task={{ ...t15, after: undefined }} tasks={tasks} columnName={columnName} editable={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
