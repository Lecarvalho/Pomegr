import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskGates } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { waitingLine } from "../../app/components/tasks/task-gates-model";
import { singleQueueTasks } from "../../app/components/tasks/task-queue-model";
import { editedSchedule, instantOfLocalDateTime, localDateTime, nextOccurrence, scheduleLabel, startsLine, timeOfDay, waitsForOwnTime } from "../../app/components/tasks/task-schedule";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const HOUR = 3_600_000;
/** A local wall-clock instant, so the tests read the same in any time zone. */
const local = (year: number, month: number, day: number, hour: number, minute = 0) => new Date(year, month - 1, day, hour, minute).toISOString();
const FAR = local(2031, 10, 9, 2);
const PAST = local(2020, 10, 9, 7);

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
const gates = (next: TaskGates["next"]): TaskGates => ({
  threshold: 85,
  usage: { claude: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok", fiveHourPercent: 10, sevenDayPercent: 10 } },
  providerStatus: { claude: "ok", codex: "ok" }, workingTree: "clean", next,
});
const tasks = () => [
  task(1, "Loose end", { state: "queued" }),
  task(2, "Nightly", { state: "scheduled", scheduledAt: FAR }),
  task(3, "Idea"),
  task(4, "Ran at night", { state: "scheduled", scheduledAt: PAST, session: { id: "claude:s4", title: null, state: "working", observedModel: null } }),
];
function setBoard(queue: Partial<TaskBoard["queue"]> = {}, list: Task[] = tasks()) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: list, queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-1"], ...queue } };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
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

async function showQueue() {
  render(<TaskBoardPane repositoryId={repositoryId} />);
  await userEvent.click(within(screen.getByRole("group", { name: "Tasks view" })).getByRole("button", { name: "Queue" }));
  return within(screen.getByRole("region", { name: "Schedule" }));
}
const scheduleCalls = () => taskAction.mock.calls.filter((call) => call[1] === "queue_settings").map((call) => call[2]);
const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
async function openModal(title: string) {
  render(<TaskBoardPane repositoryId={repositoryId} />);
  await userEvent.click(screen.getByRole("button", { name: title }));
  return within(screen.getByRole("dialog", { name: "Task" }));
}

describe("schedule time helpers", () => {
  it("round-trips local values and names a time as Oct 9, 02:00", () => {
    expect(scheduleLabel(local(2026, 10, 9, 2))).toBe("Oct 9, 02:00");
    expect(scheduleLabel("soon")).toBeNull();
    expect(timeOfDay(local(2026, 10, 9, 7, 5))).toBe("07:05");
    expect(timeOfDay(null)).toBe("");
    expect(localDateTime(local(2026, 10, 9, 2))).toBe("2026-10-09T02:00");
    expect(instantOfLocalDateTime("2026-10-09T02:00")).toBe(local(2026, 10, 9, 2));
    for (const value of ["", "02:00", "2026-10-09", "tomorrow"]) expect(instantOfLocalDateTime(value)).toBeNull();
  });

  it("reads a time of day as its next occurrence", () => {
    const now = Date.parse(local(2026, 10, 8, 22));
    expect(nextOccurrence("23:30", now)).toBe(local(2026, 10, 8, 23, 30));
    expect(nextOccurrence("02:00", now)).toBe(local(2026, 10, 9, 2));
    expect(nextOccurrence("22:00", now)).toBe(local(2026, 10, 9, 22));
    for (const value of ["", "24:00", "2:00", "02:60", "soon"]) expect(nextOccurrence(value, now)).toBeNull();
  });

  it("puts the stop after the start and keeps the other time when one changes", () => {
    const now = Date.parse(local(2026, 10, 8, 22));
    const none = { startAt: null, stopAfter: null };
    expect(editedSchedule(none, { stopAfter: "07:00" }, now)).toEqual({ startAt: null, stopAfter: local(2026, 10, 9, 7) });
    const withStart = editedSchedule(none, { startAt: "02:00" }, now);
    expect(withStart).toEqual({ startAt: local(2026, 10, 9, 2), stopAfter: null });
    // The stop is the first 01:00 after the start, not the one before it.
    expect(editedSchedule(withStart, { stopAfter: "01:00" }, now)).toEqual({ startAt: local(2026, 10, 9, 2), stopAfter: local(2026, 10, 10, 1) });
    // A stored stop that no longer comes after a new start moves to its next occurrence after it.
    const stored = { startAt: null, stopAfter: local(2026, 10, 9, 1) };
    expect(editedSchedule(stored, { startAt: "02:00" }, now)).toEqual({ startAt: local(2026, 10, 9, 2), stopAfter: local(2026, 10, 10, 1) });
    expect(editedSchedule({ startAt: local(2026, 10, 9, 2), stopAfter: local(2026, 10, 9, 7) }, { startAt: "" }, now)).toEqual({ startAt: null, stopAfter: local(2026, 10, 9, 7) });
    expect(editedSchedule(withStart, { stopAfter: "" }, now).stopAfter).toBeNull();
  });

  it("shows a start line only for a scheduled task that still waits for a session", () => {
    expect(startsLine(task(1, "a", { state: "scheduled", scheduledAt: local(2026, 10, 9, 2) }))).toBe("Starts Oct 9, 02:00");
    expect(startsLine(task(1, "a", { state: "queued", scheduledAt: local(2026, 10, 9, 2) }))).toBeNull();
    expect(startsLine(task(1, "a", { state: "scheduled" }))).toBeNull();
    expect(startsLine(tasks()[3])).toBeNull();
    const now = Date.parse(local(2026, 10, 8, 22));
    expect(waitsForOwnTime(task(1, "a", { state: "scheduled", scheduledAt: local(2026, 10, 9, 2) }), now)).toBe(true);
    expect(waitsForOwnTime(task(1, "a", { state: "scheduled", scheduledAt: local(2026, 10, 8, 21) }), now)).toBe(false);
    expect(waitsForOwnTime(task(1, "a", { state: "queued", scheduledAt: local(2026, 10, 9, 2) }), now)).toBe(false);
  });

  it("lists a scheduled single task among the waiting ones only once the monitor put it in the order", () => {
    const board = setBoard({ order: ["T-2", "T-1"] }, [task(1, "a", { state: "queued" }), task(2, "b", { state: "scheduled", scheduledAt: PAST }), task(3, "c", { state: "scheduled", scheduledAt: FAR })]);
    expect(singleQueueTasks(board).map((entry) => entry.id)).toEqual(["T-2", "T-1", "T-3"]);
  });

  it("words the queue's own schedule as a reason the next task waits", () => {
    const queue = (reasons: NonNullable<TaskGates["next"]>["reasons"], schedule?: TaskBoard["queue"]["schedule"]): TaskBoard["queue"] =>
      ({ status: "running", blockedBy: null, pauseReason: null, order: ["T-1"], schedule, gates: gates({ taskId: "T-1", provider: "claude", blockedBy: null, reasons }) });
    expect(waitingLine(queue(["before_queue_start"], { startAt: local(2026, 10, 9, 2), stopAfter: null }), "T-1")).toBe("Waiting: the queue starts Oct 9, 02:00");
    expect(waitingLine(queue(["after_queue_stop"], { startAt: null, stopAfter: local(2026, 10, 9, 7) }), "T-1")).toBe("Waiting: the queue stopped starting tasks Oct 9, 07:00");
    expect(waitingLine(queue(["tree_dirty", "after_queue_stop"]), "T-1")).toBe("Waiting: the working tree has uncommitted changes; the queue's stop time has passed");
    expect(waitingLine(queue(["before_queue_start"]), "T-1")).toBe("Waiting: the queue's start time has not come");
  });
});

describe("the Schedule panel", () => {
  it("reads Run now with an empty stop time and the two fixed notes (D170-D177)", async () => {
    const panel = await showQueue();
    expect(panel.getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
    const mode = panel.getByRole("group", { name: "Queue start" });
    expect(mode).toHaveClass("commandSegmented");
    expect(within(mode).getByRole("button", { name: "Run now" })).toHaveAttribute("aria-pressed", "true");
    expect(within(mode).getByRole("button", { name: "Start at a time" })).toHaveAttribute("aria-pressed", "false");
    expect(panel.queryByLabelText("Start at")).not.toBeInTheDocument();
    expect(panel.getByLabelText("Stop starting tasks after")).toHaveValue("");
    expect(panel.getByText("A running session is never stopped by the schedule. Pomegr must be open for scheduled tasks to start.")).toBeInTheDocument();
    // The panel sits in the Queue view's aside, after the start gates.
    const aside = screen.getByRole("complementary", { name: "Queue settings" });
    const regions = within(aside).getAllByRole("region").map((region) => region.getAttribute("aria-labelledby"));
    expect(regions).toHaveLength(2);
    expect(within(aside).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Start gates", "Schedule"]);
  });

  it("sends a stop time as its next occurrence when the field loses focus, and nothing when it did not change", async () => {
    const panel = await showQueue();
    const stop = panel.getByLabelText("Stop starting tasks after");
    fireEvent.blur(stop);
    expect(scheduleCalls()).toEqual([]);
    const before = Date.now();
    fireEvent.change(stop, { target: { value: "07:00" } });
    expect(scheduleCalls()).toEqual([]);
    fireEvent.blur(stop);
    await waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    const sent = scheduleCalls()[0] as { schedule: { startAt: string | null; stopAfter: string } };
    expect(sent.schedule.startAt).toBeNull();
    expect(timeOfDay(sent.schedule.stopAfter)).toBe("07:00");
    const time = Date.parse(sent.schedule.stopAfter);
    expect(time).toBeGreaterThan(before);
    expect(time).toBeLessThanOrEqual(Date.now() + 24 * HOUR);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows a start time field only for Start at a time and stores nothing until a time is chosen", async () => {
    const panel = await showQueue();
    await userEvent.click(panel.getByRole("button", { name: "Start at a time" }));
    expect(panel.getByRole("button", { name: "Start at a time" })).toHaveAttribute("aria-pressed", "true");
    const start = panel.getByLabelText("Start at");
    fireEvent.blur(start);
    expect(scheduleCalls()).toEqual([]);
    fireEvent.change(start, { target: { value: "02:00" } });
    fireEvent.blur(start);
    await waitFor(() => expect(scheduleCalls()).toHaveLength(1));
    const sent = scheduleCalls()[0] as { schedule: { startAt: string; stopAfter: string | null } };
    expect(timeOfDay(sent.schedule.startAt)).toBe("02:00");
    expect(Date.parse(sent.schedule.startAt)).toBeGreaterThan(Date.now());
    expect(sent.schedule.stopAfter).toBeNull();
    // Run now with nothing stored only closes the field.
    await userEvent.click(panel.getByRole("button", { name: "Run now" }));
    expect(panel.queryByLabelText("Start at")).not.toBeInTheDocument();
    expect(scheduleCalls()).toHaveLength(1);
  });

  it("shows the stored times with their day, and Run now clears only the start time", async () => {
    const stopAfter = local(2031, 10, 9, 7);
    setBoard({ status: "idle", schedule: { startAt: FAR, stopAfter } });
    const panel = await showQueue();
    expect(panel.getByRole("button", { name: "Start at a time" })).toHaveAttribute("aria-pressed", "true");
    expect(panel.getByLabelText("Start at")).toHaveValue("02:00");
    expect(panel.getByLabelText("Stop starting tasks after")).toHaveValue("07:00");
    expect(panel.getByText("Starts Oct 9, 02:00, once the queue is on.")).toBeInTheDocument();
    expect(panel.getByText("No task starts from Oct 9, 07:00.")).toBeInTheDocument();
    await userEvent.click(panel.getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(scheduleCalls()).toEqual([{ schedule: { startAt: null, stopAfter } }]));
  });

  it("says when a stored time has passed, and clearing the stop time sends null", async () => {
    setBoard({ schedule: { startAt: local(2020, 10, 9, 2), stopAfter: PAST } });
    const panel = await showQueue();
    expect(panel.getByText("The start time Oct 9, 02:00 has passed: the queue starts tasks now.")).toBeInTheDocument();
    expect(panel.getByText("No task has started since Oct 9, 07:00. Change or clear this time to start tasks again.")).toBeInTheDocument();
    const stop = panel.getByLabelText("Stop starting tasks after");
    fireEvent.change(stop, { target: { value: "" } });
    fireEvent.blur(stop);
    await waitFor(() => expect(scheduleCalls()).toEqual([{ schedule: { startAt: local(2020, 10, 9, 2), stopAfter: null } }]));
  });

  it("shows one fixed message when the monitor refuses the schedule", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "invalid" });
    const panel = await showQueue();
    const stop = panel.getByLabelText("Stop starting tasks after");
    fireEvent.change(stop, { target: { value: "07:00" } });
    fireEvent.blur(stop);
    expect(await screen.findByRole("alert")).toHaveTextContent("The schedule could not be changed.");
  });

  it("is read-only text without the desktop app", async () => {
    setBridge(undefined);
    setBoard({ schedule: { startAt: null, stopAfter: local(2031, 10, 9, 7) } });
    const panel = await showQueue();
    expect(panel.queryByRole("group", { name: "Queue start" })).not.toBeInTheDocument();
    expect(panel.queryByLabelText("Stop starting tasks after")).not.toBeInTheDocument();
    expect(panel.getByText("Run now")).toBeInTheDocument();
    expect(panel.getByText("No task starts from Oct 9, 07:00.")).toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("a scheduled task", () => {
  it("shows Scheduled with its time in the Queue view and Starts with its time on the Board card (D63, D81, D155)", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(card("T-2").querySelector(".commandChip")).toHaveTextContent("Scheduled");
    expect(card("T-2").querySelector(".commandChip")).toHaveClass("info");
    expect(within(card("T-2")).getByText("Starts Oct 9, 02:00")).toHaveClass("taskCardDetail");
    // Once its session works on it the card borrows the session's state and names no start time.
    expect(within(card("T-4")).queryByText(/^Starts /u)).not.toBeInTheDocument();
    await userEvent.click(within(screen.getByRole("group", { name: "Tasks view" })).getByRole("button", { name: "Queue" }));
    expect(card("T-2").querySelector(".commandChip")).toHaveTextContent("Scheduled · Oct 9, 02:00");
  });

  it("takes its start time from the Task modal as queue_add with the instant, when the field loses focus", async () => {
    const dialog = await openModal("Idea");
    const field = dialog.getByLabelText("Start at");
    expect(field).toHaveValue("");
    fireEvent.blur(field);
    expect(taskAction).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: "2031-10-09T02:00" } });
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.blur(field);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_add", { id: "T-3", at: FAR }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // Start at saves by itself: it is not part of the draft, so it never needs Save and sends no update.
    expect(taskAction.mock.calls.filter((call) => call[1] === "update")).toEqual([]);
  });

  it("shows its stored time in the modal, and clearing it sends queue_add with no time", async () => {
    const dialog = await openModal("Nightly");
    const field = dialog.getByLabelText("Start at");
    expect(field).toHaveValue("2031-10-09T02:00");
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_add", { id: "T-2" }));
  });

  it("can be removed from the queue, and cannot be started by hand before its time", async () => {
    const taskStart = vi.fn(async () => ({ status: "started" }));
    setBridge({ taskAction, taskStart });
    const dialog = await openModal("Nightly");
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent("This task starts Oct 9, 02:00. Clear its start time to start it now.");
    await userEvent.click(dialog.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_remove", { id: "T-2" }));
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("restores the field and says why when the monitor refuses the time", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "invalid" });
    const dialog = await openModal("Idea");
    const field = dialog.getByLabelText("Start at");
    fireEvent.change(field, { target: { value: "2020-10-09T02:00" } });
    fireEvent.blur(field);
    expect(await dialog.findByText("Choose a time from now up to a year ahead.")).toHaveAttribute("role", "alert");
    expect(field).toHaveValue("");
  });

  it("has no start time field once a session works on it or it has an outcome", async () => {
    setBoard({}, [task(4, "Ran at night", { state: "scheduled", scheduledAt: PAST, session: { id: "claude:s4", title: null, state: "working", observedModel: null } }), task(5, "Shipped", { state: "done" })]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("button", { name: "Ran at night" }));
    expect(within(screen.getByRole("dialog", { name: "Task" })).queryByLabelText("Start at")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Shipped" }));
    expect(within(screen.getByRole("dialog", { name: "Task" })).queryByLabelText("Start at")).not.toBeInTheDocument();
  });
});

describe("schedule styles", () => {
  const css = readFileSync(join(process.cwd(), "app/styles/tasks.css"), "utf8");
  it("maps the time field of D176 to tokens", () => {
    const rule = /\.taskTimeInput \{([^}]*)\}/u.exec(css)?.[1] ?? "";
    for (const part of ["min-height: var(--control-height)", "padding: 0 var(--space-2)", "border: 1px solid var(--command-line-strong)", "border-radius: var(--control-radius)",
      "background: var(--command-panel)", "color: var(--command-ink)", "var(--text-sm)", "var(--font-data)"]) expect(rule).toContain(part);
    expect(css).toContain(".taskScheduleMode { align-self: flex-start; }");
  });
});
