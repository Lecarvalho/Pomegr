import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskGates, TaskQueue } from "../../shared/task-contract";
import { featureProgress } from "../../app/components/tasks/task-features";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: true }>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const FEATURE = { id: "feature-board", name: "Board", done: false };
/** A stop time at 23:00 on this computer's clock, far enough ahead that it never passes. */
const STOP = new Date(2099, 0, 1, 23, 0).toISOString();

function task(id: number, overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: `T-${id}`, text: `Task ${id}`, columnId: "col-2", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const gates: TaskGates = {
  threshold: 85,
  usage: { claude: { status: "ok", fiveHourPercent: 62, sevenDayPercent: 31 }, codex: { status: "ok", fiveHourPercent: 18, sevenDayPercent: 9 } },
  providerStatus: { claude: "ok", codex: "ok" },
  workingTree: "clean",
  next: { taskId: "T-2", provider: "claude", blockedBy: null, reasons: [] },
};
const session = { id: "claude:abc123", title: null, state: "working", observedModel: null, observedEffort: null } as NonNullable<Task["session"]>;
/** Seven tasks of one feature: T-1 has a session, the rest wait. */
const featureTasks = () => [
  task(1, { featureId: FEATURE.id, session }),
  ...[2, 3, 4, 5, 6, 7].map((id) => task(id, { featureId: FEATURE.id })),
];

function setBoard(queue: Partial<TaskQueue> = {}, tasks: Task[] = featureTasks()) {
  const board: TaskBoard = {
    version: 1, readiness: "ready", repositoryId, columns, features: [FEATURE], tasks,
    queue: { status: "running", blockedBy: null, pauseReason: null, order: tasks.filter((entry) => entry.session === null).map((entry) => entry.id), gates, schedule: { startAt: null, stopAfter: STOP }, ...queue },
  };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
const setBridge = (bridge: unknown) => { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; };

beforeEach(() => { taskAction.mockResolvedValue({ ok: true }); setBridge({ taskAction }); setBoard(); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

const strip = () => screen.getByRole("region", { name: "Provider capacity" });
const action = () => screen.getByRole("button", { name: "Queue settings" });
async function openPanel() {
  render(<TaskBoardPane repositoryId={repositoryId} />);
  await userEvent.click(action());
  return screen.getByRole("dialog", { name: "Queue settings" });
}

describe("the end of the capacity strip", () => {
  it("reads the threshold and the stop time, with both values in the data font, before Queue settings (D3, D4)", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const end = strip().querySelector(".taskCapacityEnd") as HTMLElement;
    expect(end.querySelector(".taskCapacitySettings")?.textContent).toBe("Do not start above 85% · stops starting after 23:00");
    expect([...end.querySelectorAll(".taskCapacityValue")].map((value) => value.textContent)).toEqual(["85%", "23:00"]);
    expect(end.lastElementChild).toBe(action());
    expect(action()).toHaveClass("commandQuietAction", "taskQueueSettingsAction");
    expect(action()).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("drops the stop clause when no stop time is set", () => {
    setBoard({ schedule: { startAt: null, stopAfter: null } });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(strip().querySelector(".taskCapacitySettings")?.textContent).toBe("Do not start above 85%");
  });
});

describe("the Queue settings panel", () => {
  it("is a dialog with the three sections under one heading, opened from the Board (D18-D23)", async () => {
    const panel = await openPanel();
    expect(panel).toHaveClass("taskQueueSettingsScrim");
    expect(panel).toHaveAttribute("aria-modal", "true");
    expect(within(panel).getByRole("heading", { level: 2, name: "Queue settings" })).toBeInTheDocument();
    expect(within(panel).getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Start gates", "Schedule", "When the queue blocks"]);
    expect(within(panel).getByText("Checked before every session Pomegr starts.")).toBeInTheDocument();
    const gateRows = panel.querySelectorAll(".taskGatesPanel:not(.taskSchedulePanel) .taskGateRow");
    expect([...gateRows].map((row) => row.querySelector("dt")?.textContent)).toEqual(["Earlier task finished", "Claude Code capacity", "Codex capacity", "Provider status", "Working tree"]);
    expect(within(panel).getByRole("group", { name: "Queue start" })).toHaveClass("commandSegmented");
    expect(within(panel).getByLabelText("Stop starting tasks after")).toHaveValue("23:00");
    expect(within(panel).getByText("A running session is never stopped by the schedule. Pomegr must be open for scheduled tasks to start.")).toBeInTheDocument();
    expect(within(panel).getByText("Stalled")).toHaveClass("isError");
    expect(within(panel).getByText("Blocked by agent")).toHaveClass("isError");
    expect(within(panel).getByText("Needs review")).toHaveClass("isReview");
    expect(panel.querySelector(".panel")).toBeNull();
  });

  it("puts focus on Close, and returns it to the action on Close and on Escape", async () => {
    const panel = await openPanel();
    const close = within(panel).getByRole("button", { name: "Close" });
    expect(close).toHaveClass("commandIconAction");
    expect(close).toHaveFocus();
    await userEvent.click(close);
    expect(screen.queryByRole("dialog", { name: "Queue settings" })).not.toBeInTheDocument();
    expect(action()).toHaveFocus();
    await userEvent.click(action());
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Queue settings" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Queue settings" })).not.toBeInTheDocument();
    expect(action()).toHaveFocus();
  });

  it("changes the threshold and the stop time through queue_settings in the desktop app", async () => {
    const panel = await openPanel();
    await userEvent.click(within(panel).getByRole("combobox", { name: "Do not start above" }));
    await userEvent.click(screen.getByRole("option", { name: "95% of the usage window" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { threshold: 95 }));
    const stop = within(panel).getByLabelText("Stop starting tasks after");
    fireEvent.change(stop, { target: { value: "" } });
    fireEvent.blur(stop);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { schedule: { startAt: null, stopAfter: null } }));
  });

  it("is read-only in a browser: plain text and a two-row definition list, and no action is sent (D21, D24)", async () => {
    setBridge(undefined);
    const panel = await openPanel();
    expect(within(panel).queryByRole("combobox")).toBeNull();
    expect(within(panel).getByText("85% of the usage window")).toHaveClass("taskGateReadOnly");
    expect(within(panel).queryByRole("group", { name: "Queue start" })).toBeNull();
    const rows = panel.querySelectorAll(".taskSchedulePanel .taskGateRow");
    expect([...rows].map((row) => row.querySelector("dt")?.textContent)).toEqual(["Start", "Stop starting tasks after"]);
    expect(within(panel).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Close"]);
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("the feature filter's progress line", () => {
  const choose = async (name: RegExp) => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await userEvent.click(screen.getByRole("combobox", { name: "Feature" }));
    await userEvent.click(screen.getByRole("option", { name }));
    return screen.getByRole("group", { name: "Filter by feature" });
  };

  it("reads the done count and the running count of the selected feature, before the moving line (D26)", async () => {
    const row = await choose(/^Board \(7\)$/);
    const line = row.querySelector(".taskFeatureProgress") as HTMLElement;
    expect(line.textContent).toBe("0 of 7 tasks done · 1 running");
    expect([...line.querySelectorAll(".taskFeatureProgressNum")].map((value) => value.textContent)).toEqual(["0", "7", "1"]);
    expect(line.compareDocumentPosition(within(row).getByText("Moving cards is off while a feature filter is on.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is absent for All and for No feature", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(document.querySelector(".taskFeatureProgress")).toBeNull();
    await userEvent.click(screen.getByRole("combobox", { name: "Feature" }));
    await userEvent.click(screen.getByRole("option", { name: /^No feature/ }));
    expect(document.querySelector(".taskFeatureProgress")).toBeNull();
  });

  it("counts a task as running only while it has a session and is not done", () => {
    const board = setBoard();
    expect(featureProgress(board, FEATURE.id)).toEqual({ total: 7, done: 0, running: 1 });
    const waiting = { ...board, tasks: board.tasks.map((entry) => ({ ...entry, session: null })) };
    expect(featureProgress(waiting, FEATURE.id)).toEqual({ total: 7, done: 0, running: 0 });
    const finished = { ...board, tasks: board.tasks.map((entry) => (entry.id === "T-1" ? { ...entry, state: "done" as const } : entry)) };
    expect(featureProgress(finished, FEATURE.id)).toEqual({ total: 7, done: 1, running: 0 });
    expect(featureProgress(board, "none")).toBeNull();
  });
});
