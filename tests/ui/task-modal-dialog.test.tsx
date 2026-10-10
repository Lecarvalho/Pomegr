import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
const agents = vi.hoisted(() => ({ runs: [] as Array<{ source: string; model: string | null }> }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: agents.runs }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { TaskModal } from "../../app/components/tasks/TaskModal";
import type { TaskIssue } from "../../app/components/tasks/task-issues-desktop";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

const reviewTask = task(12, {
  text: "Add a private task store.",
  run: { provider: "claude", model: "model-a", effort: "high" },
  doneWhen: { checks: ["pr_open", "tree_clean"], own: "Tests pass." },
  state: "needs_review",
  session: { id: "claude:abc123", title: "Task store and privacy rules", state: "idle", observedModel: "model-b" },
  report: { at: "2026-10-08T11:42:00.000Z", results: [{ check: "pr_open", passed: false }, { check: "tree_clean", passed: true }], blockReason: null },
});

function setBoard(tasks: Task[]) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } };
  useTasks.mockReturnValue({ board, refresh });
  return board;
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  agents.runs = [{ source: "Claude Code", model: "model-a" }, { source: "Claude Code", model: "model-b" }];
  taskAction.mockResolvedValue({ ok: true });
  setBridge({ taskAction });
  setBoard([reviewTask, task(13)]);
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// The modal's dialog is named by its h2 alone ("Task"); the task ID is a sibling span in the header.
const panel = () => screen.queryByRole("dialog", { name: "Task" });
const card = (title: string) => screen.getByRole("button", { name: title });
async function openReviewPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(card("Task store and privacy rules"));
  return within(screen.getByRole("dialog", { name: "Task" }));
}

describe("Task modal dialog, mode edit", () => {
  it("is a modal dialog named by its heading, opened with showModal, with focus moved inside", async () => {
    const prototype = HTMLDialogElement.prototype as { showModal?: () => void };
    const original = Object.getOwnPropertyDescriptor(prototype, "showModal");
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    Object.defineProperty(prototype, "showModal", { configurable: true, writable: true, value: showModal });
    try {
      const user = userEvent.setup();
      render(<TaskBoardPane repositoryId={repositoryId} />);
      await openReviewPanel(user);
      const dialog = screen.getByRole("dialog", { name: "Task" });
      // The browser makes the page behind inert for a native modal; jsdom has no top layer, so the call is the evidence.
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog).toHaveAttribute("open");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog.getAttribute("aria-labelledby")).toBe(within(dialog).getByRole("heading", { level: 2 }).id);
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    } finally {
      if (original) Object.defineProperty(prototype, "showModal", original); else delete prototype.showModal;
    }
  });

  it("keeps Tab and Shift+Tab inside the dialog", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openReviewPanel(user);
    const dialog = screen.getByRole("dialog", { name: "Task" });
    // jsdom's selector engine returns a selector list's matches grouped by selector; browsers return document order.
    const queryAll = dialog.querySelectorAll.bind(dialog);
    (dialog as { querySelectorAll: unknown }).querySelectorAll = (selector: string) =>
      Array.from(queryAll(selector)).sort((left, right) => (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const enabled = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, textarea, a[href], [tabindex]")).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    const first = enabled[0];
    const last = enabled[enabled.length - 1];
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    for (let step = 0; step < enabled.length + 2; step += 1) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("closes on a click on the scrim while the task has nothing to save", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await openReviewPanel(user);
    await user.click(screen.getByRole("dialog", { name: "Task" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("does not close on a click on the scrim with an unsaved draft", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    await user.type(dialog.getByRole("textbox", { name: "Task" }), " draft");
    const scrim = screen.getByRole("dialog", { name: "Task" });
    await user.click(scrim);
    fireEvent.click(scrim);
    expect(panel()).toBeInTheDocument();
    expect((dialog.getByRole("textbox", { name: "Task" }) as HTMLTextAreaElement).value).toBe("Add a private task store. draft");
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("lets an open Run on list take the first Escape, then closes on the next", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const trigger = dialog.getByRole("combobox", { name: "Run on" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(panel()).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("has its own footer: Delete task and Save, and neither Cancel nor Create task", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openReviewPanel(user);
    const footer = within(document.querySelector(".taskModalFooter") as HTMLElement);
    expect(footer.getByRole("button", { name: "Delete task" })).toHaveClass("commandQuietAction");
    expect(footer.getByRole("button", { name: "Save" })).toHaveClass("commandPrimaryAction");
    expect(dialog.queryByRole("button", { name: /^Cancel$|Create task|Create and add another/ })).not.toBeInTheDocument();
    expect(dialog.getByRole("heading", { level: 2, name: "Task" })).toBeInTheDocument();
    expect(dialog.queryByRole("heading", { name: "New task" })).not.toBeInTheDocument();
  });

  it("disables Add to queue, Start session and the resolutions while the draft is unsaved, and enables them when it is undone", async () => {
    const user = userEvent.setup();
    setBridge({ taskAction, taskStart: vi.fn(async () => ({ status: "started" })) });
    setBoard([task(30, { text: "Waiting", run: { provider: "claude", model: null, effort: null } })]);
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Waiting"));
    let dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByRole("button", { name: "Add to queue" })).toBeEnabled();
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "!");
    expect(dialog.getByRole("button", { name: "Add to queue" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Start session" })).toBeDisabled();
    expect(dialog.getByText("Save your changes first.")).toBeInTheDocument();
    await user.type(dialog.getByRole("textbox", { name: "Task" }), "{Backspace}");
    expect(dialog.getByRole("button", { name: "Add to queue" })).toBeEnabled();
    expect(dialog.getByRole("button", { name: "Start session" })).toBeEnabled();
    view.unmount();

    setBoard([reviewTask]);
    render(<TaskBoardPane repositoryId={repositoryId} />);
    dialog = await openReviewPanel(user);
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    expect(dialog.getByRole("button", { name: "Mark done" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Requeue task" })).toBeDisabled();
    expect(dialog.getByText("Save your changes first.")).toBeInTheDocument();
    await user.click(dialog.getByRole("checkbox", { name: "CI passed" }));
    expect(dialog.getByRole("button", { name: "Mark done" })).toBeEnabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("disables Mark done and Requeue task for a task awaiting a report while the draft is unsaved", async () => {
    setBoard([task(20, { text: "In flight", state: "queued", session: { id: "claude:abc126", title: "Working session", state: "working", observedModel: null } })]);
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(card("Working session"));
    const dialog = within(screen.getByRole("dialog", { name: "Task" }));
    expect(dialog.getByRole("button", { name: "Mark done" })).toBeEnabled();
    await user.click(dialog.getByRole("button", { name: "High" }));
    expect(dialog.getByRole("button", { name: "Mark done" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Requeue task" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Remove from queue" })).toBeDisabled();
  });
});

describe("Task modal dialog, mode issue", () => {
  const issue: TaskIssue = {
    number: 139, title: "Queue pauses on another drive", body: "The queue pauses.", bodyTruncated: false, hiddenComments: { count: 0, ranges: [] },
    characters: 40, tooLong: false, authorAssociation: "owner", updatedAt: null, digest: "a".repeat(64), taskId: null,
  };
  const onClose = vi.fn();
  const issueModal = () => <TaskModal mode="issue" repositoryId={repositoryId} repositoryName="Example project" issue={issue} board={setBoard([])} refresh={refresh}
    onReload={async () => {}} onPromoted={vi.fn()} onClose={onClose} />;

  it("is a modal dialog named by its heading, opened with showModal, with focus moved inside", () => {
    const prototype = HTMLDialogElement.prototype as { showModal?: () => void };
    const original = Object.getOwnPropertyDescriptor(prototype, "showModal");
    const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
    Object.defineProperty(prototype, "showModal", { configurable: true, writable: true, value: showModal });
    try {
      render(issueModal());
      const dialog = screen.getByRole("dialog", { name: "New task" });
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog).toHaveAttribute("open");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog.getAttribute("aria-labelledby")).toBe(within(dialog).getByRole("heading", { level: 2 }).id);
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    } finally {
      if (original) Object.defineProperty(prototype, "showModal", original); else delete prototype.showModal;
    }
  });

  it("keeps Tab inside the dialog, ignores a click on the scrim, and closes on Escape or Close", async () => {
    const user = userEvent.setup();
    render(issueModal());
    const dialog = screen.getByRole("dialog", { name: "New task" });
    const queryAll = dialog.querySelectorAll.bind(dialog);
    (dialog as { querySelectorAll: unknown }).querySelectorAll = (selector: string) =>
      Array.from(queryAll(selector)).sort((left, right) => (left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    const enabled = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, textarea, a[href], [tabindex]")).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
    enabled[enabled.length - 1].focus();
    await user.tab();
    expect(document.activeElement).toBe(enabled[0]);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(enabled[enabled.length - 1]);

    await user.click(dialog);
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("lets an open Run on list take the first Escape", async () => {
    const user = userEvent.setup();
    render(issueModal());
    const trigger = within(screen.getByRole("dialog", { name: "New task" })).getByRole("combobox", { name: "Run on" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(onClose).not.toHaveBeenCalled();
  });
});
