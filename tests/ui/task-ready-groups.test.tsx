import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { taskColumns } from "../../app/components/tasks/task-presentation";
import { readySegments } from "../../app/components/tasks/task-ready-groups";
import { startsParts } from "../../app/components/tasks/task-schedule";

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
const local = (hour: number) => new Date(2026, 9, 12, hour).toISOString();

/**
 * Ready, top to bottom: f1 step 2 (T-59, T-60, T-62), f1 step 3 (T-63), f2 step 1 (T-64, T-65), a card that is not
 * queued (T-80), then the single tasks T-69 (scheduled) and T-71. f1 step 1 runs elsewhere: T-55, T-56, T-57.
 */
const tasks = (): Task[] => [
  task(55, { featureId: "f1", step: 1, columnId: "col-4", state: "needs_review", session }),
  task(56, { featureId: "f1", step: 1, columnId: "col-3", session }),
  task(57, { featureId: "f1", step: 1, columnId: "col-3", session }),
  task(59, { featureId: "f1", step: 2, position: 0 }),
  task(60, { featureId: "f1", step: 2, position: 1 }),
  task(62, { featureId: "f1", step: 2, position: 2 }),
  task(63, { featureId: "f1", step: 3, position: 3 }),
  task(64, { featureId: "f2", step: 1, position: 4 }),
  task(65, { featureId: "f2", step: 1, position: 5 }),
  task(80, { state: "not_queued", position: 6, featureId: "f1", step: 4 }),
  task(69, { state: "scheduled", scheduledAt: local(22), position: 7 }),
  task(71, { position: 8 }),
];

const gates: NonNullable<TaskBoard["queue"]["gates"]> = {
  threshold: 85, usage: { claude: { status: "over", fiveHourPercent: 91, sevenDayPercent: 37 }, codex: { status: "ok", fiveHourPercent: 1, sevenDayPercent: 1 } },
  providerStatus: { claude: "ok", codex: "ok" }, workingTree: "clean", next: { taskId: "T-59", provider: "claude", blockedBy: null, reasons: ["usage_over"] },
};

function board(overrides: Partial<TaskBoard["queue"]> = {}): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId: "repo-0123456789abcdef01234567", columns, features, tasks: tasks(),
    queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-59", "T-60", "T-62", "T-63", "T-64", "T-65", "T-71"], gates, ...overrides } };
}

const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const lane = (name: string) => screen.getByRole("region", { name }) as HTMLElement;
const groups = () => [...lane("Ready").querySelectorAll<HTMLElement>(".taskReadyGroup")];

describe("the Ready lane's step groups", () => {
  it("projects the lane's order into segments without moving a card", () => {
    const value = board();
    const ready = taskColumns(value)[1].tasks;
    const segments = readySegments(ready, value);
    expect(segments.map((segment) => segment.kind)).toEqual(["step", "step", "step", "card", "single"]);
    expect(segments.flatMap((segment) => segment.kind === "card" ? [segment.task.id] : segment.tasks.map((item) => item.id))).toEqual(ready.map((item) => item.id));
    expect(segments[0]).toMatchObject({ step: 2, last: 4, size: 3 });
    expect(segments[1]).toMatchObject({ step: 3, last: 4, size: 1 });
  });

  it("counts a step's tasks in any lane, so a lone waiting card of a parallel step is not called one task", () => {
    const value = board();
    // T-56 is requeued: it waits in Ready while T-55 and T-57 of its step are elsewhere.
    value.tasks = value.tasks.map((item) => item.id === "T-56" ? { ...item, columnId: "col-2", position: 9, session: null } : item);
    const segments = readySegments(taskColumns(value)[1].tasks, value);
    expect(segments.at(-1)).toMatchObject({ kind: "step", step: 1, size: 3, tasks: [{ id: "T-56" }] });
    render(<TaskBoardView board={value} />);
    const last = groups().at(-1) as HTMLElement;
    expect(last).not.toHaveClass("isParallel");
    expect(last.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 3");
  });

  it("frames a step with two or more waiting cards and captions it (D6, D7)", () => {
    render(<TaskBoardView board={board()} />);
    const [first, , third] = groups();
    expect(first).toHaveClass("isParallel");
    expect(first.querySelector(".taskReadyStep")?.textContent).toBe("Tasks adjustments · Step 2 of 4");
    expect(first.querySelector(".taskReadyMode")?.textContent).toBe("Parallel · 3");
    expect(first.querySelector(".taskReadyMode svg")).toHaveAttribute("aria-hidden", "true");
    expect(first.querySelector(".taskReadyCount")).toHaveTextContent("3");
    expect([...first.querySelectorAll("li.taskCard")].map((item) => item.getAttribute("data-task-id"))).toEqual(["T-59", "T-60", "T-62"]);
    expect(third.querySelector(".taskReadyStep")?.textContent).toBe("Aril chat polish · Step 1 of 1");
    expect(within(first).getByRole("list", { name: "Tasks adjustments, step 2 of 4" })).toBeInTheDocument();
  });

  it("captions a one-task step and the single tasks without a frame (D8, D9)", () => {
    render(<TaskBoardView board={board()} />);
    const [, second, , singles] = groups();
    expect(second).not.toHaveClass("isParallel");
    expect(second.querySelector(".taskReadyMode")?.textContent).toBe("One task");
    expect(second.querySelector("svg.taskParallelGlyph")).toBeNull();
    expect(singles).not.toHaveClass("isParallel");
    expect(singles.querySelector(".taskReadyStep")?.textContent).toBe("Single tasks");
    expect(singles.querySelector(".taskReadyMode")?.textContent).toBe("One at a time");
    expect(groups()).toHaveLength(4);
  });

  it("draws a grouped card compact, with its run and no feature or Complete when line (D10)", () => {
    render(<TaskBoardView board={board()} />);
    expect(card("T-60")).toHaveClass("taskReadyCard");
    expect(card("T-60").querySelector(".taskCardPlanned")).toHaveTextContent("model-large · high");
    expect(card("T-60").querySelector(".taskCardFeature")).toBeNull();
    expect(card("T-60").querySelectorAll(".taskCardDetail")).toHaveLength(0);
    // A card of Ready that does not wait in the queue stays a plain board card where it is.
    expect(card("T-80")).not.toHaveClass("taskReadyCard");
    expect(card("T-80").closest(".taskReadyGroup")).toBeNull();
    expect(card("T-80").querySelector(".taskCardFeature")?.textContent).toBe("Tasks adjustments · step 4 of 4");
  });

  it("keeps Queued · next and adds the Waiting line only while the queue is on (D11)", () => {
    const { unmount } = render(<TaskBoardView board={board()} />);
    expect(card("T-59").querySelector(".taskCardChip")).toHaveTextContent("Queued · next");
    expect(card("T-59").querySelector(".taskCardWaiting")?.textContent).toMatch(/^Waiting: Claude Code is above 85%/u);
    expect(card("T-60").querySelector(".taskCardWaiting")).toBeNull();
    unmount();
    render(<TaskBoardView board={board({ status: "idle" })} />);
    expect(card("T-59").querySelector(".taskCardWaiting")).toBeNull();
  });

  it("names a scheduled card's day and puts its time in the data font (D12)", () => {
    render(<TaskBoardView board={board()} />);
    expect(card("T-69").querySelector(".taskCardChip")).toHaveClass("info");
    expect(card("T-69").querySelector(".taskCardChip")).toHaveTextContent("Scheduled");
    expect(card("T-69").querySelector(".taskCardStartsTime")).toHaveTextContent("22:00");
    const scheduled = { state: "scheduled", scheduledAt: local(22), session: null } as const;
    expect(startsParts(scheduled, Date.parse(local(9)))).toEqual({ day: "today", time: "22:00" });
    expect(startsParts(scheduled, Date.parse(local(9)) - 86_400_000)).toEqual({ day: "Oct 12,", time: "22:00" });
    expect(startsParts(scheduled)).toEqual({ day: "Oct 12,", time: "22:00" });
  });

  it("names the other tasks of a parallel step on a card outside Ready, and none for a one-task step (D13, D14)", () => {
    const value = board();
    value.tasks = value.tasks.map((item) => item.id === "T-80" ? { ...item, columnId: "col-1" } : item);
    render(<TaskBoardView board={value} />);
    const line = card("T-56").querySelector(".taskCardFeature") as HTMLElement;
    expect(line.textContent).toBe("Tasks adjustments · step 1 of 4 · parallel with T-55, T-57");
    expect(within(line).getByRole("img", { name: "Parallel" })).toBeInTheDocument();
    expect(line.querySelector(".taskCardFeatureIds")).toHaveTextContent("T-55, T-57");
    const alone = card("T-80").querySelector(".taskCardFeature") as HTMLElement;
    expect(alone.textContent).toBe("Tasks adjustments · step 4 of 4");
    expect(alone.querySelector("svg")).toBeNull();
  });

  it("groups no other lane and counts cards, not groups (D15)", () => {
    render(<TaskBoardView board={board()} />);
    expect(lane("Ready").querySelector(".taskColumnCount")).toHaveTextContent("9 tasks");
    expect(lane("In progress").querySelector(".taskReadyGroup")).toBeNull();
    expect(document.querySelectorAll(".taskReadyGroup")).toHaveLength(4);
  });
});
