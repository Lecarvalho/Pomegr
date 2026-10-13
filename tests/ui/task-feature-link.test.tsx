import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

// A session's feature link: the address it builds, and what the Tasks page does with it in each client.

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/tasks-home-store", () => ({ useTaskHome: () => ({ version: 1, readiness: "ready", boards: [], attention: [], attentionTotal: 0 }) }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-89abcdef0123456789abcdef";
const repositoryEntry = (id: string, displayName: string): RepositoryInventorySnapshot["repositories"][number] => ({
  id, name: displayName, displayName, sessionCount: 0, liveCount: 0, historyCount: 0, providerCount: 0, updatedAt: null, providers: [],
});
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [repositoryEntry(repositoryId, "Example project"), repositoryEntry(otherRepositoryId, "Another project")] };
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: inventory, loading: false, connected: true, refresh: vi.fn() }) }));
// Which client this is, as `/api/client-access` would answer; each test sets it.
const access = vi.hoisted(() => ({ mode: "local" as "unknown" | "local" | "lan" }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => ({ mode: access.mode }), clientAccessMode: () => access.mode }));

import { SessionTaskMeta } from "../../app/components/dashboard/SessionTaskMeta";
import { SessionTaskTab } from "../../app/components/dashboard/SessionTaskTab";
import { sessionFeatureHref } from "../../app/components/tasks/SessionTaskCell";
import { TasksPage } from "../../app/components/tasks/TasksPage";

const FEATURE = "feat-0123456789ab";
const OTHER_FEATURE = "feat-ba9876543210";
const GONE_FEATURE = "feat-ffffffffffff";
const boardHref = `/tasks?repository=${repositoryId}`;
const featureHref = `${boardHref}&feature=${FEATURE}`;
const columns = ["Backlog", "Ready"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));
const taskFeature = vi.fn();

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns,
    features: [{ id: FEATURE, name: "Task board v1", done: false }, { id: OTHER_FEATURE, name: "Docs", done: false }],
    tasks: [task(14, { featureId: FEATURE, step: 1, state: "done" }), task(15, { featureId: FEATURE, step: 2 }), task(16, { featureId: OTHER_FEATURE, step: 1 }), task(17)],
    queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, ...overrides,
  };
}

const reference: SessionTaskReference = { id: "T-15", repositoryId, state: null, featureId: FEATURE, feature: "Task board v1", step: 2 };

function setBoard(next: TaskBoard) {
  useTasks.mockReturnValue({ board: next, refresh: vi.fn(async () => {}) });
}
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}
const filter = () => within(screen.getByRole("group", { name: "Filter by feature" })).getByRole("combobox", { name: "Feature" });
const cardIds = () => [...document.querySelectorAll(".taskBoardScroller [data-task-id]")].map((card) => card.getAttribute("data-task-id"));

beforeEach(() => {
  access.mode = "local";
  navigation.search = `repository=${repositoryId}&feature=${FEATURE}`;
  setBoard(board());
  taskFeature.mockResolvedValue({ ok: true, description: "Shared context.", appVersion: "1.4.0" });
  setBridge({ taskAction: vi.fn(), taskFeature });
});
afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("a session's feature link", () => {
  it("names the repository and the feature, and only the board for a feature ID the route cannot carry", () => {
    expect(sessionFeatureHref(reference)).toBe(featureHref);
    expect(sessionFeatureHref({ ...reference, featureId: null })).toBe(boardHref);
    expect(sessionFeatureHref({ ...reference, featureId: "feat-1&repository=x" })).toBe(boardHref);
    expect(sessionFeatureHref({ ...reference, repositoryId: "not-a-repository" })).toBeNull();
  });

  it("is the address of the header's feature name and of the Task tab's feature heading, not of Open on board", () => {
    const meta = render(<SessionTaskMeta task={reference} taskHref="/sessions/claude-abc?tab=task" />);
    expect(screen.getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", featureHref);
    meta.unmount();
    render(<SessionTaskTab task={reference} sessionId="claude:this-session" />);
    expect(within(screen.getByRole("complementary", { name: "Feature" })).getByRole("link", { name: "Task board v1" })).toHaveAttribute("href", featureHref);
    expect(screen.getByRole("link", { name: "Open on board" })).toHaveAttribute("href", boardHref);
  });

  it("follows the task to the feature the board holds it in now", () => {
    setBoard(board({ tasks: [task(15, { featureId: OTHER_FEATURE, step: 1 })] }));
    render(<SessionTaskTab task={reference} sessionId="claude:this-session" />);
    expect(within(screen.getByRole("complementary", { name: "Feature" })).getByRole("link", { name: "Docs" })).toHaveAttribute("href", `${boardHref}&feature=${OTHER_FEATURE}`);
  });
});

describe("the Tasks page opened by a feature link", () => {
  it("opens the repository's board and the feature's modal in the desktop app, with the feature chosen in the filter", async () => {
    render(<TasksPage />);
    expect(useTasks).toHaveBeenCalledWith(repositoryId);
    const dialog = within(screen.getByRole("dialog", { name: "Feature" }));
    expect(dialog.getByRole("textbox", { name: "Title" })).toHaveValue("Task board v1");
    await waitFor(() => expect(dialog.getByRole("textbox", { name: "Description" })).toHaveValue("Shared context."));
    expect(taskFeature).toHaveBeenCalledTimes(1);
    expect(taskFeature).toHaveBeenCalledWith(repositoryId, FEATURE);
    expect(filter()).toHaveTextContent("Task board v1 (2)");
    expect(cardIds()).toEqual(["T-14", "T-15"]);
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("opens the board of the repository the link names, not the first one", () => {
    navigation.search = `repository=${otherRepositoryId}&feature=${OTHER_FEATURE}`;
    setBoard(board({ repositoryId: otherRepositoryId }));
    render(<TasksPage />);
    expect(useTasks).toHaveBeenCalledWith(otherRepositoryId);
    expect(useTasks).not.toHaveBeenCalledWith(repositoryId);
    expect(within(screen.getByRole("dialog", { name: "Feature" })).getByRole("textbox", { name: "Title" })).toHaveValue("Docs");
    expect(taskFeature).toHaveBeenCalledWith(otherRepositoryId, OTHER_FEATURE);
  });

  it("uses the feature the route validated when the URL does not carry one yet", async () => {
    navigation.search = "";
    render(<TasksPage initialRepositoryId={repositoryId} initialFeatureId={FEATURE} />);
    expect(screen.getByRole("dialog", { name: "Feature" })).toBeInTheDocument();
    const { default: TasksRoute } = await import("../../app/tasks/page");
    const initial = async (feature: string | string[] | undefined) => (await TasksRoute({ searchParams: Promise.resolve({ repository: repositoryId, feature }) })).props.initialFeatureId;
    expect(await initial(FEATURE)).toBe(FEATURE);
    expect(await initial("feat-0123456789AB")).toBeUndefined();
    expect(await initial("../../etc/passwd")).toBeUndefined();
    expect(await initial([FEATURE, OTHER_FEATURE])).toBeUndefined();
  });

  it("waits for the board, opens the modal once, and does not open it again after it is closed", async () => {
    setBoard(board({ readiness: "loading", columns: [], features: [], tasks: [] }));
    const view = render(<TasksPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    setBoard(board());
    view.rerender(<TasksPage />);
    expect(screen.getByRole("dialog", { name: "Feature" })).toBeInTheDocument();
    await userEvent.setup().keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Focus returns to the filter, which still shows the feature.
    expect(filter()).toHaveFocus();
    expect(filter()).toHaveTextContent("Task board v1 (2)");
    setBoard(board());
    view.rerender(<TasksPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(taskFeature).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a paired device", "lan"],
    ["a browser on the same computer", "local"],
  ] as const)("chooses the feature in the filter on %s, and neither opens the modal nor reads its details", (_name, mode) => {
    setBridge(undefined);
    access.mode = mode;
    render(<TasksPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(filter()).toHaveTextContent("Task board v1 (2)");
    expect(cardIds()).toEqual(["T-14", "T-15"]);
    expect(screen.getByText(/of.*tasks done/u)).toHaveTextContent("1 of 2 tasks done");
    expect(screen.queryByRole("button", { name: "Edit feature" })).not.toBeInTheDocument();
    expect(taskFeature).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent("Shared context.");
    expect(document.body).not.toHaveTextContent("1.4.0");
  });

  it("decides nothing while the client is not known yet, then answers for the client it is", () => {
    setBridge(undefined);
    access.mode = "unknown";
    const view = render(<TasksPage />);
    expect(filter()).toHaveTextContent("All (4)");
    access.mode = "lan";
    view.rerender(<TasksPage />);
    expect(filter()).toHaveTextContent("Task board v1 (2)");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows nothing of the feature to a client that may not read the board", () => {
    setBridge(undefined);
    access.mode = "lan";
    setBoard(board({ readiness: "desktop_only", columns: [], features: [], tasks: [] }));
    render(<TasksPage />);
    expect(screen.getByText("Desktop only")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Filter by feature" })).not.toBeInTheDocument();
    expect(taskFeature).not.toHaveBeenCalled();
  });

  it.each([
    ["a feature that was deleted", `feature=${GONE_FEATURE}`],
    ["a value that is not a feature ID", `feature=${encodeURIComponent("../../etc?x=1")}`],
    ["another board's feature", "feature=feat-aaaaaaaaaaaa"],
  ])("opens the whole board, with no modal and no read, for %s", (_name, parameter) => {
    navigation.search = `repository=${repositoryId}&${parameter}`;
    render(<TasksPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(filter()).toHaveTextContent("All (4)");
    expect(cardIds()).toEqual(["T-14", "T-15", "T-16", "T-17"]);
    expect(taskFeature).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("closes the modal, and returns the filter to All, when the feature is deleted while it is open", () => {
    const view = render(<TasksPage />);
    expect(screen.getByRole("dialog", { name: "Feature" })).toBeInTheDocument();
    setBoard(board({ features: [{ id: OTHER_FEATURE, name: "Docs", done: false }], tasks: [task(16, { featureId: OTHER_FEATURE, step: 1 }), task(17)] }));
    view.rerender(<TasksPage />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(filter()).toHaveTextContent("All (2)");
  });

  it("ignores a feature named without a repository", () => {
    navigation.search = `feature=${FEATURE}`;
    render(<TasksPage />);
    expect(screen.getByRole("heading", { level: 2, name: "Boards" })).toBeInTheDocument();
    expect(useTasks).not.toHaveBeenCalled();
    expect(taskFeature).not.toHaveBeenCalled();
  });
});
