import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] }, loading: false, connected: true, refresh: vi.fn() }) }));

import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
const taskStart = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
const taskAction = vi.fn(async () => ({ ok: true }));
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-1", text: "Write the thing", columnId: "col-1", position: 1, featureId: null, step: null,
    run: { provider: "claude", model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
function setBoard(t: Task) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [t], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh });
}
function setBridge(bridge: unknown) { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; }
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Write the thing" }));
  return within(screen.getByRole("dialog", { name: "Task T-1" }));
}

beforeEach(() => { taskStart.mockResolvedValue({ status: "started" }); setBridge({ taskAction, taskStart }); setBoard(task()); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

describe("Start session", () => {
  it("is absent without the desktop bridge", () => {
    setBridge(undefined);
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
  });

  it("is present with the desktop bridge", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    expect((await openPanel(user)).getByRole("button", { name: "Start session" })).toHaveClass("commandPrimaryAction");
  });

  it("sends exactly the two IDs once, shows Starting... and ignores a double click", async () => {
    let resolve!: (value: unknown) => void;
    taskStart.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openPanel(user);
    await user.dblClick(dialog.getByRole("button", { name: "Start session" }));
    expect(taskStart).toHaveBeenCalledTimes(1);
    expect(taskStart).toHaveBeenCalledWith(repositoryId, "T-1");
    expect(dialog.getByRole("button", { name: "Starting…" })).toBeDisabled();
    resolve({ status: "started" });
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent("Session started in a new terminal window.");
    expect(dialog.queryByText(/Running|Live/)).not.toBeInTheDocument();
  });

  it.each([
    ["unsupported_platform", "Starting sessions is available on Windows only.", true],
    ["cli_missing", "The provider's command-line tool was not found on this computer.", true],
    ["plugin_missing", "Install the Pomegr plugin in this repository to start sessions.", true],
    ["unsupported_provider", "Sessions cannot be started on this provider.", true],
    ["not_startable", "This task cannot be started right now.", false],
    ["not_found", "This task no longer exists.", false],
    ["gate_held", "A start gate holds this task. See Start gates in the Queue view.", false],
    ["busy", "Another session is being started.", false],
    ["invalid", "The session could not be started.", false],
    ["unavailable", "The session could not be started.", false],
    ["failed", "The session could not be started.", false],
    ["something_new", "The session could not be started.", false],
  ])("shows the fixed line for %s", async (status, line, locked) => {
    taskStart.mockResolvedValue({ status });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openPanel(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent(line));
    expect(dialog.getByRole("button", { name: "Start session" }).hasAttribute("disabled")).toBe(locked);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows no line for a cancelled start and clears an earlier one", async () => {
    taskStart.mockResolvedValueOnce({ status: "busy" }).mockResolvedValueOnce({ status: "cancelled" });
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openPanel(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("Another session"));
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(taskStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dialog.getByRole("status")).toBeEmptyDOMElement());
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
  });

  it.each(["needs_review", "blocked", "stalled"] as const)("is not offered for a %s task, which shows its resolutions instead", async (state) => {
    setBoard(task({ state }));
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Write the thing" }));
    const dialog = within(screen.getByRole("dialog", { name: "Task T-1" }));
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.getAllByRole("button").filter((button) => button.classList.contains("commandPrimaryAction")).map((button) => button.textContent)).toEqual(["Mark done and resume queue"]);
  });

  it.each([
    ["a linked session", { session: { id: "s", title: "Linked work", state: "idle", observedModel: null } }, "A session is already linked to this task.", "Linked work"],
    ["done", { state: "done" as const }, "This task is done.", "Write the thing"],
  ])("is disabled with its reason for %s", async (_name, overrides, reason, cardName) => {
    setBoard(task(overrides));
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: cardName }));
    const dialog = within(screen.getByRole("dialog", { name: "Task T-1" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent(reason);
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("is disabled while the task text has unsaved edits", async () => {
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openPanel(user);
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " more");
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent("Save your changes first.");
  });

  it.each([
    ["a rejected promise", () => taskStart.mockRejectedValue(new Error("boom"))],
    ["a malformed answer", () => taskStart.mockResolvedValue("nope")],
    ["a bridge without taskStart", () => setBridge({ taskAction })],
  ])("answers the fixed failure line for %s", async (_name, arrange) => {
    arrange();
    const user = userEvent.setup();
    render(<TasksTab repositoryId={repositoryId} />);
    const dialog = await openPanel(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("The session could not be started."));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
  });
});
