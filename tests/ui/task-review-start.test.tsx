import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
const access = vi.hoisted(() => ({ mode: "local" as "local" | "lan" | "unknown" }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => ({ mode: access.mode }), clientAccessMode: () => access.mode }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] }, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { startDesktopReview } from "../../app/components/tasks/task-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
const taskReviewStart = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
const taskAction = vi.fn(async () => ({ ok: true }));
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: "T-1", text: "Write the thing", columnId: "col-1", position: 1, featureId: null, group: null,
    run: { provider: "claude", model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "needs_review", scheduledAt: null,
    session: { id: "session-1", title: "Builder", state: "done", observedModel: null, observedEffort: null },
    source: null, report: null, createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
function setBoard(t: Task) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [t], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh });
}
function setBridge(bridge: unknown) { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; }
async function openModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: screen.queryByRole("button", { name: "Builder" }) ? "Builder" : "Write the thing" }));
  return within(screen.getByRole("dialog", { name: "Task" }));
}

beforeEach(() => { taskReviewStart.mockResolvedValue({ status: "started" }); setBridge({ taskAction, taskReviewStart }); setBoard(task()); });
afterEach(() => { setBridge(undefined); access.mode = "local"; vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Start review", () => {
  it("is present only for a linked task in Needs review in the desktop app", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    expect(dialog.getByRole("button", { name: "Start review" })).toHaveClass("commandSecondaryAction");
    const footer = dialog.getByRole("button", { name: "Start review" }).closest(".taskModalFooter")!;
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Delete task", "Start review", "Requeue task", "Mark done"]);
  });

  it.each([
    ["another state", { state: "stalled" as const }],
    ["no linked session", { session: null }],
  ])("is absent for a task with %s", async (_label, overrides) => {
    setBoard(task(overrides));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect((await openModal(user)).queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("is absent on a paired device even when its route is available", async () => {
    setBridge(undefined);
    access.mode = "lan";
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("is absent in a browser without a desktop bridge", async () => {
    setBridge(undefined);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Start review" })).not.toBeInTheDocument();
  });

  it("shows Starting… while pending, ignores a double click, then reports and refreshes", async () => {
    let resolve!: (value: unknown) => void;
    taskReviewStart.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.dblClick(dialog.getByRole("button", { name: "Start review" }));
    expect(taskReviewStart).toHaveBeenCalledTimes(1);
    expect(taskReviewStart).toHaveBeenCalledWith(repositoryId, "T-1");
    expect(dialog.getByRole("button", { name: "Starting…" })).toBeDisabled();
    resolve({ status: "started" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows the fixed not-startable line", async () => {
    taskReviewStart.mockResolvedValue({ status: "not_startable" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("A review cannot start for this task right now."));
  });

  it.each([
    ["busy", "Another session is being started."],
    ["failed", "The session could not be started."],
  ])("shows the shared fixed line for %s", async (status, line) => {
    taskReviewStart.mockResolvedValue({ status });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent(line));
  });

  it.each([
    [{}, "unavailable"],
    [{ status: "unknown_status" }, "failed"],
  ])("parses the desktop bridge result like a task start", async (answer, expected) => {
    setBridge({ taskAction, taskReviewStart: vi.fn(async () => answer) });
    await expect(startDesktopReview(repositoryId, "T-1")).resolves.toBe(expected);
  });

  it("clears the previous result when the task changes state", async () => {
    taskReviewStart.mockResolvedValue({ status: "not_startable" });
    const user = userEvent.setup();
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start review" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("A review cannot start for this task right now."));
    setBoard(task({ state: "stalled" }));
    view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
    expect(within(screen.getByRole("dialog", { name: "Task" })).queryByText("A review cannot start for this task right now.")).not.toBeInTheDocument();
  });
});
