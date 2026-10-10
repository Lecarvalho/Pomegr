import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] }, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { openDesktopTaskWorktree, startDesktopTask } from "../../app/components/tasks/task-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
const taskStart = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
const taskAction = vi.fn(async () => ({ ok: true }));
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-1", text: "Write the thing", columnId: "col-1", position: 1, featureId: null, step: null,
    run: { provider: "claude", model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
function setBoard(t: Task) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [t], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh });
}
function setBridge(bridge: unknown) { (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge; }
async function openModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Write the thing" }));
  return within(screen.getByRole("dialog", { name: "Task" }));
}

beforeEach(() => { taskStart.mockResolvedValue({ status: "started" }); setBridge({ taskAction, taskStart }); setBoard(task()); });
afterEach(() => { setBridge(undefined); vi.clearAllMocks(); });

describe("Start session", () => {
  it("is absent without the desktop bridge", () => {
    setBridge(undefined);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
  });

  it("is present with the desktop bridge", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect((await openModal(user)).getByRole("button", { name: "Start session" })).toHaveClass("commandSecondaryAction");
  });

  it("sends exactly the two IDs once, shows Starting... and ignores a double click", async () => {
    let resolve!: (value: unknown) => void;
    taskStart.mockReturnValue(new Promise((r) => { resolve = r; }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
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
    ["plugin_missing", "Install or update the Pomegr plugin in this repository to start sessions.", true],
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
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent(line));
    expect(dialog.getByRole("button", { name: "Start session" }).hasAttribute("disabled")).toBe(locked);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows no line for a cancelled start and clears an earlier one", async () => {
    taskStart.mockResolvedValueOnce({ status: "busy" }).mockResolvedValueOnce({ status: "cancelled" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("Another session"));
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(taskStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(dialog.queryByRole("status")).not.toBeInTheDocument());
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
  });

  it.each(["needs_review", "blocked", "stalled"] as const)("is not offered for a %s task, which shows its resolutions instead", async (state) => {
    setBoard(task({ state }));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "Write the thing" }));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.queryByRole("button", { name: "Start session" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Mark done and resume queue" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Requeue task" })).toBeInTheDocument();
    // Save is the one primary action of the modal, and it waits for a change.
    expect(dialog.getAllByRole("button").filter((button) => button.classList.contains("commandPrimaryAction")).map((button) => button.textContent)).toEqual(["Save"]);
  });

  it.each([
    ["a linked session", { session: { id: "s", title: "Linked work", state: "idle", observedModel: null } }, "A session is already linked to this task.", "Linked work"],
    ["done", { state: "done" as const }, "This task is done.", "Write the thing"],
  ])("is disabled with its reason for %s", async (_name, overrides, reason, cardName) => {
    setBoard(task(overrides));
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: cardName }));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent(reason);
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("is disabled while the draft has unsaved edits, and enabled again once they are undone", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " more");
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByRole("status")).toHaveTextContent("Save your changes first.");
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    await user.clear(dialog.getByRole("textbox", { name: "Task" }));
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "Write the thing");
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
    expect(taskStart).not.toHaveBeenCalled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  describe("after a start", () => {
    const linked = { session: { id: "s", title: "Write the thing", state: "idle" as const, observedModel: null } };
    async function startThen(...changes: Partial<Task>[]) {
      const user = userEvent.setup();
      const view = render(<TaskBoardPane repositoryId={repositoryId} />);
      const dialog = await openModal(user);
      await user.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("Session started in a new terminal window."));
      for (const change of changes) {
        setBoard(task(change));
        view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
      }
      return { user, dialog };
    }

    it("follows the board once the session links", async () => {
      const { dialog } = await startThen(linked);
      expect(dialog.getByRole("status")).toHaveTextContent("A session is already linked to this task.");
      expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
      expect(dialog.queryByText("Session started in a new terminal window.")).not.toBeInTheDocument();
    });

    it.each([
      ["from the state it was started in", {}],
      ["into the queue", { state: "queued" as const }],
    ])("is startable again after Requeue clears the link, %s", async (_name, requeued) => {
      const { user, dialog } = await startThen(linked, requeued);
      expect(dialog.queryByRole("status")).not.toBeInTheDocument();
      expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
      await user.click(dialog.getByRole("button", { name: "Start session" }));
      await waitFor(() => expect(taskStart).toHaveBeenCalledTimes(2));
    });

    it("reads done once the task is done", async () => {
      const { dialog } = await startThen({ ...linked, state: "done" });
      expect(dialog.getByRole("status")).toHaveTextContent("This task is done.");
      expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    });

    it("stays locked while the board shows the task unchanged", async () => {
      const { user, dialog } = await startThen({}, { updatedAt: "2026-10-08T10:05:00.000Z" });
      expect(dialog.getByRole("status")).toHaveTextContent("Session started in a new terminal window.");
      expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
      await user.click(dialog.getByRole("button", { name: "Start session" }));
      expect(taskStart).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ["a rejected promise", () => taskStart.mockRejectedValue(new Error("boom"))],
    ["a malformed answer", () => taskStart.mockResolvedValue("nope")],
    ["a bridge without taskStart", () => setBridge({ taskAction })],
  ])("answers the fixed failure line for %s", async (_name, arrange) => {
    arrange();
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("The session could not be started."));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
  });
});

describe("Open folder after a dirty worktree", () => {
  const taskWorktreeOpen = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
  beforeEach(() => {
    taskWorktreeOpen.mockReset();
    taskWorktreeOpen.mockResolvedValue({ status: "opened" });
    taskStart.mockResolvedValue({ status: "worktree_dirty" });
    setBridge({ taskAction, taskStart, taskWorktreeOpen });
  });
  async function startDirty() {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("uncommitted changes"));
    return { user, dialog };
  }

  it("is hidden until a start answers worktree_dirty", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    expect(dialog.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
    taskStart.mockResolvedValueOnce({ status: "gate_held" });
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("A start gate holds this task"));
    expect(dialog.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
  });

  it("is a secondary action that sends the two IDs only and is offered with the dirty line", async () => {
    const { user, dialog } = await startDirty();
    const open = dialog.getByRole("button", { name: "Open folder" });
    expect(open).toHaveClass("commandSecondaryAction");
    expect(taskWorktreeOpen).not.toHaveBeenCalled();
    await user.click(open);
    await waitFor(() => expect(taskWorktreeOpen).toHaveBeenCalledTimes(1));
    expect(taskWorktreeOpen).toHaveBeenCalledWith(repositoryId, "T-1");
    expect(taskStart).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["opened", "The folder is open."],
    ["not_found", "The worktree folder was not found."],
    ["invalid", "The folder could not be opened."],
    ["unavailable", "The folder could not be opened."],
    ["something_new", "The folder could not be opened."],
  ])("shows one fixed status line for the %s result and never a path", async (status, line) => {
    taskWorktreeOpen.mockResolvedValue({ status, path: "D:\\private-folder\\worktree" });
    const { user, dialog } = await startDirty();
    await user.click(dialog.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(dialog.getAllByRole("status")).toHaveLength(2));
    expect(dialog.getAllByRole("status")[1]).toHaveTextContent(line);
    expect(dialog.getAllByRole("status")[0]).toHaveTextContent("This task's worktree has uncommitted changes.");
    expect(screen.getByRole("dialog", { name: "Task" })).not.toHaveTextContent("private-folder");
  });

  it("shows the fixed line when the bridge throws", async () => {
    taskWorktreeOpen.mockRejectedValue(new Error("D:\\private-folder"));
    const { user, dialog } = await startDirty();
    await user.click(dialog.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(dialog.getAllByRole("status")).toHaveLength(2));
    expect(dialog.getAllByRole("status")[1]).toHaveTextContent("The folder could not be opened.");
    expect(screen.getByRole("dialog", { name: "Task" })).not.toHaveTextContent("private-folder");
  });

  it("disables itself while the folder opens and ignores a second click", async () => {
    let resolve!: (value: unknown) => void;
    taskWorktreeOpen.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { user, dialog } = await startDirty();
    await user.dblClick(dialog.getByRole("button", { name: "Open folder" }));
    expect(taskWorktreeOpen).toHaveBeenCalledTimes(1);
    expect(dialog.getByRole("button", { name: "Open folder" })).toBeDisabled();
    resolve({ status: "opened" });
    await waitFor(() => expect(dialog.getByRole("button", { name: "Open folder" })).toBeEnabled());
    expect(dialog.getAllByRole("status")[1]).toHaveTextContent("The folder is open.");
  });

  it("goes away, with its line, when the next start answers something else", async () => {
    const { user, dialog } = await startDirty();
    await user.click(dialog.getByRole("button", { name: "Open folder" }));
    await waitFor(() => expect(dialog.getAllByRole("status")).toHaveLength(2));
    taskStart.mockResolvedValueOnce({ status: "busy" });
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("Another session is being started."));
    expect(dialog.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
  });

  it("is absent on a desktop build that cannot open a folder", async () => {
    setBridge({ taskAction, taskStart });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openModal(user);
    await user.click(dialog.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(dialog.getByRole("status")).toHaveTextContent("uncommitted changes"));
    expect(dialog.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
  });
});

describe("the desktop start and folder wrappers", () => {
  it("pass worktree_dirty through as its own start status, never as a generic failure", async () => {
    taskStart.mockResolvedValue({ status: "worktree_dirty" });
    expect(await startDesktopTask(repositoryId, "T-1")).toBe("worktree_dirty");
    taskStart.mockResolvedValue({ status: "worktree_gone" });
    expect(await startDesktopTask(repositoryId, "T-1")).toBe("failed");
  });

  it("open a task worktree folder with the two IDs only and answer one of four fixed statuses", async () => {
    const taskWorktreeOpen = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
    setBridge({ taskAction, taskWorktreeOpen });
    for (const status of ["opened", "not_found", "invalid", "unavailable"]) {
      taskWorktreeOpen.mockResolvedValueOnce({ status, path: "D:\\private-folder" });
      expect(await openDesktopTaskWorktree(repositoryId, "T-1")).toBe(status);
    }
    expect(taskWorktreeOpen.mock.calls).toEqual(Array.from({ length: 4 }, () => [repositoryId, "T-1"]));
  });

  it.each([
    ["an unknown status", () => ({ status: "failed" })],
    ["a malformed answer", () => "nope"],
    ["no answer", () => null],
  ])("answer unavailable for %s", async (_name, answer) => {
    setBridge({ taskAction, taskWorktreeOpen: async () => answer() });
    expect(await openDesktopTaskWorktree(repositoryId, "T-1")).toBe("unavailable");
  });

  it("answer unavailable for a throwing bridge, a bridge without the function, and no bridge", async () => {
    setBridge({ taskAction, taskWorktreeOpen: async () => { throw new Error("D:\\private-folder"); } });
    expect(await openDesktopTaskWorktree(repositoryId, "T-1")).toBe("unavailable");
    setBridge({ taskAction });
    expect(await openDesktopTaskWorktree(repositoryId, "T-1")).toBe("unavailable");
    setBridge(undefined);
    expect(await openDesktopTaskWorktree(repositoryId, "T-1")).toBe("unavailable");
  });
});
