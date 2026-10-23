import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { BOARD_NEXT_LABEL, QUEUED_NEXT_LABEL, laneSaysChip, taskChip, taskColumns } from "../../app/components/tasks/task-presentation";
import { DEFAULT_TASK_COLUMN_ROLES, type Task, type TaskBoard, type TaskState } from "../../shared/task-contract";

const repositoryId = "repo-0123456789abcdef01234567";
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position, role: DEFAULT_TASK_COLUMN_ROLES[position] ?? null }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
const session = (state: string): NonNullable<Task["session"]> => ({ id: "claude:abc", title: null, state, observedModel: null, observedEffort: null });

function board(tasks: Task[], order: string[] = []): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order } };
}

const LANES = { backlog: "col-1", ready: "col-2", in_progress: "col-3", review: "col-4", done: "col-5" } as const;

/** One row for each case of the chip table: the lane, the task, and the chip the card draws (null for none). */
const CASES: { name: string; lane: keyof typeof LANES; state: TaskState; session?: string; next?: boolean; chip: string | null; border?: "isLive" | "isAttention" }[] = [
  { name: "Backlog, Not queued", lane: "backlog", state: "not_queued", chip: null },
  { name: "Backlog, Queued", lane: "backlog", state: "queued", chip: "Queued" },
  { name: "Backlog, Needs review", lane: "backlog", state: "needs_review", chip: "Needs review", border: "isAttention" },
  { name: "Ready, Queued", lane: "ready", state: "queued", chip: null },
  { name: "Ready, Next", lane: "ready", state: "queued", next: true, chip: BOARD_NEXT_LABEL },
  { name: "Ready, Scheduled", lane: "ready", state: "scheduled", chip: "Scheduled" },
  { name: "Ready, Not queued", lane: "ready", state: "not_queued", chip: "Not queued" },
  { name: "In progress, Working", lane: "in_progress", state: "queued", session: "working", chip: null, border: "isLive" },
  { name: "In progress, Needs input", lane: "in_progress", state: "queued", session: "needs_input", chip: "Needs input", border: "isAttention" },
  { name: "In progress, Idle", lane: "in_progress", state: "queued", session: "idle", chip: "Idle" },
  { name: "In progress, Open", lane: "in_progress", state: "queued", session: "open", chip: "Open" },
  { name: "In progress, Stopped", lane: "in_progress", state: "queued", session: "stopped", chip: "Stopped" },
  { name: "In progress, Closed", lane: "in_progress", state: "queued", session: "closed", chip: "Closed" },
  { name: "In progress, Stalled", lane: "in_progress", state: "stalled", session: "closed", chip: "Stalled", border: "isAttention" },
  { name: "In progress, Blocked by agent", lane: "in_progress", state: "blocked", session: "closed", chip: "Blocked by agent", border: "isAttention" },
  { name: "Review, Needs review", lane: "review", state: "needs_review", session: "closed", chip: null, border: "isAttention" },
  { name: "Review, Stalled", lane: "review", state: "stalled", session: "closed", chip: "Stalled", border: "isAttention" },
  { name: "Review, Blocked by agent", lane: "review", state: "blocked", session: "closed", chip: "Blocked by agent", border: "isAttention" },
  { name: "Review, Done", lane: "review", state: "done", session: "closed", chip: "Done" },
  { name: "Done, Done", lane: "done", state: "done", session: "closed", chip: null },
  { name: "Done, Queued", lane: "done", state: "queued", chip: "Queued" },
];

describe("the state chip of a board card", () => {
  const tasks = CASES.map((entry, index) => task(index + 1, {
    columnId: LANES[entry.lane], state: entry.state, session: entry.session ? session(entry.session) : null,
  }));
  const next = CASES.findIndex((entry) => entry.next);

  it.each(CASES.map((entry, index) => [entry.name, index] as const))("%s", (_name, index) => {
    const entry = CASES[index];
    const { container, unmount } = render(<TaskBoardView board={board(tasks, [`T-${next + 1}`])} />);
    const card = container.querySelector(`[data-task-id="T-${index + 1}"]`) as HTMLElement;
    const chip = card.querySelector(".taskCardChip");
    if (entry.chip === null) expect(chip).toBeNull();
    else expect(chip?.textContent).toBe(entry.chip);
    // The border follows the state whether or not the lane leaves the chip out.
    expect(card.classList.contains("isLive")).toBe(entry.border === "isLive");
    expect(card.classList.contains("isAttention")).toBe(entry.border === "isAttention");
    unmount();
  });

  it("draws the Next chip in ink on the raised fill, and Queued · next only on the other surfaces", () => {
    const { container } = render(<TaskBoardView board={board(tasks, [`T-${next + 1}`])} />);
    expect(container.querySelector(`[data-task-id="T-${next + 1}"] .taskCardChip`)).toHaveClass("commandChip", "isInk");
    expect(container).not.toHaveTextContent(QUEUED_NEXT_LABEL);
    const queued = tasks[next];
    expect(taskChip(queued, true).label).toBe(QUEUED_NEXT_LABEL);
    expect(taskChip(queued, true, BOARD_NEXT_LABEL).label).toBe(BOARD_NEXT_LABEL);
  });

  it("draws the first two columns as Backlog and Ready, and a column with no known lane with its chip", () => {
    expect(taskColumns(board([])).map((column) => column.lane)).toEqual(["backlog", "ready", "in_progress", "review", "done"]);
    // A board whose columns carry no role knows only its first two lanes: the other cards keep their chip.
    const plain = { ...board([task(1, { columnId: "col-5", state: "done" })]), columns: columns.map(({ id, name, position }) => ({ id, name, position })) };
    expect(taskColumns(plain).map((column) => column.lane)).toEqual(["backlog", "ready", null, null, null]);
    const { container } = render(<TaskBoardView board={plain} />);
    expect(container.querySelector('[data-task-id="T-1"] .taskCardChip')?.textContent).toBe("Done");
  });

  it("compares the chip's words with the lane's", () => {
    expect(laneSaysChip("backlog", { label: "Not queued" })).toBe(true);
    expect(laneSaysChip("ready", { label: "Queued" })).toBe(true);
    expect(laneSaysChip("ready", { label: BOARD_NEXT_LABEL })).toBe(false);
    expect(laneSaysChip("in_progress", { label: "In progress" })).toBe(true);
    expect(laneSaysChip("in_progress", { label: "Needs input" })).toBe(false);
    expect(laneSaysChip("review", { label: "Needs review" })).toBe(true);
    expect(laneSaysChip("done", { label: "Done" })).toBe(true);
    expect(laneSaysChip("done", { label: "Queued" })).toBe(false);
  });
});
