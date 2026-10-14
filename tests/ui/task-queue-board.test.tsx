import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));

import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";

/**
 * The rules of the queue that the Board shows. They were guarded on the Queue view before the Board became the only
 * view of the Tasks page.
 */
const repositoryId = "repo-0123456789abcdef01234567";
type Result = { ok: true } | { ok: false; error: string };
const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<Result>>();
const refresh = vi.fn(async () => {});
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position, role: null }));

function task(id: number, text: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text, columnId: "col-2", position: id, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

/**
 * Task board v1 (unfinished): T-1 (done), T-2 (queued, waits in Ready) and T-3 (started, In progress) share a parallel
 * group, T-4 and T-6 (queued), T-5 (not queued, Backlog). Docs (unfinished): T-7 (queued). Old (done): T-8. Empty
 * (unfinished, no task). Without a feature: T-9 and T-13 queued, T-10 scheduled, T-11 not queued (Backlog), T-12 done.
 */
const tasks = (): Task[] => [
  task(1, "Route", { featureId: "f1", state: "done", columnId: "col-5" }),
  task(2, "Store", { featureId: "f1", group: GROUP, position: 0 }),
  task(3, "Columns", { featureId: "f1", group: GROUP, columnId: "col-3", session: { id: "claude:abc", title: "Column session", state: "working", observedModel: null } }),
  task(4, "Ranking", { featureId: "f1", position: 1 }),
  task(5, "Gates", { featureId: "f1", state: "not_queued", columnId: "col-1" }),
  task(6, "Schedule", { featureId: "f1", position: 2 }),
  task(7, "Guide", { featureId: "f2", position: 3 }),
  task(8, "Old work", { featureId: "f3", state: "done", columnId: "col-5" }),
  task(9, "Loose end", { position: 5 }),
  task(10, "Nightly", { state: "scheduled", scheduledAt: "2026-10-09T02:00:00", position: 6 }),
  task(11, "Idea", { state: "not_queued", columnId: "col-1" }),
  task(12, "Shipped", { state: "done", columnId: "col-5" }),
  task(13, "First loose", { position: 4 }),
];
const features = [
  { id: "f1", name: "Task board v1", done: false },
  { id: "f2", name: "Docs", done: false },
  { id: "f3", name: "Old", done: true },
  { id: "f4", name: "Empty", done: false },
];
const GROUP = "grp-0123456789ab";
const ORDER = ["T-2", "T-4", "T-6", "T-7", "T-13", "T-9"];

function setBoard(overrides: Partial<TaskBoard> = {}) {
  const board: TaskBoard = { version: 1, readiness: "ready", repositoryId, columns, features, tasks: tasks(), queue: { status: "idle", blockedBy: null, pauseReason: null, order: ORDER }, ...overrides };
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

const card = (id: string) => document.querySelector(`li[data-task-id="${id}"]`) as HTMLElement;
const chipText = (id: string) => card(id).querySelector(".commandChip")?.textContent;
const renderBoard = () => render(<TaskBoardPane repositoryId={repositoryId} />);

describe("the page header", () => {
  const bridge = () => setBridge({ taskAction, taskIssues: vi.fn() });
  const switcher = <select aria-label="Repository"><option>Pomegr</option></select>;

  it("has no view switch and no Board or Queue button in the desktop app or in a browser", () => {
    for (const value of [{ taskAction }, undefined]) {
      setBridge(value);
      const view = render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
      expect(screen.queryByRole("group", { name: "Tasks view" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Board" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Queue" })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("holds the Repository select, the Queue switch, then Promote issues once a feature exists", () => {
    bridge();
    render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
    const actions = document.querySelector(".taskHeadActions") as HTMLElement;
    const repository = within(actions).getByRole("combobox", { name: "Repository" });
    const queueGroup = within(actions).getByRole("group", { name: "Queue" });
    const promote = within(actions).getByRole("link", { name: "Promote issues" });
    expect(repository.compareDocumentPosition(queueGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queueGroup.compareDocumentPosition(promote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(actions).queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
  });

  it("offers + New feature in the header only while the board has no feature", () => {
    bridge();
    setBoard({ features: [], tasks: [] });
    render(<TaskBoardPane repositoryId={repositoryId} switcher={switcher} />);
    const actions = document.querySelector(".taskHeadActions") as HTMLElement;
    const queueGroup = within(actions).getByRole("group", { name: "Queue" });
    const add = within(actions).getByRole("button", { name: "+ New feature" });
    expect(queueGroup.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(within(actions).getByRole("link", { name: "Promote issues" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders on the server without the desktop bridge", () => {
    setBridge(undefined);
    expect(() => renderToString(<TaskBoardPane repositoryId={repositoryId} />)).not.toThrow();
  });
});

describe("the Board footnote", () => {
  it("reads the drag rule, with Run in parallel and the group drop, in the desktop app", () => {
    renderBoard();
    expect(screen.getByText("Drag a card to move it. Ready starts from the top, one card at a time. To run cards together, in Backlog or Ready, choose Run in parallel between them or drop a card on a group. Drag a card out of a group to take it out.")).toHaveClass("taskBoardFootnote");
  });

  it("is not drawn without the desktop bridge", () => {
    setBridge(undefined);
    renderBoard();
    expect(document.querySelector(".taskBoardFootnote")).toBeNull();
  });
});

describe("a task that already started", () => {
  const gates = {
    threshold: 85 as const,
    usage: { claude: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 }, codex: { status: "ok" as const, fiveHourPercent: 10, sevenDayPercent: 10 } },
    providerStatus: { claude: "ok" as const, codex: "ok" as const },
    workingTree: "dirty" as const,
    next: { taskId: "T-2", provider: "claude" as const, blockedBy: null, reasons: ["tree_dirty" as const] },
  };

  it("borrows its session state, is not next, and carries no Waiting line; the next waiting task carries it", () => {
    setBoard({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ORDER, gates } });
    renderBoard();
    expect(chipText("T-3")).toBe("In progress");
    expect(within(card("T-3")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(card("T-3").closest(".taskReadyGroup")).toBeNull();
    expect(within(card("T-2")).getByText(/Waiting: the working tree has uncommitted changes/)).toBeInTheDocument();
    expect(card("T-2").closest(".taskReadyGroup")).not.toBeNull();
    expect(chipText("T-2")).toBe("Queued · next");
  });

  it("started by a live dispatch with no session yet keeps its own chip, no next marker and no Waiting line", () => {
    setBoard({ queue: { status: "running", blockedBy: null, pauseReason: null, order: ["T-2", "T-4", "T-6", "T-7", "T-13"], gates } });
    renderBoard();
    expect(chipText("T-9")).toBe("Queued");
    expect(within(card("T-9")).queryByText(/Waiting/)).not.toBeInTheDocument();
    expect(within(card("T-9")).queryByRole("combobox")).not.toBeInTheDocument();
  });
});

describe("Queued · next on the board and in the Task modal", () => {
  it("marks exactly the first task of queue.order as Queued · next", () => {
    renderBoard();
    expect(chipText("T-2")).toBe("Queued · next");
    expect([...document.querySelectorAll("li[data-task-id]")].filter((li) => li.querySelector(".commandChip")?.textContent === "Queued · next")).toHaveLength(1);
    expect(chipText("T-4")).toBe("Queued");
    expect(chipText("T-7")).toBe("Queued");
    expect(chipText("T-9")).toBe("Queued");
    expect(chipText("T-1")).toBe("Done");
    expect(chipText("T-5")).toBe("Not queued");
    expect(card("T-5").querySelector(".commandChip")).not.toHaveClass("isInk");
    expect(card("T-4").querySelector(".commandChip")).toHaveClass("isInk");
  });

  it("follows queue.order when another task is first", () => {
    setBoard({ queue: { status: "idle", blockedBy: null, pauseReason: null, order: ["T-6", "T-2", "T-4", "T-7", "T-13", "T-9"] } });
    renderBoard();
    expect(chipText("T-6")).toBe("Queued · next");
    expect(chipText("T-2")).toBe("Queued");
  });

  it("reads it in the feature task list inside the Task modal", async () => {
    renderBoard();
    await userEvent.click(screen.getByRole("button", { name: "Gates" }));
    const dialog = screen.getByRole("dialog", { name: "Task" });
    const list = within(dialog).getByText("In this feature").closest("details") as HTMLElement;
    const row = (id: string) => list.querySelector(`li[data-task-id="${id}"] .commandChip`)?.textContent;
    expect(row("T-2")).toBe("Queued · next");
    expect(row("T-4")).toBe("Queued");
  });
});

describe("without the desktop bridge", () => {
  beforeEach(() => setBridge(undefined));

  it("is read-only: nothing is draggable and there is no move control, New feature or footnote", () => {
    renderBoard();
    expect(card("T-4")).toBeInTheDocument();
    expect(document.querySelectorAll("[draggable]")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Run .* in parallel|Ungroup|Take .* out of/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ New feature" })).not.toBeInTheDocument();
    expect(document.querySelector(".taskBoardFootnote")).toBeNull();
    expect(chipText("T-2")).toBe("Queued · next");
    expect(taskAction).not.toHaveBeenCalled();
  });
});

describe("Add to queue and Remove from queue", () => {
  async function openModal(title: string) {
    renderBoard();
    await userEvent.click(screen.getByRole("button", { name: title }));
    return within(screen.getByRole("dialog", { name: "Task" }));
  }

  it("adds a Not queued task, after the Delete action", async () => {
    const dialog = await openModal("Idea");
    const add = dialog.getByRole("button", { name: "Add to queue" });
    expect(add).toHaveClass("commandSecondaryAction");
    expect(dialog.getByRole("button", { name: "Delete task" }).compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
    await userEvent.click(add);
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_add", { id: "T-11" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("removes a queued task", async () => {
    const dialog = await openModal("Loose end");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    await userEvent.click(dialog.getByRole("button", { name: "Remove from queue" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "queue_remove", { id: "T-9" }));
  });

  it("disables Remove from queue on a task in progress", async () => {
    // The card of a started task reads its session's title.
    const dialog = await openModal("Column session");
    const remove = dialog.getByRole("button", { name: "Remove from queue" });
    expect(remove).toBeDisabled();
    await userEvent.click(remove);
    expect(taskAction).not.toHaveBeenCalled();
  });

  it("shows one line when the monitor refuses", async () => {
    taskAction.mockResolvedValue({ ok: false, error: "conflict" });
    const dialog = await openModal("Idea");
    await userEvent.click(dialog.getByRole("button", { name: "Add to queue" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("The task could not be added to the queue.");
  });

  it("offers neither action on a finished task", async () => {
    const dialog = await openModal("Shipped");
    expect(dialog.queryByRole("button", { name: "Add to queue" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Remove from queue" })).not.toBeInTheDocument();
  });
});

describe("the Tasks page has one view", () => {
  const app = join(process.cwd(), "app");
  const removedFiles = [
    "components/tasks/TaskQueueView.tsx", "components/tasks/QueueFeaturePanel.tsx", "components/tasks/QueueSingleTasks.tsx",
    "components/tasks/QueueTaskCard.tsx", "components/tasks/use-queue-drag.ts", "components/design-system/DesignSystemTaskQueueSample.tsx",
  ];
  const removedClasses = [
    "taskQueueView", "taskQueueRow", "taskQueueAside", "taskQueuePanel", "taskQueueHead", "taskQueueCaption", "taskQueueNum",
    "taskQueueSteps", "taskQueueStep", "taskQueueCards", "taskQueueCard", "taskQueueNewStep", "taskQueueNote", "taskQueueMove", "taskQueueSingle",
  ];

  it.each(removedFiles)("has no %s", (file) => {
    expect(existsSync(join(app, file))).toBe(false);
  });

  it("keeps no Queue view class in tasks.css and no view switch in the page header", () => {
    const tasksCss = readFileSync(join(app, "styles", "tasks.css"), "utf8");
    for (const name of removedClasses) expect(tasksCss, name).not.toMatch(new RegExp(`\.${name}(?![A-Za-z0-9])`));
    expect(tasksCss).not.toMatch(/.taskQueueStep[A-Za-z]*/);
    expect(tasksCss).not.toMatch(/.taskQueueSingle[A-Za-z]*/);
    expect(tasksCss).not.toMatch(/data-view/);
    const pane = readFileSync(join(app, "components", "tasks", "TaskBoardPane.tsx"), "utf8");
    expect(pane).not.toMatch(/Tasks view/);
  });
});
