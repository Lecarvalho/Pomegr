import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { createEmptyTaskBoard, type Task, type TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory = vi.hoisted(() => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] } as RepositoryInventorySnapshot }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory.snapshot, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskFieldsSection } from "../../app/components/design-system/DesignSystemTaskFieldsSample";
import { PromoteIssuesView } from "../../app/components/tasks/PromoteIssuesView";
import { TaskModal } from "../../app/components/tasks/TaskModal";
import type { TaskIssue } from "../../app/components/tasks/task-issues-desktop";
import { promotePatch } from "../../app/components/tasks/task-modal-types";
import { DEFAULT_DONE_WHEN, EMPTY_RUN } from "../../app/components/tasks/task-fields";
import { NO_FEATURE_DRAFT } from "../../app/components/tasks/task-features";

const repositoryId = "repo-0123456789abcdef01234567";
const DIGEST = "a".repeat(64);
const NEW_DIGEST = "b".repeat(64);

type Answer = Record<string, unknown>;
const taskIssues = vi.fn<(repositoryId: string, operation: string, payload: Record<string, unknown>) => Promise<Answer>>();
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: boolean; error?: string }>>();
const refresh = vi.fn(async () => {});
const onPromoted = vi.fn<(taskId: string) => void>();
const onClose = vi.fn();

function issue(overrides: Partial<TaskIssue> = {}): TaskIssue {
  return {
    number: 139, title: "Queue pauses when the worktree is on another drive", body: "The queue pauses when the data folder is on D:.\n\nThe manual start works.",
    bodyTruncated: false, hiddenComments: { count: 0, ranges: [] }, characters: 142, tooLong: false, authorAssociation: "collaborator",
    updatedAt: "2026-10-08T12:00:00.000Z", digest: DIGEST, taskId: null, ...overrides,
  };
}

/** A bridge answer for one issue, shaped like the monitor's list entry. */
function entry(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...issue({ number, title: `Issue ${number} title`, body: `Body of issue ${number}.` }), ...overrides };
}
const list = (issues: Record<string, unknown>[]): Answer => ({ ok: true, status: "ok", readAt: "2026-10-09T09:00:00.000Z", truncated: false, issues });

const board: TaskBoard = {
  ...createEmptyTaskBoard(repositoryId, "ready"),
  columns: [{ id: "col-1", name: "Backlog", position: 0 }],
  features: [{ id: "feat-1", name: "Queue polish", done: false }],
};

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

beforeEach(() => {
  inventory.snapshot = { revision: 1, readiness: "ready", repositories: [{
    id: repositoryId, name: "example", displayName: "Example project", sessionCount: 0, liveCount: 0, historyCount: 0, providerCount: 0, updatedAt: null, providers: [],
  }] };
  useTasks.mockReturnValue({ board, refresh });
  taskIssues.mockImplementation(async (_repository, operation) => operation === "promote" ? { ok: true, taskId: "T-40" } : list([entry(144), entry(139)]));
  taskAction.mockResolvedValue({ ok: true });
  setBridge({ taskAction, taskIssues });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

/** The modal in mode issue. `reload` stands in for the page: it may hand the modal a newer version of the issue. */
function Harness({ first = issue(), reload = async () => {} }: { first?: TaskIssue; reload?: (show: (next: TaskIssue) => void) => Promise<void> }) {
  const [current, setCurrent] = useState(first);
  return <TaskModal mode="issue" repositoryId={repositoryId} repositoryName="Example project" issue={current} board={board} refresh={refresh}
    onReload={() => reload(setCurrent)} onPromoted={onPromoted} onClose={onClose} />;
}

const dialog = () => screen.getByRole("dialog", { name: "New task" });
const footer = () => within(document.querySelector(".taskModalFooter") as HTMLElement);
const promoteButton = () => footer().getByRole("button", { name: "Promote issue" });
const promoteCalls = () => taskIssues.mock.calls.filter((call) => call[1] === "promote");
const updateCalls = () => taskAction.mock.calls.filter((call) => call[1] === "update");

describe("mode issue", () => {
  it("shows the issue as a read-only summary above the New task fields, with no Task field", () => {
    render(<Harness />);
    const modal = within(dialog());
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    expect(modal.getByRole("heading", { level: 2, name: "New task" })).toBeInTheDocument();
    expect(dialog().querySelector(".taskModalSubtitle")).toHaveTextContent("Example project · in Backlog");
    // The Source group: the label, the issue chip, who opened it, and the title as text.
    expect(dialog().querySelector(".taskSourceLabel")).toHaveTextContent("Source");
    expect(modal.getByRole("img", { name: "GitHub issue #139" })).toHaveClass("commandChip", "taskIssueChip");
    expect(dialog().querySelector(".taskSourceRow")).toHaveTextContent("Collaborator");
    expect(modal.getByRole("heading", { level: 3, name: "Queue pauses when the worktree is on another drive" })).toBeInTheDocument();
    // The raw body is read-only text with its count; the renderer never supplies task text.
    expect(modal.getByRole("region", { name: "Raw body" })).toHaveTextContent("The queue pauses when the data folder is on D:.");
    expect(modal.getByText("142 / 4,000 characters")).not.toHaveClass("over");
    expect(modal.queryByRole("textbox", { name: "Task" })).not.toBeInTheDocument();
    expect(dialog().querySelector("textarea")).toBeNull();
    // The same fields as New task, with the same defaults.
    expect(modal.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(modal.getByRole("combobox", { name: "Step" })).toBeDisabled();
    expect(modal.getByRole("combobox", { name: "Run on" })).toHaveTextContent("Not set");
    expect(modal.getByRole("group", { name: "Effort" })).toBeInTheDocument();
    expect(modal.getByRole("checkbox", { name: "PR open" })).toBeChecked();
    expect(modal.getByRole("checkbox", { name: "Tree clean" })).toBeChecked();
    expect(modal.getByRole("checkbox", { name: "CI passed" })).not.toBeChecked();
    expect(modal.getByRole("textbox", { name: "Own condition" })).toBeInTheDocument();
    // Footer: the closes line, a Quiet Cancel and the one Primary.
    expect(document.querySelector(".taskModalCloses")).toHaveTextContent("The pull request will say Closes #139.");
    expect(footer().getByRole("button", { name: "Cancel" })).toHaveClass("commandQuietAction");
    expect(promoteButton()).toHaveClass("commandPrimaryAction");
    expect(promoteButton()).toBeEnabled();
    expect(dialog().querySelectorAll(".commandPrimaryAction")).toHaveLength(1);
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("shows the notices in order and refuses a too long issue without a call", async () => {
    const user = userEvent.setup();
    const body = "Start <!-- internal note --> end";
    const start = body.indexOf("<!--");
    render(<Harness first={issue({ authorAssociation: "outsider", body, hiddenComments: { count: 1, ranges: [{ start, end: body.indexOf("-->") + 3 }] }, characters: 9480, tooLong: true })} />);
    const notices = [...dialog().querySelectorAll(".taskNotice")].map((node) => node.textContent);
    expect(notices).toEqual([
      "Opened by someone outside the repository. Read the whole body before promoting.",
      "1 hidden comment found. GitHub does not show it on the issue page. It is not copied into the task.",
      "The task text would be 9,480 characters and a task holds 4,000. Shorten the issue, or write the task by hand.",
    ]);
    expect(dialog().querySelector(".taskIssueHidden")).toHaveTextContent("<!-- internal note -->");
    expect(screen.getByText("9,480 / 4,000 characters")).toHaveClass("over");
    expect(dialog().querySelector(".taskSourceRow")).toHaveTextContent("Too long");
    expect(promoteButton()).toBeDisabled();
    await user.click(promoteButton());
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("promotes by number and digest, sends no text, then sends the default conditions in one update and closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(promoteCalls()).toEqual([[repositoryId, "promote", { number: 139, digest: DIGEST }]]);
    expect(Object.keys(promoteCalls()[0][2])).toEqual(["number", "digest"]);
    // Nothing the issue says goes back through the bridge.
    expect(JSON.stringify([...taskIssues.mock.calls, ...taskAction.mock.calls])).not.toMatch(/worktree|manual start|D:/);
    // The monitor makes the task with no checks, so the checked defaults differ and are sent; nothing else is.
    expect(taskAction.mock.calls).toEqual([[repositoryId, "update", { id: "T-40", doneWhen: { checks: ["pr_open", "tree_clean"], own: null } }]]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onPromoted).toHaveBeenCalledWith("T-40");
    expect(onPromoted).toHaveBeenCalledTimes(1);
  });

  it("sends no update when nothing differs from the task the monitor made", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: "PR open" }));
    await user.click(screen.getByRole("checkbox", { name: "Tree clean" }));
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(promoteCalls()).toHaveLength(1);
    expect(taskAction).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onPromoted).toHaveBeenCalledWith("T-40");
  });

  it("sends only the keys that were chosen", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    chooseCommandOption(screen.getByRole("combobox", { name: "Feature" }), "feature:feat-1");
    await user.click(screen.getByRole("button", { name: "High" }));
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(updateCalls()).toEqual([[repositoryId, "update", {
      id: "T-40", run: { provider: null, model: null, effort: "high" }, doneWhen: { checks: ["pr_open", "tree_clean"], own: null }, featureId: "feat-1",
    }]]);
    unmount();

    taskAction.mockClear();
    onClose.mockClear();
    render(<Harness />);
    await user.click(screen.getByRole("checkbox", { name: "PR open" }));
    await user.click(screen.getByRole("checkbox", { name: "Tree clean" }));
    await user.type(screen.getByRole("textbox", { name: "Own condition" }), "The store rejects a malformed record.");
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(updateCalls()).toEqual([[repositoryId, "update", { id: "T-40", doneWhen: { checks: [], own: "The store rejects a malformed record." } }]]);
  });

  it("builds the patch from the draft alone", () => {
    expect(promotePatch(EMPTY_RUN, { checks: [], ownText: "  " }, NO_FEATURE_DRAFT)).toBeNull();
    expect(promotePatch(EMPTY_RUN, DEFAULT_DONE_WHEN, NO_FEATURE_DRAFT)).toEqual({ doneWhen: { checks: ["pr_open", "tree_clean"], own: null } });
    expect(promotePatch({ provider: "codex", model: null, effort: null }, { checks: [], ownText: "" }, { featureId: "feat-1", creating: false, name: "", step: 2 }))
      .toEqual({ run: { provider: "codex", model: null, effort: null }, featureId: "feat-1", step: 2 });
  });

  it("answers a conflict with Show new version, keeps the chosen fields, and promotes the new version", async () => {
    const user = userEvent.setup();
    const changed = issue({ digest: NEW_DIGEST, body: "The queue pauses when the data folder is on D:. Edit: it also happens on E:.", characters: 160 });
    const reload = vi.fn(async (show: (next: TaskIssue) => void) => { show(changed); });
    taskIssues.mockResolvedValueOnce({ ok: false, error: "conflict" });
    render(<Harness reload={reload} />);
    await user.click(screen.getByRole("button", { name: "High" }));
    await user.click(promoteButton());
    const notice = await screen.findByText("This issue changed on GitHub or was already promoted.");
    expect(notice.closest(".taskNotice")).toHaveClass("warning");
    expect(notice).toHaveAttribute("role", "alert");
    // Nothing was promoted, so no update; Promote waits for the new version.
    expect(taskAction).not.toHaveBeenCalled();
    expect(promoteButton()).toBeDisabled();
    const show = within(notice.closest(".taskNotice") as HTMLElement).getByRole("button", { name: "Show new version" });
    expect(show).toHaveClass("commandSecondaryAction");

    await user.click(show);
    expect(reload).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("This issue changed on GitHub or was already promoted.")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "Raw body" })).toHaveTextContent("Edit: it also happens on E:.");
    expect(screen.getByRole("button", { name: "High" })).toHaveAttribute("aria-pressed", "true");
    expect(promoteButton()).toBeEnabled();
    expect(onClose).not.toHaveBeenCalled();

    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(promoteCalls().map((call) => call[2])).toEqual([{ number: 139, digest: DIGEST }, { number: 139, digest: NEW_DIGEST }]);
    expect(updateCalls()).toHaveLength(1);
    expect(onPromoted).toHaveBeenCalledTimes(1);
  });

  it("replaces the conflict with the fact when the reread shows the issue is already a task", async () => {
    const user = userEvent.setup();
    const reload = vi.fn(async (show: (next: TaskIssue) => void) => { show(issue({ taskId: "T-31" })); });
    taskIssues.mockResolvedValueOnce({ ok: false, error: "conflict" });
    render(<Harness reload={reload} />);
    await user.click(promoteButton());
    await user.click(await screen.findByRole("button", { name: "Show new version" }));
    // The same digest, but the issue is now a task: the conflict is replaced by the fact.
    expect(await screen.findByText("Already on the board as T-31.")).toBeInTheDocument();
    expect(screen.queryByText("This issue changed on GitHub or was already promoted.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open board" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(promoteButton()).toBeDisabled();
    expect(dialog().querySelector(".taskSourceRow")).toHaveTextContent("Promoted · T-31");
  });

  it("answers limit with the too long notice and a disabled Promote issue", async () => {
    const user = userEvent.setup();
    taskIssues.mockResolvedValueOnce({ ok: false, error: "limit" });
    render(<Harness />);
    await user.click(promoteButton());
    const notice = await screen.findByText("The task text would be longer than the 4,000 characters a task holds. Shorten the issue, or write the task by hand.");
    expect(notice).toHaveClass("taskNotice", "negative");
    expect(promoteButton()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says a closed issue is no longer open, and treats any other failure as a message that allows another try", async () => {
    const user = userEvent.setup();
    taskIssues.mockResolvedValueOnce({ ok: false, error: "not_found" });
    const { unmount } = render(<Harness />);
    await user.click(promoteButton());
    expect(await screen.findByText("This issue is no longer open.")).toHaveClass("taskNotice", "warning");
    expect(promoteButton()).toBeDisabled();
    unmount();

    taskIssues.mockResolvedValueOnce({ ok: false, error: "unavailable" });
    render(<Harness />);
    await user.click(promoteButton());
    expect(await screen.findByText("The issue could not be promoted.")).toHaveClass("taskNotice", "negative");
    expect(promoteButton()).toBeEnabled();
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(promoteCalls()).toHaveLength(3);
    expect(screen.queryByText("The issue could not be promoted.")).not.toBeInTheDocument();
  });

  it("keeps the modal open when the update fails, says the task exists, offers only Close, and never promotes twice", async () => {
    const user = userEvent.setup();
    taskAction.mockResolvedValue({ ok: false, error: "unavailable" });
    render(<Harness />);
    await user.click(promoteButton());
    const notice = await screen.findByText("The issue was promoted to T-40, but the run settings could not be saved. Open the task to set them.");
    expect(notice).toHaveClass("taskNotice", "warning");
    expect(notice).toHaveAttribute("role", "alert");
    expect(onClose).not.toHaveBeenCalled();
    // The task exists: the board is refreshed and the page asked to read again, once.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onPromoted).toHaveBeenCalledWith("T-40");
    expect(onPromoted).toHaveBeenCalledTimes(1);
    // Only Close is left; the fields that no longer apply are gone.
    expect(screen.queryByRole("button", { name: "Promote issue" })).not.toBeInTheDocument();
    expect(footer().getAllByRole("button").map((button) => button.textContent)).toEqual(["Close"]);
    expect(footer().getByRole("button", { name: "Close" })).toHaveClass("commandSecondaryAction");
    expect(screen.queryByRole("combobox", { name: "Run on" })).not.toBeInTheDocument();
    expect(promoteCalls()).toHaveLength(1);
    await user.click(footer().getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(promoteCalls()).toHaveLength(1);
  });

  it("creates a typed feature first, then promotes into it, and holds Promote issue while its name is blank", async () => {
    const user = userEvent.setup();
    function FeatureHarness() {
      const [features, setFeatures] = useState(board.features);
      // The committed board shows the new feature once the modal asks for a refresh.
      const read = async () => { setFeatures((current) => current.some((feature) => feature.name === "Retry telemetry") ? current : [...current, { id: "feat-9", name: "Retry telemetry", done: false }]); };
      return <TaskModal mode="issue" repositoryId={repositoryId} repositoryName="Example project" issue={issue()} board={{ ...board, features }} refresh={read}
        onReload={async () => {}} onPromoted={onPromoted} onClose={onClose} />;
    }
    render(<FeatureHarness />);
    chooseCommandOption(screen.getByRole("combobox", { name: "Feature" }), "new");
    expect(promoteButton()).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Feature name" }), "Retry telemetry");
    expect(promoteButton()).toBeEnabled();
    await user.click(promoteButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(taskAction.mock.calls.map((call) => call[1])).toEqual(["feature_create", "update"]);
    expect(taskAction.mock.calls[0][2]).toEqual({ name: "Retry telemetry" });
    expect(taskAction.mock.calls[1][2]).toEqual({ id: "T-40", doneWhen: { checks: ["pr_open", "tree_clean"], own: null }, featureId: "feat-9" });
    expect(promoteCalls()).toHaveLength(1);
  });

  it("promotes nothing when the feature cannot be created", async () => {
    const user = userEvent.setup();
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    render(<Harness />);
    chooseCommandOption(screen.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(screen.getByRole("textbox", { name: "Feature name" }), "Queue polish");
    await user.click(promoteButton());
    expect(await screen.findByText("A feature with this name already exists.")).toBeInTheDocument();
    expect(promoteCalls()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(promoteButton()).toBeEnabled();
  });

  it("closes with Cancel and Escape without writing anything", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(footer().getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    render(<Harness />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(taskIssues).not.toHaveBeenCalled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("holds Promote issue while a promote runs, so a second click sends nothing", async () => {
    const user = userEvent.setup();
    let release!: (answer: Answer) => void;
    taskIssues.mockImplementationOnce(() => new Promise<Answer>((resolve) => { release = resolve; }));
    render(<Harness />);
    await user.click(promoteButton());
    expect(promoteButton()).toBeDisabled();
    await user.click(promoteButton());
    expect(promoteCalls()).toHaveLength(1);
    release({ ok: true, taskId: "T-40" });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(promoteCalls()).toHaveLength(1);
  });
});

describe("mode edit, the Source block", () => {
  function editModal(source: Task["source"]) {
    return <TaskModal mode="edit" repositoryId={repositoryId} repositoryName="Example project" task={task({ source })} board={board} refresh={refresh}
      onChanged={vi.fn()} onDeleted={vi.fn()} onClose={onClose} />;
  }

  it("starts the body with Source, the issue chip and the caption for a promoted task, and keeps the text editable", async () => {
    const user = userEvent.setup();
    render(editModal({ kind: "github_issue", number: 142 }));
    const body = document.querySelector(".taskModalBody") as HTMLElement;
    const source = body.firstElementChild as HTMLElement;
    expect(source).toHaveClass("taskIssueSource");
    expect(source.querySelector(".taskSourceLabel")).toHaveTextContent("Source");
    expect(within(source).getByRole("img", { name: "GitHub issue #142" })).toHaveClass("commandChip", "taskIssueChip");
    expect(source.querySelector(".taskSourceCaption")).toHaveTextContent("GitHub issue");
    // No promoted-at time: none is stored.
    expect(source).not.toHaveTextContent(/promoted|\d{4}/i);
    const text = screen.getByRole("textbox", { name: "Task" });
    expect(text).not.toHaveAttribute("readonly");
    await user.type(text, " More.");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("draws no issue chip for a task with no source; on the desktop its Source row says Not on GitHub", () => {
    render(editModal(null));
    expect(document.querySelector(".taskIssueChip")).toBeNull();
    expect(screen.getByText("Not on GitHub")).toBeInTheDocument();
  });
});

describe("the Promote issues page", () => {
  const rows = () => within(screen.getByRole("list", { name: "Open issues" })).getAllByRole("button");
  const pageButton = () => screen.getByRole("button", { name: "Promote" });
  const listCalls = () => taskIssues.mock.calls.filter((call) => call[1] === "list");

  it("opens the modal for the chosen issue without a read, and returns focus to Promote on Cancel", async () => {
    const user = userEvent.setup();
    render(<PromoteIssuesView repositoryId={repositoryId} />);
    await screen.findByRole("list", { name: "Open issues" });
    await user.click(pageButton());
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole("img", { name: "GitHub issue #144" })).toBeInTheDocument();
    expect(within(dialog()).getByRole("heading", { level: 3, name: "Issue 144 title" })).toBeInTheDocument();
    expect(dialog().querySelector(".taskModalSubtitle")).toHaveTextContent("Example project · in Backlog");
    expect(taskIssues).toHaveBeenCalledTimes(1);
    await user.click(footer().getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pageButton()).toHaveFocus();
    expect(promoteCalls()).toHaveLength(0);
    expect(listCalls()).toHaveLength(1);
  });

  it("promotes, reads the list once more, and shows the row as promoted", async () => {
    const user = userEvent.setup();
    let promoted = false;
    taskIssues.mockImplementation(async (_repository, operation) => {
      if (operation === "promote") { promoted = true; return { ok: true, taskId: "T-40" }; }
      return list([entry(144, promoted ? { taskId: "T-40" } : {}), entry(139)]);
    });
    render(<PromoteIssuesView repositoryId={repositoryId} />);
    await screen.findByRole("list", { name: "Open issues" });
    await user.click(pageButton());
    await user.click(footer().getByRole("button", { name: "Promote issue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(promoteCalls()).toEqual([[repositoryId, "promote", { number: 144, digest: DIGEST }]]);
    await waitFor(() => expect(rows()[0]).toHaveTextContent("Promoted · T-40"));
    expect(listCalls()).toHaveLength(2);
    expect(screen.getByText("Already on the board as T-40.")).toBeInTheDocument();
    expect(pageButton()).toBeDisabled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("reads once for Show new version, keeps the modal on the same issue with its new version, and promotes it", async () => {
    const user = userEvent.setup();
    let reads = 0;
    taskIssues.mockImplementation(async (_repository, operation) => {
      if (operation === "promote") return reads < 2 ? { ok: false, error: "conflict" } : { ok: true, taskId: "T-40" };
      reads += 1;
      return list([entry(144, reads >= 2 ? { digest: NEW_DIGEST, body: "Body of issue 144, edited." } : {}), entry(139)]);
    });
    render(<PromoteIssuesView repositoryId={repositoryId} />);
    await screen.findByRole("list", { name: "Open issues" });
    await user.click(pageButton());
    await user.click(footer().getByRole("button", { name: "Promote issue" }));
    await user.click(await screen.findByRole("button", { name: "Show new version" }));
    await waitFor(() => expect(screen.queryByText("This issue changed on GitHub or was already promoted.")).not.toBeInTheDocument());
    expect(listCalls()).toHaveLength(2);
    expect(dialog()).toBeInTheDocument();
    expect(within(dialog()).getByRole("region", { name: "Raw body" })).toHaveTextContent("Body of issue 144, edited.");
    await user.click(footer().getByRole("button", { name: "Promote issue" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(promoteCalls().map((call) => call[2])).toEqual([{ number: 144, digest: DIGEST }, { number: 144, digest: NEW_DIGEST }]);
  });

  it("closes the modal and says so when Show new version finds the issue gone", async () => {
    const user = userEvent.setup();
    let reads = 0;
    taskIssues.mockImplementation(async (_repository, operation) => {
      if (operation === "promote") return { ok: false, error: "conflict" };
      reads += 1;
      return list(reads === 1 ? [entry(144), entry(139)] : [entry(139)]);
    });
    render(<PromoteIssuesView repositoryId={repositoryId} />);
    await screen.findByRole("list", { name: "Open issues" });
    await user.click(pageButton());
    await user.click(footer().getByRole("button", { name: "Promote issue" }));
    await user.click(await screen.findByRole("button", { name: "Show new version" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Issue #144 is no longer open.")).toBeInTheDocument();
    expect(rows()).toHaveLength(1);
    expect(listCalls()).toHaveLength(2);
    // The closed issue does not come back as a modal if a later read lists the number again.
    taskIssues.mockImplementation(async () => list([entry(144), entry(139)]));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Issue #144 is no longer open.")).not.toBeInTheDocument();
  });

  it("closes the modal with the list's own message when the reread cannot list issues", async () => {
    const user = userEvent.setup();
    let reads = 0;
    taskIssues.mockImplementation(async (_repository, operation) => {
      if (operation === "promote") return { ok: false, error: "conflict" };
      reads += 1;
      return reads === 1 ? list([entry(144)]) : { ok: true, status: "not_signed_in", readAt: null, truncated: false, issues: [] };
    });
    render(<PromoteIssuesView repositoryId={repositoryId} />);
    await screen.findByRole("list", { name: "Open issues" });
    await user.click(pageButton());
    await user.click(footer().getByRole("button", { name: "Promote issue" }));
    await user.click(await screen.findByRole("button", { name: "Show new version" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("GitHub is not signed in")).toBeInTheDocument();
    expect(screen.queryByText(/is no longer open/)).not.toBeInTheDocument();
  });
});

describe("the /design-system sample and the source", () => {
  it("draws mode issue from static data with the conflict and not-saved states, and the Source block in mode edit", () => {
    setBridge(undefined);
    const { container } = render(<TaskFieldsSection />);
    expect(screen.getByText("Task modal, promote issue")).toBeInTheDocument();
    expect(screen.getByText("Task modal, promote issue, outside contributor and changed")).toBeInTheDocument();
    expect(screen.getByText("Task modal, promote issue, run settings not saved")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Promote issue" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Show new version" })).toHaveClass("commandSecondaryAction");
    expect(screen.getByText("The issue was promoted to T-40, but the run settings could not be saved. Open the task to set them.")).toBeInTheDocument();
    expect(container.querySelector(".taskIssueHidden")).not.toBeNull();
    expect(container.querySelectorAll(".taskSourceCaption")).toHaveLength(1);
    expect(taskIssues).not.toHaveBeenCalled();
  });

  it("treats issue text as text and keeps it out of storage, logs and markup", () => {
    const read = (...path: string[]) => readFileSync(join(process.cwd(), "app", "components", "tasks", ...path), "utf8");
    for (const file of ["TaskModalPromote.tsx", "PromoteIssuesView.tsx", "TaskModal.tsx", "TaskModalEdit.tsx"]) {
      expect(read(file)).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|console\./);
    }
  });
});
