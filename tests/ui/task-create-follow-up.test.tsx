import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyTaskBoard, type Task, type TaskBoard } from "../../shared/task-contract";

vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));

import { TaskModal } from "../../app/components/tasks/TaskModal";

// The New task modal's split action (task-modal.md, "Create and queue, create and start"): the task is created first, then
// queued or started through the actions the Task modal already uses. The bridge is faked.

const repositoryId = "repo-0123456789abcdef01234567";
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Record<string, unknown>>>();
const taskStart = vi.fn<(repositoryId: string, taskId: string) => Promise<{ status: string }>>();
const refresh = vi.fn(async () => {});
const onCreated = vi.fn();
const onClose = vi.fn();
const onFollowUpFailed = vi.fn();
const board: TaskBoard = { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }] };

function created(): Task {
  return {
    id: "T-50", text: "Write the guide", columnId: "col-1", position: 1, featureId: null, step: null,
    run: { provider: "claude", model: null, effort: "medium" }, completeWhen: { checks: [], own: null }, state: "not_queued", scheduledAt: null,
    session: null, source: null, report: null, createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z",
  };
}

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  taskAction.mockResolvedValue({ ok: true, taskId: "T-50" });
  taskStart.mockResolvedValue({ status: "started" });
  setBridge({ taskAction, taskStart });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const newModal = () => <TaskModal mode="new" repositoryId={repositoryId} repositoryName="Example project" board={board} refresh={refresh} onCreated={onCreated} onFollowUpFailed={onFollowUpFailed} onClose={onClose} />;
const editModal = () => <TaskModal mode="edit" repositoryId={repositoryId} repositoryName="Example project" task={created()} board={board} refresh={refresh} onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose} />;
const caret = () => screen.getByRole("button", { name: "More ways to create" });
const actions = () => taskAction.mock.calls.map((call) => call[1]);

async function choose(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByRole("textbox", { name: "Task" }), "Write the guide");
  await user.click(caret());
  await user.click(screen.getByRole("menuitem", { name: new RegExp(`^${name}`, "u") }));
}

describe("New task, the split action", () => {
  it("keeps Create task as the one primary and offers the two other forms from its caret, each with one line", async () => {
    const user = userEvent.setup();
    render(newModal());
    const footer = screen.getByRole("dialog", { name: "New task" }).querySelector(".taskModalFooter")!;
    expect([...footer.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Cancel", "Create task", "More ways to create"]);
    expect(caret()).toBeDisabled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Task" }), "Write the guide");
    expect(caret()).toHaveAttribute("aria-expanded", "false");
    await user.click(caret());
    expect(caret()).toHaveAttribute("aria-expanded", "true");
    const items = within(screen.getByRole("menu", { name: "More ways to create" })).getAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Create and queueGoes to the end of Ready.", "Create and start sessionOpens a new terminal window now."]);
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(items[1]).toHaveFocus();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("closes the menu on Escape and keeps the dialog and its text", async () => {
    const user = userEvent.setup();
    render(newModal());
    await user.type(screen.getByRole("textbox", { name: "Task" }), "Write the guide");
    await user.click(caret());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(caret()).toHaveFocus();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("creates only, with no queue or start, from the primary", async () => {
    const user = userEvent.setup();
    render(newModal());
    await user.type(screen.getByRole("textbox", { name: "Task" }), "Write the guide");
    await user.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(actions()).toEqual(["create"]);
    expect(taskStart).not.toHaveBeenCalled();
  });

  it("creates the task and then adds that task to the queue", async () => {
    const user = userEvent.setup();
    render(newModal());
    await choose(user, "Create and queue");
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(actions()).toEqual(["create", "queue_add"]);
    expect(taskAction.mock.calls[1]).toEqual([repositoryId, "queue_add", { id: "T-50" }]);
    expect(taskStart).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onFollowUpFailed).not.toHaveBeenCalled();
  });

  it("creates the task and then starts that task, reading Starting… meanwhile", async () => {
    let finish: (value: { status: string }) => void = () => {};
    taskStart.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(newModal());
    await choose(user, "Create and start session");
    await waitFor(() => expect(taskStart).toHaveBeenCalledWith(repositoryId, "T-50"));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    finish({ status: "started" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(actions()).toEqual(["create"]);
    expect(onFollowUpFailed).not.toHaveBeenCalled();
  });

  it("queues and starts nothing when the create fails, and keeps the modal", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "invalid" });
    const user = userEvent.setup();
    render(newModal());
    await choose(user, "Create and start session");
    await waitFor(() => expect(screen.getByRole("button", { name: "Create task" })).toBeEnabled());
    expect(actions()).toEqual(["create"]);
    expect(taskStart).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onFollowUpFailed).not.toHaveBeenCalled();
  });

  it("hands the task to its Task modal, which says so, when it could not be queued", async () => {
    taskAction.mockImplementation(async (_repository, action) => action === "queue_add" ? { ok: false, error: "conflict" } : { ok: true, taskId: "T-50" });
    const user = userEvent.setup();
    const first = render(newModal());
    await choose(user, "Create and queue");
    await waitFor(() => expect(onFollowUpFailed).toHaveBeenCalledWith("T-50"));
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
    first.unmount();
    render(editModal());
    expect(screen.getByRole("dialog", { name: "Task" })).toHaveTextContent("The task could not be added to the queue.");
  });

  it("hands the task to its Task modal with the start line and its recovery when the start did not happen", async () => {
    taskStart.mockResolvedValue({ status: "tree_dirty" });
    const user = userEvent.setup();
    const first = render(newModal());
    await choose(user, "Create and start session");
    await waitFor(() => expect(onFollowUpFailed).toHaveBeenCalledWith("T-50"));
    expect(onClose).not.toHaveBeenCalled();
    first.unmount();
    render(editModal());
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByText(/This repository has uncommitted changes\./u)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Start in separate worktree" })).toBeInTheDocument();
  });

  it("opens the Task modal with no line when the owner cancels the start", async () => {
    taskStart.mockResolvedValue({ status: "cancelled" });
    const user = userEvent.setup();
    const first = render(newModal());
    await choose(user, "Create and start session");
    await waitFor(() => expect(onFollowUpFailed).toHaveBeenCalledWith("T-50"));
    first.unmount();
    render(editModal());
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
    expect(dialog.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("the split action styles", () => {
  it("draws the two halves one pixel apart and opens the menu above the button as an overlay", () => {
    const shell = readFileSync(join(process.cwd(), "app", "styles", "shell.css"), "utf8");
    expect(shell).toMatch(/\.commandSplitAction \{[^}]*position: relative;[^}]*gap: 1px/);
    expect(shell).toMatch(/\.commandSplitMenu \{[^}]*inset-block-end: calc\(100% \+ var\(--space-1\)\);[^}]*box-shadow: var\(--command-overlay-shadow\)/);
  });
});
