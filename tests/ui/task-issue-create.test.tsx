import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useCallback, useMemo, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { createEmptyTaskBoard, type Task, type TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { TaskModal } from "../../app/components/tasks/TaskModal";
import { createDesktopTask } from "../../app/components/tasks/task-desktop";
import { createTaskIssue, issueCreateFailure, issueCreateFailureMessage, rememberIssueCreateFailure } from "../../app/components/tasks/task-issues-desktop";

// Creating a GitHub issue from a task (design contract G129-G131, G265): the New task checkbox and the Edit action. The
// bridge is faked; a failed issue never costs the task.

const repositoryId = "repo-0123456789abcdef01234567";
const CREATE_ISSUES: GitHubAnswer = { ok: true, connection: "connected", repository: { visibility: "private", capabilities: ["read_issues", "create_issues"] } };
const HELPER = "The task text is sent to GitHub once, with its first line as the issue title. Anyone who can see the repository can read it. Later edits here are not sent.";

type GitHubAnswer = Record<string, unknown>;
const taskIssues = vi.fn<(repositoryId: string, operation: string, payload: Record<string, unknown>) => Promise<GitHubAnswer>>();
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Record<string, unknown>>>();
const refresh = vi.fn(async () => {});
const onCreated = vi.fn();
const onChanged = vi.fn();
const onClose = vi.fn();
const onIssueFailed = vi.fn();

const board: TaskBoard = { ...createEmptyTaskBoard(repositoryId, "ready"), columns: [{ id: "col-1", name: "Backlog", position: 0 }] };

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "T-12", text: "Make the queue wait for the worktree.", columnId: "col-1", position: 1, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null }, state: "not_queued", scheduledAt: null,
    session: null, source: null, report: null, createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}
const createCalls = () => taskIssues.mock.calls.filter((call) => call[1] === "create");
const statusCalls = () => taskIssues.mock.calls.filter((call) => call[1] === "status");

beforeEach(() => {
  taskIssues.mockImplementation(async (_repository, operation) => operation === "create" ? { ok: true, number: 77 } : CREATE_ISSUES);
  taskAction.mockResolvedValue({ ok: true, taskId: "T-50" });
  setBridge({ taskAction, taskIssues });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const newModal = () => <TaskModal mode="new" repositoryId={repositoryId} repositoryName="Example project" board={board} refresh={refresh} onCreated={onCreated} onIssueFailed={onIssueFailed} onClose={onClose} />;
const editModal = (overrides: Partial<Task> = {}) => <TaskModal mode="edit" repositoryId={repositoryId} repositoryName="Example project" task={task(overrides)} board={board}
  refresh={refresh} onChanged={onChanged} onDeleted={vi.fn()} onClose={onClose} />;
const checkbox = () => screen.queryByRole("checkbox", { name: "Also create a GitHub issue" }) as HTMLInputElement | null;
const createTaskButton = () => screen.getByRole("button", { name: /^Creat(e task|ing…)$/u });
const issueButton = () => screen.queryByRole("button", { name: "Create GitHub issue" });

async function fillAndCreate(user: ReturnType<typeof userEvent.setup>, text = "Fix the thing\n\nMore detail.") {
  await user.type(screen.getByRole("textbox", { name: "Task" }), text);
  await user.click(createTaskButton());
}

describe("New task, the checkbox", () => {
  it("draws nothing without the bridge and nothing until the status answers", async () => {
    setBridge({ taskAction });
    const { unmount } = render(newModal());
    expect(checkbox()).toBeNull();
    unmount();
    let answer: (value: GitHubAnswer) => void = () => {};
    taskIssues.mockImplementation(() => new Promise<GitHubAnswer>((resolve) => { answer = resolve; }));
    setBridge({ taskAction, taskIssues });
    render(newModal());
    expect(statusCalls()).toHaveLength(1);
    expect(checkbox()).toBeNull();
    answer(CREATE_ISSUES);
    await waitFor(() => expect(checkbox()).not.toBeNull());
  });

  it("is checked by default with the helper when the account can create issues, and reads the status once", async () => {
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    expect(checkbox()).toBeEnabled();
    expect(checkbox()).toHaveAccessibleDescription(HELPER);
    expect(statusCalls()).toHaveLength(1);
    expect(statusCalls()[0]).toEqual([repositoryId, "status", {}]);
  });

  it.each([
    ["not signed in", { ok: true, connection: "not_signed_in", repository: null }, "You are not signed in to GitHub. Sign in from Settings to create issues."],
    ["CLI missing", { ok: true, connection: "cli_missing", repository: null }, "The GitHub CLI is not installed."],
    ["issues disabled", { ok: true, connection: "connected", repository: { visibility: "private", capabilities: ["issues_disabled"] } }, "Issues are turned off for this repository."],
    ["no access", { ok: true, connection: "connected", repository: { visibility: "public", capabilities: ["read_issues"] } }, "You cannot create issues in this repository."],
    ["repository not recognized", { ok: true, connection: "connected", repository: null }, "GitHub could not be read."],
    ["unreadable answer", { ok: false, error: "unavailable" }, "GitHub could not be read."],
  ])("is unchecked and disabled with one reason: %s", async (_name, answer, reason) => {
    taskIssues.mockResolvedValue(answer);
    render(newModal());
    await waitFor(() => expect(checkbox()).not.toBeNull());
    expect(checkbox()).not.toBeChecked();
    expect(checkbox()).toBeDisabled();
    expect(checkbox()).toHaveAccessibleDescription(reason);
  });

  it("creates the task, then the issue from the new task's ID only", async () => {
    const user = userEvent.setup();
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(taskAction.mock.calls.filter((call) => call[1] === "create")).toHaveLength(1);
    expect(createCalls()).toEqual([[repositoryId, "create", { taskId: "T-50" }]]);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.invocationCallOrder[0]).toBeGreaterThan(taskIssues.mock.invocationCallOrder.at(-1) ?? 0);
  });

  it("sends no create when the box is unchecked", async () => {
    const user = userEvent.setup();
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await user.click(checkbox() as HTMLInputElement);
    expect(checkbox()).not.toBeChecked();
    await fillAndCreate(user);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createCalls()).toHaveLength(0);
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it("sends no create when the task could not be created, and keeps the modal open", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "limit" });
    const user = userEvent.setup();
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    expect(await screen.findByRole("alert")).toHaveTextContent("The board is full");
    expect(createCalls()).toHaveLength(0);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("sends no create when the monitor answered no task ID", async () => {
    taskAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createCalls()).toHaveLength(0);
  });

  it("shows Creating… while busy, and a failed issue hands the new task to onIssueFailed instead of closing, with the reason remembered", async () => {
    taskAction.mockResolvedValue({ ok: true, taskId: "T-61" });
    let finish: (value: GitHubAnswer) => void = () => {};
    taskIssues.mockImplementation((_repository, operation) => operation === "create" ? new Promise<GitHubAnswer>((resolve) => { finish = resolve; }) : Promise.resolve(CREATE_ISSUES));
    const user = userEvent.setup();
    render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    await waitFor(() => expect(createTaskButton()).toHaveTextContent("Creating…"));
    expect(createTaskButton()).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    finish({ ok: false, error: "not_signed_in" });
    await waitFor(() => expect(onIssueFailed).toHaveBeenCalledWith("T-61"));
    expect(onIssueFailed).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated.mock.invocationCallOrder[0]).toBeLessThan(onIssueFailed.mock.invocationCallOrder[0]);
    expect(issueCreateFailure(repositoryId, "T-61")).toBe("not_signed_in");
  });

  it("closes as before when a failed issue has no onIssueFailed to hand the task to", async () => {
    taskAction.mockResolvedValue({ ok: true, taskId: "T-63" });
    taskIssues.mockImplementation(async (_repository, operation) => operation === "create" ? { ok: false, error: "failed" } : CREATE_ISSUES);
    const user = userEvent.setup();
    render(<TaskModal mode="new" repositoryId={repositoryId} repositoryName="Example project" board={board} refresh={refresh} onCreated={onCreated} onClose={onClose} />);
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onIssueFailed).not.toHaveBeenCalled();
  });

  it("opens the task's edit modal with the reason and offers the action again after a failed create", async () => {
    taskAction.mockResolvedValue({ ok: true, taskId: "T-62" });
    taskIssues.mockImplementation(async (_repository, operation) => operation === "create" ? { ok: false, error: "failed" } : CREATE_ISSUES);
    const user = userEvent.setup();
    const first = render(newModal());
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user);
    await waitFor(() => expect(onIssueFailed).toHaveBeenCalledWith("T-62"));
    first.unmount();
    render(editModal({ id: "T-62" }));
    expect(screen.getByText("GitHub did not accept the issue. Try again.")).toHaveAttribute("role", "status");
    expect(issueButton()).toBeEnabled();
  });
});

// The Tasks page: a failed issue create does not close New task silently. The task stays as created and its own modal opens
// once the board holds it, with the fixed reason. The board is the committed one: the fake store gains the task on refresh.
const stored: Task[] = [];
function useStoredBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const read = useCallback(async () => { setTasks([...stored]); }, []);
  return useMemo(() => ({ board: { ...board, tasks }, refresh: read }), [tasks, read]);
}

describe("New task on the Tasks page, a failed issue", () => {
  beforeEach(() => {
    stored.length = 0;
    useTasks.mockImplementation(useStoredBoard);
    taskAction.mockImplementation(async (_repository, action) => {
      if (action !== "create") return { ok: true };
      stored.push(task({ id: "T-50", text: "Fix the thing" }));
      return { ok: true, taskId: "T-50" };
    });
    taskIssues.mockImplementation(async (_repository, operation) => operation === "create" ? { ok: false, error: "not_signed_in" } : CREATE_ISSUES);
  });

  it("opens the new task's modal with the fixed reason, creating the task once and the issue once", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const trigger = screen.getByRole("button", { name: "New task" });
    await user.click(trigger);
    await waitFor(() => expect(checkbox()).toBeChecked());
    await fillAndCreate(user, "Fix the thing");
    const dialog = await screen.findByRole("dialog", { name: "Task" });
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
    expect(within(dialog).getByRole("textbox", { name: "Task" })).toHaveValue("Fix the thing");
    expect(within(dialog).getByText(issueCreateFailureMessage("not_signed_in"))).toHaveAttribute("role", "status");
    expect(taskAction.mock.calls.filter((call) => call[1] === "create")).toHaveLength(1);
    expect(createCalls()).toEqual([[repositoryId, "create", { taskId: "T-50" }]]);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});

describe("Edit, the action", () => {
  it("shows Source, Not on GitHub, the action and the helper for a task with no source, and reads no status", () => {
    render(editModal({ id: "T-70" }));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(document.querySelector(".taskSourceLabel")).toHaveTextContent("Source");
    expect(dialog.getByText("Not on GitHub")).toBeInTheDocument();
    expect(issueButton()).toBeEnabled();
    expect(issueButton()).toHaveClass("commandSecondaryAction");
    expect(issueButton()).toHaveAccessibleDescription(HELPER);
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("is absent for a task with a source and in a browser", () => {
    const { unmount } = render(editModal({ id: "T-71", source: { kind: "github_issue", number: 142 } }));
    expect(issueButton()).toBeNull();
    expect(screen.getByRole("img", { name: "GitHub issue #142" })).toBeInTheDocument();
    unmount();
    setBridge({ taskAction });
    render(editModal({ id: "T-72" }));
    expect(issueButton()).toBeNull();
    expect(screen.queryByText("Not on GitHub")).toBeNull();
  });

  it("is disabled with the save-first line while the draft is unsaved", async () => {
    const user = userEvent.setup();
    render(editModal({ id: "T-73" }));
    await user.type(screen.getByRole("textbox", { name: "Task" }), " More.");
    expect(issueButton()).toBeDisabled();
    expect(screen.getAllByText("Save your changes first.")).toHaveLength(1);
    await user.clear(screen.getByRole("textbox", { name: "Task" }));
    await user.type(screen.getByRole("textbox", { name: "Task" }), "Make the queue wait for the worktree.");
    expect(issueButton()).toBeEnabled();
  });

  it("creates the issue from the task ID only, disables the action while it runs, and reads the board on success", async () => {
    let finish: (value: GitHubAnswer) => void = () => {};
    taskIssues.mockImplementation(() => new Promise<GitHubAnswer>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(editModal({ id: "T-74" }));
    await user.click(issueButton() as HTMLElement);
    expect(createCalls()).toEqual([[repositoryId, "create", { taskId: "T-74" }]]);
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    finish({ ok: true, number: 88 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ["cli_missing", "The GitHub issue was not created: the GitHub CLI is not installed."],
    ["not_signed_in", "The GitHub issue was not created: you are not signed in to GitHub."],
    ["no_access", "The GitHub issue was not created: you cannot create issues in this repository."],
    ["issues_disabled", "The GitHub issue was not created: issues are turned off for this repository."],
    ["failed", "GitHub did not accept the issue. Try again."],
    ["unavailable", "The GitHub issue could not be created."],
  ])("says why one line and keeps the action after %s", async (error, message) => {
    taskIssues.mockResolvedValue({ ok: false, error });
    const user = userEvent.setup();
    render(editModal({ id: `T-8${error.length}` }));
    await user.click(issueButton() as HTMLElement);
    expect(await screen.findByText(message)).toHaveAttribute("role", "status");
    expect(issueButton()).toBeEnabled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("reads the board again on a conflict", async () => {
    taskIssues.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(editModal({ id: "T-90" }));
    await user.click(issueButton() as HTMLElement);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByText("This task already has a GitHub issue, or one is being created.")).toBeInTheDocument();
  });
});

describe("the bridge wrapper", () => {
  it("answers a number or a fixed error, and anything else is unavailable", async () => {
    taskIssues.mockResolvedValueOnce({ ok: true, number: 5 });
    await expect(createTaskIssue(repositoryId, "T-100")).resolves.toEqual({ ok: true, number: 5 });
    for (const answer of [{ ok: true, number: 0 }, { ok: true, number: 1.5 }, { ok: true }, { ok: false, error: "boom" }, { ok: false, error: "limit" }, null]) {
      taskIssues.mockResolvedValueOnce(answer as GitHubAnswer);
      await expect(createTaskIssue(repositoryId, "T-100")).resolves.toEqual({ ok: false, error: "unavailable" });
    }
    taskIssues.mockRejectedValueOnce(new Error("ipc"));
    await expect(createTaskIssue(repositoryId, "T-100")).resolves.toEqual({ ok: false, error: "unavailable" });
    await expect(createTaskIssue(repositoryId, "not-a-task")).resolves.toEqual({ ok: false, error: "invalid" });
    expect(createCalls().every((call) => Object.keys(call[2]).join() === "taskId")).toBe(true);
  });

  it("remembers the last failure per task, clears it on success, and keeps at most 64", async () => {
    taskIssues.mockResolvedValueOnce({ ok: false, error: "no_access" });
    await createTaskIssue(repositoryId, "T-200");
    expect(issueCreateFailure(repositoryId, "T-200")).toBe("no_access");
    taskIssues.mockResolvedValueOnce({ ok: true, number: 9 });
    await createTaskIssue(repositoryId, "T-200");
    expect(issueCreateFailure(repositoryId, "T-200")).toBeNull();
    for (let index = 0; index < 70; index += 1) rememberIssueCreateFailure(repositoryId, `T-${300 + index}`, "failed");
    expect(issueCreateFailure(repositoryId, "T-300")).toBeNull();
    expect(issueCreateFailure(repositoryId, "T-369")).toBe("failed");
    expect(issueCreateFailureMessage("failed")).toBe("GitHub did not accept the issue. Try again.");
  });

  it("returns the new task's ID from a create, only when it is a task ID", async () => {
    taskAction.mockResolvedValueOnce({ ok: true, taskId: "T-12" });
    await expect(createDesktopTask(repositoryId, { text: "x" })).resolves.toEqual({ ok: true, taskId: "T-12" });
    taskAction.mockResolvedValueOnce({ ok: true, taskId: "../etc" });
    await expect(createDesktopTask(repositoryId, { text: "x" })).resolves.toEqual({ ok: true, taskId: null });
    taskAction.mockResolvedValueOnce({ ok: true });
    await expect(createDesktopTask(repositoryId, { text: "x" })).resolves.toEqual({ ok: true, taskId: null });
  });
});
