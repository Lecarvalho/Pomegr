import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskCheck, TaskQueue, TaskQueuePauseReason, TaskQueueStatus } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TasksTab } from "../../app/components/tasks/TasksTab";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
const report = (results: [TaskCheck, boolean][], blockReason: string | null = null): NonNullable<Task["report"]> => ({
  at: "2026-10-08T12:00:00.000Z", results: results.map(([check, passed]) => ({ check, passed })), blockReason,
});

/** T-12 needs review (Pull request open failed, Working tree clean passed), T-13 stalled, T-14 blocked, T-15 and T-16 queued. */
const tasks = () => [
  task(12, "Store", { state: "needs_review", report: report([["pr_open", false], ["tree_clean", true]]) }),
  task(13, "Gates", { state: "stalled" }),
  task(14, "Tools", { state: "blocked", report: report([], "Needs a decision about secrets") }),
  task(15, "Advance", { state: "queued" }),
  task(16, "Adapter", { state: "queued" }),
];

function setBoard(queue: Partial<TaskQueue> = {}, overrides: Partial<TaskBoard> = {}) {
  const board: TaskBoard = {
    version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: tasks(),
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-15", "T-16"], ...queue }, ...overrides,
  };
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

const viewSwitch = () => within(screen.getByRole("group", { name: "Tasks view" }));
const queueSwitch = () => within(screen.getByRole("group", { name: "Queue" }));
const banner = () => screen.getByRole("region", { name: "Queue status" });
const queueSettings = () => taskAction.mock.calls.filter((call) => call[1] === "queue_settings");
const chipText = (id: string) => document.querySelector(`li[data-task-id="${id}"]`)?.querySelector(".commandChip")?.textContent;

async function showQueue() {
  await userEvent.click(viewSwitch().getByRole("button", { name: "Queue" }));
}
async function renderOn(view: "board" | "queue") {
  render(<TasksTab repositoryId={repositoryId} />);
  if (view === "queue") await showQueue();
}

describe("the queue switch", () => {
  it("is a two-segment Off | On group in the desktop app, beside the view switch", () => {
    render(<TasksTab repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Queue" });
    expect(group).toHaveClass("commandSegmented");
    expect(within(group).getAllByRole("button").map((button) => button.textContent)).toEqual(["Off", "On"]);
    expect(group.closest(".taskHeadActions")).toBe(screen.getByRole("group", { name: "Tasks view" }).closest(".taskHeadActions"));
  });

  it("is absent without the desktop bridge, with the board still readable", () => {
    setBridge(undefined);
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("group", { name: "Queue" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Off" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Tasks view" })).toBeInTheDocument();
  });

  it("is absent until the board is ready", () => {
    setBoard({}, { readiness: "loading", tasks: [] });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByRole("group", { name: "Queue" })).not.toBeInTheDocument();
  });

  it.each<[TaskQueueStatus, "Off" | "On"]>([
    ["idle", "Off"],
    ["running", "On"],
    ["blocked", "On"],
    ["paused", "On"],
  ])("presses %s as %s", (status, pressed) => {
    setBoard({ status, blockedBy: status === "idle" || status === "running" ? null : "T-12" });
    render(<TasksTab repositoryId={repositoryId} />);
    for (const side of ["Off", "On"]) expect(queueSwitch().getByRole("button", { name: side })).toHaveAttribute("aria-pressed", String(side === pressed));
  });

  it.each(["board", "queue"] as const)("is drawn on the %s view", async (view) => {
    await renderOn(view);
    expect(screen.getByRole("group", { name: "Queue" })).toBeInTheDocument();
  });

  it("sends queue_settings on, then refreshes", async () => {
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "On" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { on: true }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("sends queue_settings off from a running queue", async () => {
    setBoard({ status: "running" });
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "Off" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { on: false }));
  });

  it("turns a held queue off, blocked or paused", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" });
    const view = render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "Off" }));
    await waitFor(() => expect(queueSettings()).toEqual([[repositoryId, "queue_settings", { on: false }]]));
    view.unmount();
    taskAction.mockClear();
    setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "start_failed" });
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "Off" }));
    await waitFor(() => expect(queueSettings()).toEqual([[repositoryId, "queue_settings", { on: false }]]));
  });

  it.each<[string, TaskQueueStatus, "Off" | "On"]>([
    ["Off on an idle queue", "idle", "Off"],
    ["On on a running queue", "running", "On"],
    ["On on a blocked queue", "blocked", "On"],
  ])("sends nothing for %s, the side already shown", async (_name, status, side) => {
    setBoard({ status, blockedBy: status === "blocked" ? "T-12" : null });
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: side }));
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("sends on again for On while paused, which is the retry", async () => {
    setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "start_failed" });
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "On" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_settings", { on: true }));
  });

  it("says so in one fixed line when the change fails", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "unavailable" });
    render(<TasksTab repositoryId={repositoryId} />);
    await userEvent.click(queueSwitch().getByRole("button", { name: "On" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The queue setting could not be changed.");
  });
});

describe("the queue status line", () => {
  it.each<[TaskQueueStatus, string]>([
    ["idle", "The queue is off. Queued tasks start only when you start them."],
    ["running", "The queue is on. The next queued task starts when the one before it is done."],
  ])("reads the %s queue in every client", (status, line) => {
    setBoard({ status });
    for (const bridge of [{ taskAction }, undefined]) {
      setBridge(bridge);
      const view = render(<TasksTab repositoryId={repositoryId} />);
      expect(screen.getByText(line)).toHaveClass("taskBoardNote");
      view.unmount();
    }
  });

  it.each<TaskQueueStatus>(["blocked", "paused"])("adds nothing for a %s queue, which the banner words", (status) => {
    setBoard({ status, blockedBy: "T-12", pauseReason: status === "paused" ? "start_failed" : null });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByText(/^The queue is (on|off)\./)).not.toBeInTheDocument();
  });

  it("is not drawn before the board is ready", () => {
    setBoard({}, { readiness: "loading", tasks: [] });
    render(<TasksTab repositoryId={repositoryId} />);
    expect(screen.queryByText(/^The queue is (on|off)\./)).not.toBeInTheDocument();
  });
});

describe("the Queue banner", () => {
  it.each(["idle", "running"] as const)("is not drawn for a %s queue on either view", async (status) => {
    setBoard({ status });
    await renderOn("board");
    expect(screen.queryByRole("region", { name: "Queue status" })).not.toBeInTheDocument();
    await showQueue();
    expect(screen.queryByRole("region", { name: "Queue status" })).not.toBeInTheDocument();
    expect(screen.queryByText("Queue blocked")).not.toBeInTheDocument();
    expect(screen.queryByText("Queue paused")).not.toBeInTheDocument();
  });

  describe.each<[string, string, string]>([
    ["board", "T-12", "T-12 reported complete, but one check did not pass. Running sessions continue. Nothing new starts until you resolve T-12."],
    ["queue", "T-12", 'T-12 reported complete, but the check "Pull request open" did not pass. Running sessions continue. Nothing new starts until you resolve T-12.'],
  ])("for a task that needs review, on the %s view", (view, id, body) => {
    it("reads the blocked copy, naming the failed check only on the Queue", async () => {
      setBoard({ status: "blocked", blockedBy: id });
      await renderOn(view as "board" | "queue");
      expect(within(banner()).getByText("Queue blocked")).toBeInTheDocument();
      expect(within(banner()).getByText(body)).toBeInTheDocument();
    });
  });

  it.each(["board", "queue"] as const)("reads the stalled and blocked copy on the %s view without printing the block reason", async (view) => {
    setBoard({ status: "blocked", blockedBy: "T-13" });
    const first = render(<TasksTab repositoryId={repositoryId} />);
    if (view === "queue") await showQueue();
    expect(within(banner()).getByText("T-13's session ended with no report. Running sessions continue. Nothing new starts until you resolve T-13.")).toBeInTheDocument();
    first.unmount();
    setBoard({ status: "blocked", blockedBy: "T-14" });
    await renderOn(view);
    expect(within(banner()).getByText("T-14's agent reported it cannot continue. Running sessions continue. Nothing new starts until you resolve T-14.")).toBeInTheDocument();
    expect(banner()).not.toHaveTextContent("secrets");
  });

  it("counts failed checks on the Board and names each of them on the Queue", async () => {
    const several = task(12, "Store", { state: "needs_review", report: report([["pr_open", false], ["tree_clean", false], ["ci_passed", true]]) });
    setBoard({ status: "blocked", blockedBy: "T-12" }, { tasks: [several, task(15, "Advance", { state: "queued" })] });
    await renderOn("board");
    expect(banner()).toHaveTextContent("T-12 reported complete, but 2 checks did not pass.");
    await showQueue();
    expect(banner()).toHaveTextContent('T-12 reported complete, but the checks "Pull request open", "Working tree clean" did not pass.');
  });

  it("says a check did not pass when the report names none", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" }, { tasks: [task(12, "Store", { state: "needs_review", report: null })] });
    await renderOn("board");
    expect(banner()).toHaveTextContent("T-12 reported complete, but a check did not pass. Running sessions continue.");
    await showQueue();
    expect(banner()).toHaveTextContent("T-12 reported complete, but a check did not pass. Running sessions continue.");
  });

  it("does not name a blocker the board does not hold, and offers no action for it", async () => {
    setBoard({ status: "blocked", blockedBy: "T-99" });
    await renderOn("queue");
    expect(within(banner()).getByText("A task needs you. Running sessions continue. Nothing new starts until it is resolved.")).toBeInTheDocument();
    expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("is drawn above the board on the Board view and above the queue on the Queue view", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("board");
    expect(banner().compareDocumentPosition(screen.getByRole("region", { name: "Task board" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await showQueue();
    expect(banner().compareDocumentPosition(screen.getByRole("region", { name: "Single tasks" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers only Open on the Board", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("board");
    expect(within(banner()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Open T-12"]);
  });

  it("offers Open, Mark done and resume, and Requeue on the Queue, each in its role", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("queue");
    const buttons = within(banner()).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Open T-12", "Mark done and resume", "Requeue T-12"]);
    expect(buttons[0]).toHaveClass("commandSecondaryAction");
    expect(buttons[1]).toHaveClass("commandSecondaryAction");
    expect(buttons[2]).toHaveClass("commandQuietAction");
  });

  it("opens the Task panel of the named task", async () => {
    setBoard({ status: "blocked", blockedBy: "T-13" });
    await renderOn("board");
    await userEvent.click(within(banner()).getByRole("button", { name: "Open T-13" }));
    expect(screen.getByRole("dialog", { name: "Task T-13" })).toBeInTheDocument();
  });

  it("marks the task done and resumes with resolve_done for that task", async () => {
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("queue");
    await userEvent.click(within(banner()).getByRole("button", { name: "Mark done and resume" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_done", { id: "T-12" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("requeues the task with resolve_requeue for that task", async () => {
    setBoard({ status: "blocked", blockedBy: "T-14" });
    await renderOn("queue");
    await userEvent.click(within(banner()).getByRole("button", { name: "Requeue T-14" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "resolve_requeue", { id: "T-14" }));
  });

  it("shows one fixed line when the monitor refuses a resolution", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("queue");
    await userEvent.click(within(banner()).getByRole("button", { name: "Mark done and resume" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The task could not be marked done.");
    await userEvent.click(within(banner()).getByRole("button", { name: "Requeue T-12" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The task could not be requeued."));
  });

  it("is read-only without the desktop bridge: the words, no action", async () => {
    setBridge(undefined);
    setBoard({ status: "blocked", blockedBy: "T-12" });
    await renderOn("board");
    expect(within(banner()).getByText("Queue blocked")).toBeInTheDocument();
    expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
    await showQueue();
    expect(within(banner()).getByText(/^T-12 reported complete, but the check "Pull request open" did not pass\./)).toBeInTheDocument();
    expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("the paused Queue banner", () => {
  it.each<[TaskQueuePauseReason | null, string]>([
    ["cli_missing", "the provider's command-line tool was not found on this computer."],
    ["plugin_missing", "the Pomegr plugin is not installed in this repository, or needs an update."],
    ["unsupported_platform", "starting sessions is available on Windows only."],
    ["start_failed", "the terminal window could not be opened."],
    ["session_not_linked", "its terminal opened, but the session did not report back."],
    ["worktree_dirty", "its worktree has uncommitted changes, and Pomegr never removes them."],
    [null, "the start did not succeed."],
  ])("words the %s reason on both views", async (pauseReason, reason) => {
    setBoard({ status: "paused", blockedBy: "T-15", pauseReason });
    await renderOn("board");
    const body = `T-15 could not start: ${reason} Running sessions continue. Turn the queue on again to retry.`;
    expect(within(banner()).getByText("Queue paused")).toBeInTheDocument();
    expect(within(banner()).getByText(body)).toBeInTheDocument();
    await showQueue();
    expect(within(banner()).getByText(body)).toBeInTheDocument();
  });

  describe("Open folder", () => {
    const taskWorktreeOpen = vi.fn<(repositoryId: string, taskId: string) => Promise<unknown>>();
    beforeEach(() => { taskWorktreeOpen.mockReset(); taskWorktreeOpen.mockResolvedValue({ status: "opened" }); });

    it("is offered for a dirty worktree on the desktop and calls the bridge with the two IDs only", async () => {
      setBridge({ taskAction, taskWorktreeOpen });
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "worktree_dirty" });
      await renderOn("queue");
      await userEvent.click(within(banner()).getByRole("button", { name: "Open folder" }));
      expect(taskWorktreeOpen).toHaveBeenCalledExactlyOnceWith(repositoryId, "T-15");
      expect(within(banner()).queryByText("The folder could not be opened.")).not.toBeInTheDocument();
    });

    it.each<[string, string]>([
      ["opened", "The folder is open."],
      ["not_found", "The worktree folder was not found."],
      ["invalid", "The folder could not be opened."],
      ["unavailable", "The folder could not be opened."],
      ["something else", "The folder could not be opened."],
    ])("shows one fixed line for the %s result and never a path", async (status, line) => {
      taskWorktreeOpen.mockResolvedValue({ status, path: "D:\\private-folder\\worktree" });
      setBridge({ taskAction, taskWorktreeOpen });
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "worktree_dirty" });
      await renderOn("queue");
      await userEvent.click(within(banner()).getByRole("button", { name: "Open folder" }));
      expect(await within(banner()).findByRole("status")).toHaveTextContent(line);
      expect(banner()).not.toHaveTextContent("private-folder");
    });

    it("shows one fixed line when the bridge throws", async () => {
      taskWorktreeOpen.mockRejectedValue(new Error("D:\\private-folder"));
      setBridge({ taskAction, taskWorktreeOpen });
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "worktree_dirty" });
      await renderOn("queue");
      await userEvent.click(within(banner()).getByRole("button", { name: "Open folder" }));
      expect(await within(banner()).findByRole("status")).toHaveTextContent("The folder could not be opened.");
      expect(banner()).not.toHaveTextContent("private-folder");
    });

    it("is absent on a desktop build that cannot open a folder, and the dirty reason is still worded", async () => {
      setBridge({ taskAction });
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "worktree_dirty" });
      await renderOn("queue");
      expect(within(banner()).queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
      expect(within(banner()).getByRole("button", { name: "Open T-15" })).toBeInTheDocument();
      expect(banner()).toHaveTextContent("its worktree has uncommitted changes");
    });

    it("is absent without the desktop bridge and for every other reason", async () => {
      setBridge(undefined);
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "worktree_dirty" });
      await renderOn("queue");
      expect(within(banner()).queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
    });

    it("is absent for a paused queue with another reason", async () => {
      setBridge({ taskAction, taskWorktreeOpen });
      setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "start_failed" });
      await renderOn("queue");
      expect(within(banner()).queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
    });
  });

  it("does not name a task when the monitor names none", async () => {
    setBoard({ status: "paused", blockedBy: null, pauseReason: "cli_missing" });
    await renderOn("board");
    expect(banner()).toHaveTextContent("A task could not start: the provider's command-line tool was not found on this computer. Running sessions continue.");
    expect(within(banner()).queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers only Open for the task that did not start, on both views", async () => {
    setBoard({ status: "paused", blockedBy: "T-15", pauseReason: "plugin_missing" });
    await renderOn("board");
    expect(within(banner()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Open T-15"]);
    await showQueue();
    expect(within(banner()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Open T-15"]);
    await userEvent.click(within(banner()).getByRole("button", { name: "Open T-15" }));
    expect(screen.getByRole("dialog", { name: "Task T-15" })).toBeInTheDocument();
  });
});

describe("Queued · next while the queue is held", () => {
  it.each([["board"], ["queue"]] as const)("follows queue.order on the %s view", async (view) => {
    setBoard({ status: "blocked", blockedBy: "T-12", order: ["T-16", "T-15"] });
    await renderOn(view);
    expect(chipText("T-16")).toBe("Queued · next");
    expect(chipText("T-15")).toBe("Queued");
    expect(screen.getAllByText("Queued · next")).toHaveLength(1);
  });
});

describe("the When the queue blocks panel", () => {
  it("lists the three outcomes with the exact copy, each state in its tone", async () => {
    await renderOn("queue");
    const panel = screen.getByRole("region", { name: "When the queue blocks" });
    expect(within(panel).getByRole("heading", { name: "When the queue blocks" })).toBeInTheDocument();
    const items = within(panel).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "A check does not pass after the agent reports complete: Needs review",
      "The session ends with no report: Stalled",
      "The agent reports it cannot continue: Blocked by agent",
    ]);
    expect(within(items[0]).getByText("Needs review")).toHaveClass("isReview");
    expect(within(items[1]).getByText("Stalled")).toHaveClass("isError");
    expect(within(items[2]).getByText("Blocked by agent")).toHaveClass("isError");
  });

  it("follows the feature panels and the single tasks", async () => {
    await renderOn("queue");
    expect(screen.getByRole("region", { name: "Single tasks" }).compareDocumentPosition(screen.getByRole("region", { name: "When the queue blocks" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is drawn for an empty queue too", async () => {
    setBoard({ order: [] }, { tasks: [task(1, "Idea")] });
    await renderOn("queue");
    expect(screen.getByText(/Nothing is in the queue yet\./)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "When the queue blocks" })).toBeInTheDocument();
  });

  it("is drawn in a read-only client and not on the Board", async () => {
    setBridge(undefined);
    await renderOn("board");
    expect(screen.queryByRole("region", { name: "When the queue blocks" })).not.toBeInTheDocument();
    await showQueue();
    expect(screen.getByRole("region", { name: "When the queue blocks" })).toBeInTheDocument();
  });
});
