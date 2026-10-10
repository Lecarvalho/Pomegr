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
const DEFAULT_DONE_WHEN = { checks: ["pr_open", "tree_clean"], own: null };

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished): step 1 T-1 (done), step 2 T-2 and T-3, step 3 T-4 (queued), step 4 T-7 to T-10.
 * Finished work (done): T-5. Docs (unfinished, empty). T-6 has no feature.
 */
const tasks = () => [
  task(1, "Route", { featureId: "f1", step: 1, state: "done" }),
  task(2, "Store", { featureId: "f1", step: 2 }),
  task(3, "Columns", { featureId: "f1", step: 2 }),
  task(4, "Queue", { featureId: "f1", step: 3, state: "queued", columnId: "col-2", position: 0 }),
  task(5, "Old work", { featureId: "f2", step: 1, state: "done" }),
  task(6, "Loose end"),
  ...[7, 8, 9, 10].map((id) => task(id, `Gate ${id}`, { featureId: "f1", step: 4, columnId: "col-2", position: id })),
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

describe("New task modal: Feature and Step", () => {
  it("offers only unfinished features, then No feature and New feature…, defaulting to No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    const feature = dialog.getByRole("combobox", { name: "Feature" });
    expect(feature).toHaveTextContent("No feature");
    expect(optionLabels(feature)).toEqual(["Task board v1", "Docs", "No feature", "New feature…"]);
    const step = dialog.getByRole("combobox", { name: "Step" });
    expect(step).toBeDisabled();
    expect(step).toHaveTextContent("None");
    expect(dialog.queryByText("In this feature")).not.toBeInTheDocument();
  });

  it("defaults Step to Last and lists each step from the highest with the other tasks in it", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    const step = dialog.getByRole("combobox", { name: "Step" });
    expect(step).toBeEnabled();
    expect(step).toHaveTextContent("Last · new step 5");
    expect(optionLabels(step)).toEqual([
      "Last · new step 5", "Step 4 · parallel with T-7, T-8, T-9 +1", "Step 3 · parallel with T-4", "Step 2 · parallel with T-2, T-3", "Step 1 · parallel with T-1",
    ]);
    // A feature without tasks offers only its first step.
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f3");
    expect(optionLabels(dialog.getByRole("combobox", { name: "Step" }))).toEqual(["Last · new step 1"]);
  });

  it("creates a task in a feature at the last step, at a chosen step, and with no feature keys for No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(lastCall("create")).toEqual({ text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN, featureId: "f1" });
    expect(lastCall("create")).not.toHaveProperty("step");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument());

    dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Step" }), "step:3");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(lastCall("create")).toEqual({ text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN, featureId: "f1", step: 3 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument());

    dialog = await openNew(user);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f1");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(lastCall("create")).toEqual({ text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN });
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
    expect(dialog.getByRole("combobox", { name: "Step" })).toHaveTextContent("Last · new step 1");
    // Nothing exists yet, so there is no list to show.
    expect(dialog.queryByText("In this feature")).not.toBeInTheDocument();
    await user.type(name, "  Brand new  ");
    await user.click(dialog.getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(taskAction.mock.calls.map((call) => call[1])).toEqual(["feature_create", "create"]);
    expect(taskAction.mock.calls[0]).toEqual([repositoryId, "feature_create", { name: "Brand new" }]);
    expect(taskAction.mock.calls[1][2]).toEqual({ text: "Write the guide", doneWhen: DEFAULT_DONE_WHEN, featureId: "f-new" });
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

describe("Task modal: Feature and Step", () => {
  it("shows the stored feature and step without the task itself in the parallel list", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    expect(dialog.getByRole("combobox", { name: "Feature" })).toHaveTextContent("Task board v1");
    expect(dialog.getByRole("combobox", { name: "Step" })).toHaveTextContent("Step 2 · parallel with T-3");
    expect(optionLabels(dialog.getByRole("combobox", { name: "Step" }))[0]).toBe("Last · new step 5");
    expect(save()).toBeDisabled();
    await closeModal(user);
    const loose = await openTask(user, "Loose end", "T-6");
    expect(loose.getByRole("combobox", { name: "Feature" })).toHaveTextContent("No feature");
    expect(loose.getByRole("combobox", { name: "Step" })).toBeDisabled();
  });

  it("lists a step with no other task as the step alone, and keeps a finished feature for its own task", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Queue", "T-4");
    expect(dialog.getByRole("combobox", { name: "Step" })).toHaveTextContent("Step 3");
    expect(dialog.getByRole("combobox", { name: "Step" })).not.toHaveTextContent("parallel");
    await closeModal(user);
    const old = await openTask(user, "Old work", "T-5");
    expect(old.getByRole("combobox", { name: "Feature" })).toHaveTextContent("Finished work");
    expect(optionLabels(old.getByRole("combobox", { name: "Feature" }))).toEqual(["Task board v1", "Finished work", "Docs", "No feature", "New feature…"]);
  });

  it("folds the other tasks, ordered by step then board order, with this task counted but not listed", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    const details = dialog.getByText("In this feature").closest("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")).toHaveTextContent("8 tasks · 1 done");
    const rows = [...details.querySelectorAll("li")];
    expect(rows.map((row) => row.getAttribute("data-task-id"))).toEqual(["T-1", "T-3", "T-4", "T-7", "T-8", "T-9", "T-10"]);
    expect(rows.map((row) => row.querySelector(".taskFeatureStep")?.textContent)).toEqual(["1", "2", "3", "4", "4", "4", "4"]);
    expect(rows[0]).toHaveTextContent("1T-1RouteDone");
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

  it("sends nothing on a change, then one update with the feature keys on Save: a step, Last, another feature, No feature", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Step" }), "step:3");
    expect(taskAction).not.toHaveBeenCalled();
    expect(save()).toBeEnabled();
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(1));
    expect(taskAction).toHaveBeenLastCalledWith(repositoryId, "update", { id: "T-2", featureId: "f1", step: 3 });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());

    dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Step" }), "last");
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(2));
    expect(lastCall("update")).toEqual({ id: "T-2", featureId: "f1" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());

    dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "feature:f3");
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(3));
    expect(lastCall("update")).toEqual({ id: "T-2", featureId: "f3" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Task" })).not.toBeInTheDocument());

    dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Feature" }), "none");
    expect(dialog.getByRole("combobox", { name: "Step" })).toBeDisabled();
    await user.click(save());
    await waitFor(() => expect(taskAction).toHaveBeenCalledTimes(4));
    expect(lastCall("update")).toEqual({ id: "T-2", featureId: null });
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("keeps Save disabled when the feature and step are chosen back to the stored values", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openTask(user, "Store", "T-2");
    chooseCommandOption(dialog.getByRole("combobox", { name: "Step" }), "step:3");
    expect(save()).toBeEnabled();
    chooseCommandOption(dialog.getByRole("combobox", { name: "Step" }), "step:2");
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
    await user.type(screen.getByRole("textbox", { name: "Feature name" }), "First");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_create", { name: "First" }));
    mock.board = boardOf();
    view.rerender(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.getAllByRole("button", { name: "+ New feature" })).toHaveLength(1);
    expect(within(screen.getByRole("group", { name: "Filter by feature" })).getByRole("button", { name: "+ New feature" })).toBeInTheDocument();
  });

  it("counts tasks per chip, presses All first, and hides non-matching cards in every column", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Filter by feature" });
    expect(within(group).getByText("Feature")).toBeInTheDocument();
    expect(within(group).getAllByRole("button").map((button) => button.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "All 10", "Task board v1 8", "Finished work 1", "Docs 0", "No feature 1", "+ New feature",
    ]);
    expect(within(group).getByRole("button", { name: "All 10" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Task board v1 8" })).toHaveAttribute("aria-pressed", "false");

    await user.click(within(group).getByRole("button", { name: "Task board v1 8" }));
    expect(within(group).getByRole("button", { name: "Task board v1 8" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "All 10" })).toHaveAttribute("aria-pressed", "false");
    expect(cardIds()).toEqual(["T-1", "T-2", "T-3", "T-4", "T-7", "T-8", "T-9", "T-10"]);
    expect(within(column("Backlog")).getAllByRole("listitem")).toHaveLength(3);
    expect(within(column("Ready")).getAllByRole("listitem")).toHaveLength(5);

    await user.click(within(group).getByRole("button", { name: "No feature 1" }));
    expect(cardIds()).toEqual(["T-6"]);
    await user.click(within(group).getByRole("button", { name: "All 10" }));
    expect(cardIds()).toHaveLength(10);
  });

  it("turns card dragging and the move toolbar off while a feature filter is on", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(card("T-2")).toHaveAttribute("draggable", "true");
    expect(card("T-2").querySelector(".taskCardMoves")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Task board v1 8" }));
    expect(card("T-2")).not.toHaveAttribute("draggable");
    expect(card("T-2").querySelector(".taskCardMoves")).toBeNull();
    expect(screen.getByText("Moving cards is off while a feature filter is on.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All 10" }));
    expect(card("T-2")).toHaveAttribute("draggable", "true");
    expect(screen.queryByText("Moving cards is off while a feature filter is on.")).not.toBeInTheDocument();
  });

  it("adds a feature from the filter row through the bridge", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "+ New feature" }));
    await user.type(screen.getByRole("textbox", { name: "Feature name" }), "Fresh");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_create", { name: "Fresh" }));
    expect(refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ New feature" })).toBeInTheDocument());
  });

  it("shows the fixed message when a feature name is already used", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: "+ New feature" }));
    await user.type(screen.getByRole("textbox", { name: "Feature name" }), "Docs");
    await user.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A feature with this name already exists.");
  });

  it("shows '<feature> · step K of N' on a card, with ' · parallel' only when another task shares the step", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(within(card("T-1")).getByText("Task board v1 · step 1 of 4")).toHaveClass("taskCardDetail");
    expect(within(card("T-2")).getByText("Task board v1 · step 2 of 4 · parallel")).toBeInTheDocument();
    expect(within(card("T-4")).getByText("Task board v1 · step 3 of 4")).toBeInTheDocument();
    expect(within(card("T-9")).getByText("Task board v1 · step 4 of 4 · parallel")).toBeInTheDocument();
    expect(within(card("T-5")).getByText("Finished work · step 1 of 1")).toBeInTheDocument();
    expect(card("T-6")).not.toHaveTextContent("step");
    // It is the card's last line; only the keyboard move toolbar follows it.
    expect(card("T-2").querySelector(".taskCardFeature")?.nextElementSibling).toHaveClass("taskCardMoves");
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("reads: the filter row and card lines show, and no mutation control is drawn", async () => {
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const group = screen.getByRole("group", { name: "Filter by feature" });
    expect(within(group).queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New task" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Feature" })).not.toBeInTheDocument();
    expect(within(card("T-2")).getByText("Task board v1 · step 2 of 4 · parallel")).toBeInTheDocument();
    await user.click(within(group).getByRole("button", { name: "No feature 1" }));
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
    expect(rule(".taskFeatureRow")).toMatch(/repeat\(2, minmax\(0, 1fr\)\); gap: var\(--space-4\)/);
    expect(rule(".taskFeatureDetails")).toMatch(/border-top: 1px solid var\(--command-line\); border-bottom: 1px solid var\(--command-line\)/);
    expect(rule(".taskFeatureDetails > summary")).toMatch(/min-height: 44px[^}]*500 var\(--text-sm\)/);
    expect(rule(".taskFeatureItem")).toMatch(/gap: var\(--space-2\); min-height: var\(--control-compact\)/);
    expect(rule(".taskFeatureId")).toMatch(/flex: 0 0 40px[^}]*var\(--font-data\)/);
    expect(rule(".taskFeatureFilter")).toMatch(/gap: var\(--space-2\)/);
    expect(rule(".taskFilterEyebrow")).toMatch(/500 var\(--text-caption\)[^}]*text-transform: uppercase/);
    expect(styles).not.toMatch(/\.taskFeature[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);
  });
});
