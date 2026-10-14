import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

// Delete feature in the Feature modal: the footer, its inline confirmation, the refusal while a task runs, and what follows.

const mock = vi.hoisted(() => ({ board: undefined as unknown, listeners: new Set<() => void>() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../app/tasks-store", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => { mock.listeners.add(listener); return () => { mock.listeners.delete(listener); }; };
  const snapshot = () => mock.board as never;
  return { useTasks: () => ({ board: useSyncExternalStore(subscribe, snapshot, snapshot), refresh }) };
});
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const repositoryId = "repo-0123456789abcdef01234567";
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [{
  id: repositoryId, name: "pomegr", displayName: "Pomegr", sessionCount: 0, liveCount: 0, historyCount: 0, providerCount: 0, updatedAt: null, providers: [],
}] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));
const access = vi.hoisted(() => ({ mode: "local" as "unknown" | "local" | "lan" }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => ({ mode: access.mode }), clientAccessMode: () => access.mode }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { FEATURE_DELETE_FAILURE_MESSAGE, featureBlocker, featureDeleteLine, featureRunningLine } from "../../app/components/tasks/feature-form";
import { deleteDesktopFeature } from "../../app/components/tasks/task-desktop";

type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const taskFeature = vi.fn();
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
const session = { id: "claude:abc", title: "Running", state: "working", observedModel: null };

// Retry telemetry holds three tasks, one done. Docs holds none. Single holds one.
const features = [{ id: "f1", name: "Retry telemetry", done: false }, { id: "f2", name: "Docs", done: false }, { id: "f3", name: "Single", done: false }];
const tasks = () => [
  task(1, "Route", { featureId: "f1", state: "done", session: { ...session, state: "closed" } }),
  task(2, "Store", { featureId: "f1" }),
  task(3, "Columns", { featureId: "f1", state: "queued" }),
  task(4, "Loose end"),
  task(5, "Alone in a feature", { featureId: "f3" }),
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
// What the board holds once feature f1 is deleted: its tasks stay, with no feature.
const afterDelete = () => boardOf({
  features: features.filter((feature) => feature.id !== "f1"),
  tasks: tasks().map((entry) => (entry.featureId === "f1" ? { ...entry, featureId: null } : entry)),
});

beforeEach(() => {
  access.mode = "local";
  mock.board = boardOf();
  refresh.mockResolvedValue(undefined);
  taskAction.mockResolvedValue({ ok: true });
  taskFeature.mockResolvedValue({ ok: true, description: "Uploads fail silently.", appVersion: "1.4.0" });
  setBridge({ taskAction, taskFeature });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mock.listeners.clear();
});

const user = () => userEvent.setup();
const filter = () => within(screen.getByRole("group", { name: "Filter by feature" }));
const choose = (label: string) => chooseCommandOption(filter().getByRole("combobox", { name: "Feature" }), label);
async function openEdit(u: ReturnType<typeof userEvent.setup>, label = "Retry telemetry (3)") {
  choose(label);
  await u.click(filter().getByRole("button", { name: "Edit feature" }));
  const dialog = within(screen.getByRole("dialog", { name: "Feature" }));
  await waitFor(() => expect(dialog.getByRole("textbox", { name: "Description" })).toBeEnabled());
  return dialog;
}

describe("the copy", () => {
  it("names what happens to the tasks, in the singular for one", () => {
    expect(featureDeleteLine(0)).toBe("Delete this feature? This cannot be undone.");
    expect(featureDeleteLine(1)).toBe("Delete this feature? Its 1 task stays on the board with no feature. This cannot be undone.");
    expect(featureDeleteLine(2)).toBe("Delete this feature? Its 2 tasks stay on the board with no feature. This cannot be undone.");
    expect(featureDeleteLine(12)).toBe("Delete this feature? Its 12 tasks stay on the board with no feature. This cannot be undone.");
    expect(featureRunningLine("T-34")).toBe("T-34 is running. Delete the feature after its tasks finish.");
    expect(FEATURE_DELETE_FAILURE_MESSAGE).toBe("The feature could not be deleted.");
  });

  it("names the first task that has started and is not done, by ID, and none when only done or unstarted ones remain", () => {
    const held = [
      task(9, "Later", { featureId: "f1", session }),
      task(7, "Earlier", { featureId: "f1", state: "stalled" }),
      task(2, "Done", { featureId: "f1", state: "done", session }),
      task(3, "Idle", { featureId: "f1" }),
      task(1, "Other feature", { featureId: "f2", session }),
    ];
    expect(featureBlocker(held, "f1")?.id).toBe("T-7");
    expect(featureBlocker(held, "f2")?.id).toBe("T-1");
    expect(featureBlocker(held, "f9")).toBeNull();
    expect(featureBlocker(held.filter((entry) => entry.id === "T-2" || entry.id === "T-3"), "f1")).toBeNull();
    expect(featureBlocker([task(4, "Needs review", { featureId: "f1", state: "needs_review" })], "f1")?.id).toBe("T-4");
  });
});

describe("the Feature modal footer, idle", () => {
  it("draws a Quiet Delete feature, the spacer, and the one primary Save, in that order", async () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(user());
    const footer = document.querySelector(".taskModalFooter") as HTMLElement;
    const remove = dialog.getByRole("button", { name: "Delete feature" });
    expect(remove).toHaveClass("commandQuietAction");
    expect(remove).toBeEnabled();
    expect(remove).toHaveAttribute("type", "button");
    const [first, spacer, last] = [...footer.children];
    expect(first).toBe(remove);
    expect(spacer).toHaveClass("taskModalSpacer");
    expect(last).toHaveClass("commandPrimaryAction");
    expect(last).toHaveTextContent("Save");
    expect(footer.querySelector(".taskModalResolve")).toBeNull();
  });
});

describe("the inline confirmation", () => {
  it("replaces the footer with a group, a line naming the tasks, a Secondary Delete feature and a Quiet Keep feature that takes focus", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    const group = dialog.getByRole("group", { name: "Confirm delete" });
    expect(group).toHaveClass("taskModalConfirm");
    expect(within(group).getByText("Delete this feature? Its 3 tasks stay on the board with no feature. This cannot be undone.")).toHaveClass("taskModalNote");
    const [note, spacer, remove, keep] = [...group.children];
    expect(note).toHaveClass("taskModalNote");
    expect(spacer).toHaveClass("taskModalSpacer");
    expect(remove).toHaveClass("commandSecondaryAction");
    expect(remove).toHaveTextContent("Delete feature");
    expect(keep).toHaveClass("commandQuietAction");
    expect(keep).toHaveTextContent("Keep feature");
    expect(keep).toHaveFocus();
    expect(dialog.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("says nothing of tasks for a feature with none, and uses the singular for one", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const empty = await openEdit(u, "Docs (0)");
    await u.click(empty.getByRole("button", { name: "Delete feature" }));
    expect(empty.getByText("Delete this feature? This cannot be undone.")).toBeInTheDocument();
    await u.click(empty.getByRole("button", { name: "Keep feature" }));
    await u.click(empty.getByRole("button", { name: "Close" }));
    const single = await openEdit(u, "Single (1)");
    await u.click(single.getByRole("button", { name: "Delete feature" }));
    expect(single.getByText("Delete this feature? Its 1 task stays on the board with no feature. This cannot be undone.")).toBeInTheDocument();
  });

  it("returns to the idle footer on Keep feature and sends nothing", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await u.click(dialog.getByRole("button", { name: "Keep feature" }));
    expect(dialog.queryByRole("group", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete feature" })).toHaveClass("commandQuietAction");
    expect(dialog.getByRole("button", { name: "Save" })).toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("a task that has started and is not done", () => {
  it("names the first one, disables Delete feature, and opens no confirmation", async () => {
    const u = user();
    mock.board = boardOf({ tasks: tasks().map((entry) => (entry.id === "T-3" ? { ...entry, session } : entry)) });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    const footer = document.querySelector(".taskModalFooter") as HTMLElement;
    expect(footer.querySelector(".taskModalResolve .taskModalNote")).toHaveTextContent("T-3 is running. Delete the feature after its tasks finish.");
    const remove = dialog.getByRole("button", { name: "Delete feature" });
    expect(remove).toBeDisabled();
    expect(remove).toHaveClass("commandQuietAction");
    await u.click(remove);
    expect(dialog.queryByRole("group", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(footer.querySelector(".taskModalResolve")?.nextElementSibling).toBe(remove);
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("does not block on a done task that has a session, and a board that starts a task later disables the button", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    expect(dialog.getByRole("button", { name: "Delete feature" })).toBeEnabled();
    publish(boardOf({ tasks: tasks().map((entry) => (entry.id === "T-2" ? { ...entry, state: "needs_review" as const, session } : entry)) }));
    expect(dialog.getByRole("button", { name: "Delete feature" })).toBeDisabled();
    expect(document.querySelector(".taskModalResolve")).toHaveTextContent("T-2 is running.");
  });
});

describe("after Delete feature", () => {
  it("closes the modal, reads the board again, returns the filter to All, and focuses the filter", async () => {
    const u = user();
    refresh.mockImplementation(async () => { publish(afterDelete()); });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_delete", { id: "f1" });
    expect(refresh).toHaveBeenCalled();
    const select = filter().getByRole("combobox", { name: "Feature" });
    expect(select).toHaveTextContent("All (5)");
    await waitFor(() => expect(select).toHaveFocus());
    expect(filter().queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
    // The tasks stay on the board.
    for (const id of ["T-1", "T-2", "T-3"]) expect(document.querySelector(`[data-task-id="${id}"]`)).not.toBeNull();
  });

  it("focuses New task when the last feature goes and the filter row with it", async () => {
    const u = user();
    mock.board = boardOf({ features: [features[0]], tasks: tasks().filter((entry) => entry.featureId === "f1") });
    refresh.mockImplementation(async () => { publish(boardOf({ features: [], tasks: tasks().filter((entry) => entry.featureId === "f1").map((entry) => ({ ...entry, featureId: null })) })); });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u, "Retry telemetry (3)");
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument());
    expect(screen.queryByRole("group", { name: "Filter by feature" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: /New task/u })).toHaveFocus());
  });
});

describe("a failed delete", () => {
  it.each(["conflict", "not_found", "invalid", "unavailable"])("keeps the modal open on %s, returns to the idle footer, and shows one fixed line", async (error) => {
    const u = user();
    taskAction.mockResolvedValue({ ok: false, error });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    const line = await dialog.findByRole("alert");
    expect(line).toHaveTextContent("The feature could not be deleted.");
    expect(line).toHaveClass("newTaskError");
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(dialog.queryByRole("group", { name: "Confirm delete" })).not.toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Delete feature" })).toBeEnabled();
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Retry telemetry");
    expect(refresh).not.toHaveBeenCalled();
    // Trying again clears the line before it asks.
    await u.click(dialog.getByRole("button", { name: "Delete feature" }));
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("Delete feature is the desktop app's", () => {
  it("is not in the New feature modal", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await u.click(filter().getByRole("button", { name: "+ New feature" }));
    const dialog = within(screen.getByRole("dialog", { name: "New feature" }));
    expect(dialog.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("sends feature_delete through the desktop bridge with the ID alone", async () => {
    expect(await deleteDesktopFeature(repositoryId, "feat-0123456789ab")).toEqual({ ok: true });
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_delete", { id: "feat-0123456789ab" });
  });

  it("is refused on a paired device and without a bridge, and nothing is sent", async () => {
    setBridge(undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const mode of ["lan", "local", "unknown"] as const) {
      access.mode = mode;
      expect(await deleteDesktopFeature(repositoryId, "feat-0123456789ab")).toEqual({ ok: false, error: "unavailable" });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(taskAction).not.toHaveBeenCalled();
  });
});
