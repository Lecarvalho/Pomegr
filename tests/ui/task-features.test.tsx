import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

// The tasks store is replaced by a small external store so a committed board change re-renders the tab, which is
// how a feature created through the bridge reaches the modal that asked for it.
const mock = vi.hoisted(() => ({ board: undefined as unknown, pending: undefined as unknown, listeners: new Set<() => void>() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../app/tasks-store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { mock.listeners.add(listener); return () => { mock.listeners.delete(listener); }; };
  const snapshot = () => mock.board as never;
  return { useTasks: () => ({ board: useSyncExternalStore(subscribe, snapshot, snapshot), refresh }) };
});
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const DEFAULT_COMPLETE_WHEN = { checks: ["pr_open", "tree_clean"], own: null };

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished): T-1 (done), T-2, T-3, T-4 (queued), T-7 to T-10.
 * Finished work (done): T-5. Docs (unfinished, empty). T-6 has no feature.
 */
const tasks = () => [
  task(1, "Route", { featureId: "f1", state: "done" }),
  task(2, "Store", { featureId: "f1" }),
  task(3, "Columns", { featureId: "f1" }),
  task(4, "Queue", { featureId: "f1", state: "queued", columnId: "col-2", position: 0 }),
  task(5, "Old work", { featureId: "f2", state: "done" }),
  task(6, "Loose end"),
  // T-10 is the newest task, so a new task opens with its Complete when.
  ...[7, 8, 9, 10].map((id) => task(id, `Gate ${id}`, { featureId: "f1", columnId: "col-2", position: id, completeWhen: { checks: ["pr_open", "tree_clean"], own: null } })),
];
const features = [
  { id: "f1", name: "Task board v1", done: false },
  { id: "f2", name: "Finished work", done: true },
  { id: "f3", name: "Docs", done: false },
];

function boardOf(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId, columns, features, tasks: tasks(), queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, ...overrides };
}
function publish(board: TaskBoard) {
  act(() => { mock.board = board; for (const listener of [...mock.listeners]) listener(); });
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  mock.board = boardOf();
  mock.pending = undefined;
  refresh.mockImplementation(async () => { if (mock.pending) publish(mock.pending as TaskBoard); });
  // feature_create commits a new feature that the next refresh shows.
  taskAction.mockImplementation(async (_repository, action, payload) => {
    if (action === "feature_create") {
      mock.pending = boardOf({ features: [...features, { id: "f-new", name: (payload as { name: string }).name, done: false }] });
    }
    return { ok: true };
  });
  setBridge({ taskAction });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mock.listeners.clear();
});

const optionLabels = (trigger: HTMLElement) => {
  fireEvent.click(trigger);
  const labels = screen.getAllByRole("option").map((option) => option.textContent);
  fireEvent.click(trigger);
  return labels;
};
const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const column = (name: string) => screen.getByRole("region", { name });
const featureLine = (id: string) => card(id).querySelector(".taskCardFeature");
const cardIds = () => [...document.querySelectorAll("li.taskCard")].map((element) => element.getAttribute("data-task-id"));

async function openNew(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New task" }));
  await user.type(screen.getByRole("textbox", { name: "Task" }), "Write the guide");
  return within(screen.getByRole("dialog", { name: "New task" }));
}
async function openTask(user: ReturnType<typeof userEvent.setup>, title: string, id: string) {
  await user.click(within(document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement).getByRole("button", { name: title }));
  expect(document.querySelector(".taskModalId")).toHaveTextContent(id);
  return within(screen.getByRole("dialog", { name: "Task" }));
}
const save = () => screen.getByRole("button", { name: "Save" });
const closeModal = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Close" }));
const lastCall = (action: string) => taskAction.mock.calls.filter((call) => call[1] === action).at(-1)?.[2];

describe("New task modal: Feature", () => {
  it("offers only unfinished features, then No feature and New feature…, defaulting to No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    const feature = dialog.getByRole("combobox", { name: "Feature" });
    expect(feature).toHaveTextContent("No feature");
    expect(optionLabels(feature)).toEqual(["Task board v1", "Docs", "No feature", "New feature…"]);
    expect(dialog.queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
    expect(dialog.queryByText("In this feature")).not.toBeInTheDocument();
  });

  it("creates a task in a feature, and with no feature keys for No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(lastCall("create")).toEqual({ text: "Write the guide", run: { provider: "claude", model: null, effort: "medium" }, completeWhen: DEFAULT_COMPLETE_WHEN, featureId: "f1" });
    expect(lastCall("create")).not.toHaveProperty("step");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument());

    expect(dialog.queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();

    dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(lastCall("create")).toEqual({ text: "Write the guide", run: { provider: "claude", model: null, effort: "medium" }, completeWhen: DEFAULT_COMPLETE_WHEN });
    expect(lastCall("create")).not.toHaveProperty("featureId");
  });

  it("creates a new feature first, then the task in it, once the committed board lists it", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    const name = dialog.getByRole("textbox", { name: "Feature name" });
    expect(name).toHaveAttribute("maxlength", "80");
    expect(dialog.getByRole("button", { name: "Create task" })).toBeDisabled();
    // Nothing exists yet, so there is no list to show.
    expect(dialog.queryByText("In this feature")).not.toBeInTheDocument();
    await user.type(name, "  Brand new  ");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction.mock.calls.map((call) => call[1])).toEqual(["feature_create", "create"]);
    expect(taskAction.mock.calls[0]).toEqual([repositoryId, "feature_create", { name: "Brand new" }]);
    expect(taskAction.mock.calls[1][2]).toEqual({ text: "Write the guide", run: { provider: "claude", model: null, effort: "medium" }, completeWhen: DEFAULT_COMPLETE_WHEN, featureId: "f-new" });
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument());
  });

  it.each([
    ["conflict", "A feature with this name already exists."],
    ["limit", "The board holds 50 features, the most it allows."],
    ["invalid", "The feature could not be created."],
  ])("keeps the panel and creates no task when the feature fails with %s", async (error, message) => {
    taskAction.mockResolvedValue({ ok: false, error });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Docs");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(message);
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(dialog.getByRole("textbox", { name: "Feature name" })).toHaveValue("Docs");
    expect(dialog.getByRole("button", { name: "Create task" })).toBeEnabled();
  });

  it("folds the feature's tasks away by default and lists id, title and state when opened", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    const details = dialog.getByText("In this feature").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")).toHaveTextContent("In this feature8 tasks · 1 done");
    const rows = [...details.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-task-id"))).toEqual(["T-1", "T-2", "T-3", "T-4", "T-7", "T-8", "T-9", "T-10"]);
    expect(rows[0]).toHaveTextContent("T-1Route");
    expect(within(rows[0] as HTMLElement).getByText("Done")).toHaveClass("commandChip");
    expect(within(rows[3] as HTMLElement).getByText("Queued")).toHaveClass("commandChip");
    expect(rows[0].querySelector(".taskFeatureStep")).toBeNull();
    // Titles are plain text in this panel.
    expect(within(details).queryByRole("button")).not.toBeInTheDocument();
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f3");
    expect(dialog.getByText("In this feature").closest("details")).toHaveTextContent("0 tasks · 0 done");
  });
});

describe("Task modal: Feature", () => {
  it("shows the stored feature and no Step field", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("Task board v1");
    expect(dialog.queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
    expect(save()).toBeDisabled();
    await closeModal(user);
    const loose = await openTask(user, "Loose end", "T-6");
    expect(loose.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(loose.queryByRole("combobox", { name: "Step" })).not.toBeInTheDocument();
  });

  it("keeps a finished feature for its own task", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Queue", "T-4");
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("Task board v1");
    await closeModal(user);
    const old = await openTask(user, "Old work", "T-5");
    // A done task has started, so its feature only shows, as a value of the Run settings.
    expect(old.getByText("Feature", { selector: "dt" }).nextElementSibling).toHaveTextContent("Finished work");
    expect(old.queryByRole("combobox", { name: "Feature" })).not.toBeInTheDocument();
  });

  it("folds the other tasks, in board order, with this task counted but not listed", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    const details = dialog.getByText("In this feature").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")).toHaveTextContent("8 tasks · 1 done");
    const rows = [...details.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-task-id"))).toEqual(["T-1", "T-3", "T-4", "T-7", "T-8", "T-9", "T-10"]);
    expect(rows.map((row) => row.querySelector(".taskFeatureStep"))).toEqual(Array(7).fill(null));
    expect(rows[0]).toHaveTextContent("T-1RouteDone");
    expect(rows[0]).toHaveClass("isDone");
    expect(rows[1]).not.toHaveClass("isDone");
  });

  it("opens a sibling's own modal from its title in the list", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    fireEvent.click(dialog.getByRole("button", { name: "Columns" }));
    expect(screen.getAllByRole("dialog", { name: "Task" })).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Task" }).querySelector(".taskModalId")).toHaveTextContent("T-3");
    expect(screen.getByRole("dialog", { name: "Task" })).toHaveTextContent("Columns");
  });

  it("sends nothing on a change, then one update with the feature keys on Save: another feature, No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f3");
    expect(taskAction).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-2", featureId: "f3" });
    expect(lastCall("update")).not.toHaveProperty("step");
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());

    dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(lastCall("update")).toEqual({ id: "T-2", featureId: null });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps Save disabled when the feature is chosen back to the stored value", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    expect(save()).toBeEnabled();
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    expect(save()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("keeps a task unchanged when its own feature is chosen back", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    expect(save()).toBeEnabled();
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    expect(save()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("creates a new feature only on Save, then updates the task with the new id", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    expect(save()).toBeDisabled();
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Brand new{Enter}");
    expect(taskAction).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction.mock.calls[0]).toEqual([repositoryId, "feature_create", { name: "Brand new" }]);
    expect(taskAction.mock.calls[1]).toEqual([repositoryId, "update", { id: "T-6", featureId: "f-new" }]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
  });

  it("does not commit a new feature name on blur, and an empty name or Escape leaves the stored feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Blurred");
    await user.tab();
    expect(taskAction).not.toHaveBeenCalled();
    expect(dialog.getByRole("textbox", { name: "Feature name" })).toHaveValue("Blurred");

    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Dropped{Escape}");
    expect(screen.getByRole("dialog", { name: "Task" })).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(save()).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("shows the fixed message for a duplicate feature name on Save, stays open and keeps the name", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Docs");
    await user.click(save());
    expect(await dialog.findByText("A feature with this name already exists.")).toBeInTheDocument();
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Task" })).toBeInTheDocument();
    expect(dialog.getByRole("textbox", { name: "Feature name" })).toHaveValue("Docs");
  });

  it("says so once when the monitor refuses the feature on Save (a finished one), stays open and keeps the draft", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    await user.click(save());
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not join that feature. It may be finished.");
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Task" })).toBeInTheDocument();
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("Task board v1");
    expect(save()).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("attaches a retry to the feature it already created, never creating it twice", async () => {
    taskAction.mockImplementation(async (_repository, action, payload) => {
      if (action === "feature_create") mock.pending = boardOf({ features: [...features, { id: "f-new", name: (payload as { name: string }).name, done: false }] });
      return action === "update" && taskAction.mock.calls.filter((call) => call[1] === "update").length === 1 ? { ok: false, error: "unavailable" } : { ok: true };
    });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Loose end", "T-6");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "new");
    await user.type(dialog.getByRole("textbox", { name: "Feature name" }), "Once");
    await user.click(save());
    expect(await dialog.findByRole("alert")).toHaveTextContent("The change could not be saved.");
    await user.click(save());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());
    expect(taskAction.mock.calls.map((call) => call[1])).toEqual(["feature_create", "update", "update"]);
    expect(taskAction.mock.calls[2][2]).toEqual({ id: "T-6", featureId: "f-new" });
  });
});

describe("Feature filter and card feature line", () => {
  it("draws no filter row when the board has no feature", () => {
    mock.board = boardOf({ features: [], tasks: [task(1, "Loose")] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("group", { name: "Filter by feature" })).not.toBeInTheDocument();
    expect(card("T-1")).not.toHaveTextContent("step");
  });

  it("offers New feature in the Board header while the board has no feature, and once in the filter row after", async () => {
    const user = userEvent.setup();
    mock.board = boardOf({ features: [], tasks: [task(1, "Loose")] });
    const view = render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "+ New feature" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "First");
    await user.click(screen.getByRole("button", { name: "Create feature" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_create", { name: "First" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New feature" })).not.toBeInTheDocument());
    mock.board = boardOf();
    view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.getAllByRole("button", { name: "+ New feature" })).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Filter by feature" })).getByRole("button", { name: "+ New feature" })).toBeInTheDocument();
  });

  it("counts tasks per option, selects All first, and hides non-matching cards in every column", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Filter by feature" });
    expect(within(group).getByText("Feature")).toBeInTheDocument();
    const select = within(group).getByRole("combobox", { name: "Feature" });
    expect(select).toHaveTextContent("All (10)");
    // A done feature sits last, below No feature, muted, and its name ends in "done".
    expect(optionLabels(select)).toEqual(["All (10)", "Task board v1 (8)", "Docs (0)", "No feature (1)", "Finished work (1), done"]);
    fireEvent.click(select);
    expect(screen.getByRole("option", { name: "Finished work (1), done" })).toHaveAttribute("data-muted", "true");
    expect(screen.getByRole("option", { name: "Docs (0)" })).not.toHaveAttribute("data-muted");
    fireEvent.click(select);
    expect(within(group).getByRole("button", { name: "+ New feature" })).toBeInTheDocument();

    fireEvent.click(select);
    expect(screen.getByRole("option", { name: "All (10)" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Task board v1 (8)" })).toHaveAttribute("aria-selected", "false");
    fireEvent.click(select);

    chooseCommandOption(select, "Task board v1 (8)");
    expect(select).toHaveTextContent("Task board v1 (8)");
    expect(cardIds()).toEqual(["T-1", "T-2", "T-3", "T-4", "T-7", "T-8", "T-9", "T-10"]);
    expect(within(column("Backlog")).getAllByRole("listitem")).toHaveLength(3);
    expect(column("Ready").querySelectorAll("li.taskCard")).toHaveLength(5);

    chooseCommandOption(select, "No feature (1)");
    expect(cardIds()).toEqual(["T-6"]);
    chooseCommandOption(select, "All (10)");
    expect(select).toHaveTextContent("All (10)");
    expect(cardIds()).toHaveLength(10);
  });

  it("turns card dragging and the move toolbar off while a feature filter is on", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const select = within(screen.getByRole("group", { name: "Filter by feature" })).getByRole("combobox", { name: "Feature" });
    expect(card("T-2")).toHaveAttribute("draggable", "true");
    expect(card("T-2").querySelector(".taskCardMoves")).not.toBeNull();
    chooseCommandOption(select, "Task board v1 (8)");
    expect(card("T-2")).not.toHaveAttribute("draggable");
    expect(card("T-2").querySelector(".taskCardMoves")).toBeNull();
    expect(screen.getByText("Moving cards is off while a feature filter is on.")).toBeInTheDocument();
    chooseCommandOption(select, "All (10)");
    expect(card("T-2")).toHaveAttribute("draggable", "true");
    expect(screen.queryByText("Moving cards is off while a feature filter is on.")).not.toBeInTheDocument();
  });

  it("adds a feature from the filter row through the bridge, and the board is read again", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "+ New feature" }));
    expect(screen.getByRole("dialog", { name: "New feature" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Feature name" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Fresh");
    await user.click(screen.getByRole("button", { name: "Create feature" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_create", { name: "Fresh" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New feature" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "+ New feature" })).toBeInTheDocument();
  });

  it("shows the fixed line under the title when a feature title is already used, and keeps the modal and the text", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "+ New feature" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), "Docs");
    await user.click(screen.getByRole("button", { name: "Create feature" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Another feature already has this title.");
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Docs");
    expect(screen.getByRole("dialog", { name: "New feature" })).toBeInTheDocument();
  });

  it("shows only the feature name on a card, after the ID in the meta row", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(featureLine("T-1")?.closest(".taskCardTop")).not.toBeNull();
    expect(featureLine("T-1")?.textContent).toBe("· Task board v1");
    expect(featureLine("T-1")).toHaveAttribute("title", "Task board v1");
    expect(featureLine("T-1")?.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(featureLine("T-2")?.textContent).toBe("· Task board v1");
    expect(featureLine("T-9")?.textContent).toBe("· Task board v1");
    expect(featureLine("T-1")?.querySelector("svg")).toBeNull();
    expect(within(card("T-5")).getByText("Finished work")).toBeInTheDocument();
    expect(card("T-6")).not.toHaveTextContent("step");
    // The card draws no feature line at its bottom any more: only the keyboard move toolbar ends it.
    expect(card("T-2").querySelectorAll(".taskCardFeature")).toHaveLength(1);
    expect(card("T-2").querySelector(".taskCardTop")?.nextElementSibling).not.toHaveClass("taskCardFeature");
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("reads: the filter row and card lines show, and no mutation control is drawn", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Filter by feature" });
    expect(within(group).queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    // The filter is the only Feature select: no Task modal field is drawn outside it.
    expect(screen.getAllByRole("combobox", { name: "Feature" })).toEqual([within(group).getByRole("combobox", { name: "Feature" })]);
    expect(featureLine("T-2")?.textContent).toBe("· Task board v1");
    chooseCommandOption(within(group).getByRole("combobox", { name: "Feature" }), "No feature (1)");
    expect(cardIds()).toEqual(["T-6"]);
    expect(card("T-6")).not.toHaveAttribute("draggable");
    expect(screen.queryByText(/Moving cards is off/)).not.toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("renders the board view read-only on its own", () => {
    render(<TaskBoardView board={boardOf()} />);
    expect(screen.getByRole("group", { name: "Filter by feature" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
  });
});

describe("feature styles", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
  const rule = (selector: string) => {
    const escaped = selector.replace(/[.[\]":()+>*-]/g, "\\$&");
    const match = styles.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
    expect(match, `${selector} rule`).not.toBeNull();
    return match![1];
  };

  it("maps the Feature row, disclosure and filter contract lines to tokens", () => {
    // In the Feature row the folded list is the value's second line, without rules of its own.
    expect(rule(".taskRow .taskFeatureDetails")).toMatch(/border: 0/);
    // The 32px summary is for a fine pointer at 761px and wider; a phone and a coarse pointer keep the 44px summary.
    expect(styles).toMatch(/@media \(min-width: 761px\) and \(pointer: fine\) \{ \.taskRow \.taskFeatureDetails > summary \{ min-height: var\(--control-compact\); \} \}/);
    expect(styles).not.toMatch(/\n\.taskRow \.taskFeatureDetails > summary \{/);
    expect(rule(".taskFeatureDetails")).toMatch(/border-top: 1px solid var\(--command-line\); border-bottom: 1px solid var\(--command-line\)/);
    expect(rule(".taskFeatureDetails > summary")).toMatch(/min-height: 44px[^}]*500 var\(--text-sm\)/);
    expect(rule(".taskFeatureItem")).toMatch(/gap: var\(--space-2\); min-height: var\(--control-compact\); padding-block: var\(--space-2\)/);
    expect(rule(".taskFeatureTitle")).toMatch(/overflow: hidden; display: -webkit-box[^}]*-webkit-line-clamp: 2; line-clamp: 2/);
    expect(rule(".taskFeatureId")).toMatch(/flex: 0 0 40px[^}]*var\(--font-data\)/);
    expect(rule(".taskFeatureFilter")).toMatch(/gap: var\(--space-2\)/);
    expect(rule(".taskFilterEyebrow")).toMatch(/500 var\(--text-caption\)[^}]*text-transform: uppercase/);
    expect(styles).not.toMatch(/\.taskFeature[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);
  });
});
