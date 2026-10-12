import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import { TASK_BOUNDS, type Task, type TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

// The Feature modal, opened from the Board's filter row in the desktop app: its two modes, its drafts, and its failures.

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
// Which client this is, as `/api/client-access` would answer.
const access = vi.hoisted(() => ({ mode: "local" as "unknown" | "local" | "lan" }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => ({ mode: access.mode }), clientAccessMode: () => access.mode }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { updateDesktopFeature } from "../../app/components/tasks/task-desktop";

type Result = { ok: true } | { ok: false; error: string };
type Read = { ok: true; description: string | null; appVersion: string | null } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const taskFeature = vi.fn<(repositoryId: string, featureId: string) => Promise<Read | unknown>>();
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const STORED = { ok: true, description: "Uploads fail silently.", appVersion: "1.4.0" } as const;

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

// Retry telemetry holds three tasks, one done. Docs holds none.
const features = [{ id: "f1", name: "Retry telemetry", done: false }, { id: "f2", name: "Docs", done: false }];
const tasks = () => [
  task(1, "Route", { featureId: "f1", step: 1, state: "done" }),
  task(2, "Store", { featureId: "f1", step: 2 }),
  task(3, "Columns", { featureId: "f1", step: 2 }),
  task(4, "Loose end"),
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
  access.mode = "local";
  mock.board = boardOf();
  refresh.mockResolvedValue(undefined);
  taskAction.mockResolvedValue({ ok: true });
  taskFeature.mockResolvedValue(STORED);
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
  return dialog;
}
const lastCall = (action: string) => taskAction.mock.calls.filter((call) => call[1] === action).at(-1)?.[2];
async function loaded(dialog: ReturnType<typeof within>) {
  await waitFor(() => expect(dialog.getByRole("textbox", { name: "Description" })).toBeEnabled());
}

describe("the filter row", () => {
  it("shows Edit feature only while one feature is chosen, before + New feature", () => {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(filter().queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
    expect(filter().getByRole("button", { name: "+ New feature" })).toBeInTheDocument();
    choose("Retry telemetry (3)");
    const group = screen.getByRole("group", { name: "Filter by feature" });
    const edit = filter().getByRole("button", { name: "Edit feature" });
    const add = filter().getByRole("button", { name: "+ New feature" });
    expect(edit).toHaveClass("commandQuietAction");
    expect(add).toHaveClass("commandQuietAction");
    expect(edit.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(group.querySelector(".taskFeatureProgress") as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    choose("No feature (1)");
    expect(filter().queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
    expect(filter().getByRole("button", { name: "+ New feature" })).toBeInTheDocument();
    choose("All (4)");
    expect(filter().queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
  });

  it("keeps + New feature in the page header, opening the modal, while the board has no feature", async () => {
    const u = user();
    mock.board = boardOf({ features: [], tasks: [task(4, "Loose end")] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("group", { name: "Filter by feature" })).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "+ New feature" });
    expect(add.closest(".taskHeadActions")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "Feature name" })).not.toBeInTheDocument();
    await u.click(add);
    expect(screen.getByRole("dialog", { name: "New feature" })).toBeInTheDocument();
  });

  it("disables + New feature at the board's feature limit", () => {
    const many = Array.from({ length: TASK_BOUNDS.featuresPerRepository }, (_, index) => ({ id: `f${index}`, name: `Feature ${index}`, done: false }));
    mock.board = boardOf({ features: many, tasks: [] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(filter().getByRole("button", { name: "+ New feature" })).toBeDisabled();
  });

  it("draws neither action without the desktop bridge, nor on a paired device", () => {
    for (const mode of ["local", "lan"] as const) {
      setBridge(undefined);
      access.mode = mode;
      const view = render(<TaskBoardPane repositoryId={repositoryId} />);
      choose("Retry telemetry (3)");
      expect(screen.queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
      view.unmount();
    }
    // A paired device with no feature still has no header action.
    mock.board = boardOf({ features: [], tasks: [] });
    render(<TaskBoardPane repositoryId={repositoryId} />);
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
  });
});

describe("the Feature modal, New feature", () => {
  async function open(u: ReturnType<typeof userEvent.setup>) {
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await u.click(filter().getByRole("button", { name: "+ New feature" }));
    return within(screen.getByRole("dialog", { name: "New feature" }));
  }

  it("holds the three fields with their counters, helpers and copy, and the repository as its subtitle", async () => {
    const dialog = await open(user());
    expect(document.querySelector(".taskModalSubtitle")).toHaveTextContent("Pomegr");
    expect(dialog.queryByText(/ done$/)).not.toBeInTheDocument();
    const title = dialog.getByRole("textbox", { name: "Title" });
    expect(title).toHaveAttribute("maxlength", "80");
    expect(title).toHaveAttribute("placeholder", "What is this feature?");
    expect(title).toHaveFocus();
    expect(dialog.getByText("One line. It names the feature on the board and in the session's prompt.")).toBeInTheDocument();
    const description = dialog.getByRole("textbox", { name: "Description" });
    expect(description).not.toHaveAttribute("maxlength");
    expect(description).toHaveAttribute("placeholder", "What should every task of this feature know?");
    expect(dialog.getByText("The context its tasks share, so each task's own text stays short. An agent reads it when its task needs it.")).toBeInTheDocument();
    const version = dialog.getByRole("textbox", { name: "App version" });
    expect(version).toHaveAttribute("maxlength", "40");
    expect(version).toHaveAttribute("placeholder", "1.4.0");
    expect(dialog.getByText("The version the feature is planned for. Optional, and it gates nothing.")).toBeInTheDocument();
    expect([...document.querySelectorAll(".featureCounter")].map((counter) => counter.textContent)).toEqual(["0 / 80", "0 / 2,000"]);
    expect(dialog.getByRole("button", { name: "Cancel" })).toHaveClass("commandQuietAction");
    expect(dialog.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(taskFeature).not.toHaveBeenCalled();
  });

  it("keeps Create feature disabled until the title holds text, and counts as you type", async () => {
    const u = user();
    const dialog = await open(u);
    const create = dialog.getByRole("button", { name: "Create feature" });
    expect(create).toBeDisabled();
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "Context");
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "   ");
    expect(create).toBeDisabled();
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "Retry");
    expect(create).toBeEnabled();
    expect(document.querySelectorAll(".featureCounter")[0]).toHaveTextContent("8 / 80");
    expect(document.querySelectorAll(".featureCounter")[1]).toHaveTextContent("7 / 2,000");
  });

  it("disables Create feature and turns the Description counter to the error colour past 2,000", async () => {
    const dialog = await open(user());
    fireEvent.change(dialog.getByRole("textbox", { name: "Title" }), { target: { value: "Retry" } });
    fireEvent.change(dialog.getByRole("textbox", { name: "Description" }), { target: { value: "x".repeat(2000) } });
    expect(dialog.getByRole("button", { name: "Create feature" })).toBeEnabled();
    fireEvent.change(dialog.getByRole("textbox", { name: "Description" }), { target: { value: "x".repeat(2001) } });
    expect(document.querySelectorAll(".featureCounter")[1]).toHaveClass("isOver");
    expect(document.querySelectorAll(".featureCounter")[1]).toHaveTextContent("2,001 / 2,000");
    expect(dialog.getByRole("button", { name: "Create feature" })).toBeDisabled();
  });

  it("creates with the title and the details that hold text, trimmed, then closes and reads the board again", async () => {
    const u = user();
    const dialog = await open(u);
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "  Retry telemetry ");
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "Every task works on the uploader.");
    await u.type(dialog.getByRole("textbox", { name: "App version" }), " 1.5.0");
    await u.click(dialog.getByRole("button", { name: "Create feature" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New feature" })).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_create", { name: "Retry telemetry", description: "Every task works on the uploader.", appVersion: "1.5.0" });
    expect(refresh).toHaveBeenCalled();
    expect(filter().getByRole("button", { name: "+ New feature" })).toHaveFocus();
  });

  it("sends the title alone when the two details are blank", async () => {
    const u = user();
    const dialog = await open(u);
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "Only a title");
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "   ");
    await u.click(dialog.getByRole("button", { name: "Create feature" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalled());
    expect(lastCall("feature_create")).toEqual({ name: "Only a title" });
    expect(Object.keys(lastCall("feature_create") as object)).toEqual(["name"]);
  });

  it("keeps the modal open and what was typed after a duplicate title, with the line named by the input", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const u = user();
    const dialog = await open(u);
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "Docs");
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "Kept text");
    await u.click(dialog.getByRole("button", { name: "Create feature" }));
    const line = await dialog.findByRole("alert");
    expect(line).toHaveTextContent("Another feature already has this title.");
    expect(line).toHaveClass("newTaskError");
    expect(dialog.getByRole("textbox", { name: "Title" }).getAttribute("aria-describedby")?.split(" ")).toContain(line.id);
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Docs");
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Kept text");
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveFocus();
    // Typing another title clears it.
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "!");
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    ["unavailable", "The feature could not be saved."],
    ["invalid", "The feature could not be saved."],
    ["limit", "This board already holds 50 features. Delete one first."],
  ])("shows one fixed line after a %s failure and keeps the modal and the text", async (error, line) => {
    taskAction.mockResolvedValue({ ok: false, error });
    const u = user();
    const dialog = await open(u);
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "Retry");
    await u.click(dialog.getByRole("button", { name: "Create feature" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(line);
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Retry");
    expect(dialog.getByRole("button", { name: "Create feature" })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("the Feature modal, Feature", () => {
  it("opens for the chosen feature with its progress chip, its stored values, and one primary Save, with no Delete", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    expect(dialog.getByRole("heading", { level: 2, name: "Feature" })).toBeInTheDocument();
    expect(document.querySelector(".taskModalTitleGroup .commandChip")).toHaveClass("taskCardChip", "neutral");
    expect(document.querySelector(".taskModalTitleGroup .commandChip")).toHaveTextContent("1 of 3 done");
    expect(document.querySelector(".taskModalSubtitle")).toHaveTextContent("Pomegr");
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Retry telemetry");
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Uploads fail silently.");
    expect(dialog.getByRole("textbox", { name: "App version" })).toHaveValue("1.4.0");
    expect(taskFeature).toHaveBeenCalledTimes(1);
    expect(taskFeature).toHaveBeenCalledWith(repositoryId, "f1");
    expect(dialog.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(dialog.getAllByRole("button").filter((button) => button.classList.contains("commandPrimaryAction")).map((button) => button.textContent)).toEqual(["Save"]);
    expect([...document.querySelectorAll(".featureCounter")].map((counter) => counter.textContent)).toEqual(["15 / 80", "22 / 2,000"]);
  });

  it("keeps Description and App version disabled and empty until the read answers, then fills them without a change", async () => {
    let answer: (value: unknown) => void = () => undefined;
    taskFeature.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    expect(dialog.getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("");
    expect(dialog.getByRole("textbox", { name: "App version" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "Title" })).toBeEnabled();
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Retry telemetry");
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(dialog.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { answer(STORED); });
    expect(dialog.getByRole("textbox", { name: "Description" })).toBeEnabled();
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Uploads fail silently.");
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("keeps the two fields disabled with one line when the read fails, and the title can still be saved", async () => {
    taskFeature.mockResolvedValue({ ok: false, error: "unavailable" });
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    expect(await dialog.findByRole("alert")).toHaveTextContent("The description and app version could not be read.");
    expect(dialog.getByRole("textbox", { name: "Description" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "App version" })).toBeDisabled();
    expect(dialog.getByRole("textbox", { name: "Title" })).toBeEnabled();
    await u.type(dialog.getByRole("textbox", { name: "Title" }), " v2");
    await u.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_update", { id: "f1", name: "Retry telemetry v2" }));
  });

  it.each([null, "ok", { ok: true, description: 4, appVersion: null }, { ok: true, description: null }])("treats the read answer %j as a failure", async (answer) => {
    taskFeature.mockResolvedValue(answer);
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    expect(await dialog.findByRole("alert")).toHaveTextContent("The description and app version could not be read.");
  });

  it("treats a rejected read as a failure", async () => {
    taskFeature.mockRejectedValue(new Error("boom"));
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    expect(await dialog.findByRole("alert")).toHaveTextContent("The description and app version could not be read.");
  });

  it("enables Save only once the draft differs, and sends only what changed", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    const save = dialog.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    await u.type(dialog.getByRole("textbox", { name: "Description" }), " More.");
    expect(save).toBeEnabled();
    // A change that is undone is no change, and surrounding blanks are no change.
    await u.type(dialog.getByRole("textbox", { name: "App version" }), " ");
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}");
    expect(save).toBeDisabled();
    await u.type(dialog.getByRole("textbox", { name: "Description" }), " More.");
    await u.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument());
    expect(taskAction).toHaveBeenCalledTimes(1);
    expect(lastCall("feature_update")).toEqual({ id: "f1", description: "Uploads fail silently. More." });
    expect(Object.keys(lastCall("feature_update") as object)).toEqual(["id", "description"]);
    expect(refresh).toHaveBeenCalled();
  });

  it("sends a renamed title alone, trimmed", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    await u.clear(dialog.getByRole("textbox", { name: "Title" }));
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await u.type(dialog.getByRole("textbox", { name: "Title" }), "  Retry events  ");
    await u.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalled());
    expect(lastCall("feature_update")).toEqual({ id: "f1", name: "Retry events" });
  });

  it("sends null for a description or an app version that was emptied", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    await u.clear(dialog.getByRole("textbox", { name: "App version" }));
    await u.clear(dialog.getByRole("textbox", { name: "Description" }));
    await u.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalled());
    expect(lastCall("feature_update")).toEqual({ id: "f1", description: null, appVersion: null });
  });

  it("sends null only for the one field that was emptied", async () => {
    taskFeature.mockResolvedValue({ ok: true, description: null, appVersion: "2.0" });
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("");
    await u.clear(dialog.getByRole("textbox", { name: "App version" }));
    await u.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalled());
    expect(lastCall("feature_update")).toEqual({ id: "f1", appVersion: null });
  });

  it("keeps Save disabled while a field is over its bound", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    fireEvent.change(dialog.getByRole("textbox", { name: "Description" }), { target: { value: "x".repeat(2001) } });
    expect(document.querySelectorAll(".featureCounter")[1]).toHaveClass("isOver");
    expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it.each([
    ["conflict", "Another feature already has this title."],
    ["not_found", "The feature could not be saved."],
    ["unavailable", "The feature could not be saved."],
  ])("keeps the modal and the draft after a %s failure, with one fixed line", async (error, line) => {
    taskAction.mockResolvedValue({ ok: false, error });
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    await u.type(dialog.getByRole("textbox", { name: "Description" }), " More.");
    await u.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(line);
    expect(dialog.getAllByRole("alert")).toHaveLength(1);
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Uploads fail silently. More.");
    expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("folds the Tasks list, counts the tasks, and opens the task modal for a row", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    const details = document.querySelector("details.taskFeatureDetails") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector(".taskFeatureLabel")).toHaveTextContent("Tasks");
    expect(details.querySelector(".taskFeatureCount")).toHaveTextContent("3 tasks · 1 done");
    expect(details.querySelectorAll(".taskFeatureNum")).toHaveLength(2);
    expect([...details.querySelectorAll(".taskFeatureItem")].map((item) => item.getAttribute("data-task-id"))).toEqual(["T-1", "T-2", "T-3"]);
    expect(details.querySelectorAll(".taskFeatureItem.hasStep")).toHaveLength(3);
    expect(details.querySelector(".taskFeatureItem .commandChip")).toHaveTextContent("Done");
    await u.click(dialog.getByText("Tasks"));
    await u.click(within(details).getByRole("button", { name: "Store" }));
    const task = within(screen.getByRole("dialog", { name: "Task" }));
    expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument();
    expect(document.querySelector(".taskModalId")).toHaveTextContent("T-2");
    expect(task.getByRole("textbox", { name: "Task" })).toHaveValue("Store");
  });

  it("draws no header chip and no Tasks list for a feature with no task", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u, "Docs (0)");
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Docs");
    expect(document.querySelector(".taskModalTitleGroup .commandChip")).toBeNull();
    expect(document.querySelector("details.taskFeatureDetails")).toBeNull();
  });
});

describe("closing the Feature modal", () => {
  const scrim = () => screen.getByRole("dialog") as HTMLElement;
  const clickScrim = () => { fireEvent.mouseDown(scrim()); fireEvent.click(scrim()); };

  it("closes a New feature form that holds nothing on a scrim click, and one that holds text never", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await u.click(filter().getByRole("button", { name: "+ New feature" }));
    clickScrim();
    expect(screen.queryByRole("dialog", { name: "New feature" })).not.toBeInTheDocument();
    expect(filter().getByRole("button", { name: "+ New feature" })).toHaveFocus();
    await u.click(filter().getByRole("button", { name: "+ New feature" }));
    await u.type(screen.getByRole("textbox", { name: "Title" }), "Typed");
    clickScrim();
    expect(screen.getByRole("dialog", { name: "New feature" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Typed");
    // Escape and Close discard it without asking, and give focus back.
    fireEvent.keyDown(scrim(), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "New feature" })).not.toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("closes an unchanged Feature form on a scrim click, and a changed one never; Close discards the draft", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    let dialog = await openEdit(u);
    await loaded(dialog);
    clickScrim();
    expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument();
    expect(filter().getByRole("button", { name: "Edit feature" })).toHaveFocus();
    await u.click(filter().getByRole("button", { name: "Edit feature" }));
    dialog = within(screen.getByRole("dialog", { name: "Feature" }));
    await loaded(dialog);
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "!");
    clickScrim();
    expect(screen.getByRole("dialog", { name: "Feature" })).toBeInTheDocument();
    await u.click(dialog.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Feature" })).not.toBeInTheDocument();
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("a paired device", () => {
  it("never sends feature_update: it has no paired route", async () => {
    setBridge(undefined);
    access.mode = "lan";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await updateDesktopFeature(repositoryId, "feature-0123456789ab", { name: "Renamed" })).toEqual({ ok: false, error: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends feature_update through the desktop bridge", async () => {
    expect(await updateDesktopFeature(repositoryId, "feat-0123456789ab", { description: null })).toEqual({ ok: true });
    expect(taskAction).toHaveBeenCalledWith(repositoryId, "feature_update", { id: "feat-0123456789ab", description: null });
  });
});

describe("the page does not publish the board while a modal saves", () => {
  it("re-renders the open modal from a new board without losing its draft", async () => {
    const u = user();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    const dialog = await openEdit(u);
    await loaded(dialog);
    await u.type(dialog.getByRole("textbox", { name: "Description" }), "!");
    publish(boardOf({ tasks: [...tasks(), task(9, "New one", { featureId: "f1", step: 3 })] }));
    expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Uploads fail silently.!");
    expect(document.querySelector(".taskModalTitleGroup .commandChip")).toHaveTextContent("1 of 4 done");
  });
});
