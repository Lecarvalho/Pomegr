import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard } from "../../shared/task-contract";

const navigation = vi.hoisted(() => ({ pathname: "/tasks", push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ push: navigation.push, replace: vi.fn() }),
}));
const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  const snapshot: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [] };
  return { ...actual, useRepositoryInventory: () => ({ snapshot, loading: false, connected: true, refresh: vi.fn(async () => {}) }) };
});

import { AppShell } from "../../app/components/AppShell";
import { matchPaletteScopeItems, setPaletteScope, usePaletteScope, type PaletteScope } from "../../app/components/command-center/palette-scope";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { taskSearchItems } from "../../app/components/tasks/task-search";

const repositoryId = "repo-0123456789abcdef01234567";
const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, ...overrides };
}

const tasks = [
  task(1, { text: "Fix the login redirect\nSecond line of detail" }),
  task(2, { text: "Write release notes", columnId: "col-4", state: "needs_review", featureId: "feature-1", source: { kind: "github_issue", number: 133 } }),
  task(3, { text: "Original wording", columnId: "col-3", session: { id: "claude:s-3", title: "Refactor the parser", state: "working", observedModel: null } }),
];
const searchBoard = board({ tasks, features: [{ id: "feature-1", name: "Launch", done: false }] });

function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

function ScopeProbe({ onScope }: { onScope(scope: PaletteScope | null): void }) {
  const scope = usePaletteScope();
  useEffect(() => { onScope(scope); }, [onScope, scope]);
  return null;
}

beforeEach(() => {
  navigation.pathname = "/tasks";
  useTasks.mockReturnValue({ board: searchBoard, refresh: vi.fn() });
});
afterEach(() => {
  setBridge(undefined);
  navigation.push.mockReset();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("task search items", () => {
  it("lists tasks in board order with a one-line label and an ID, column, and chip detail", () => {
    const items = taskSearchItems(searchBoard);
    expect(items.map((item) => item.id)).toEqual(["T-1", "T-3", "T-2"]);
    expect(items[0]).toMatchObject({ label: "Fix the login redirect", detail: "T-1 · Backlog · Not queued" });
    expect(items[1]).toMatchObject({ label: "Refactor the parser", detail: "T-3 · In progress · In progress" });
    expect(items[2]).toMatchObject({ label: "Write release notes", detail: "T-2 · #133 · Review · Needs review · Launch" });
  });

  it("finds a task by any word of its ID, text, session title, feature, column, chip, or issue number", () => {
    const items = taskSearchItems(searchBoard);
    const found = (query: string) => matchPaletteScopeItems(items, query, 20).map((item) => item.id);
    expect(found("t-2")).toEqual(["T-2"]);
    expect(found("detail")).toEqual(["T-1"]);
    expect(found("ORIGINAL")).toEqual(["T-3"]);
    expect(found("parser refactor")).toEqual(["T-3"]);
    expect(found("launch")).toEqual(["T-2"]);
    expect(found("#133")).toEqual(["T-2"]);
    expect(found("needs review")).toEqual(["T-2"]);
    expect(found("login parser")).toEqual([]);
    expect(found("")).toEqual(["T-1", "T-3", "T-2"]);
    expect(matchPaletteScopeItems(items, "", 2)).toHaveLength(2);
  });
});

describe("the task board in the Search bar", () => {
  it("offers its tasks only while a ready board is in view", () => {
    const onScope = vi.fn();
    useTasks.mockReturnValue({ board: board({ readiness: "desktop_only" }), refresh: vi.fn() });
    const view = render(<><ScopeProbe onScope={onScope} /><TaskBoardPane repositoryId={repositoryId} /></>);
    expect(onScope).toHaveBeenLastCalledWith(null);
    useTasks.mockReturnValue({ board: searchBoard, refresh: vi.fn() });
    view.rerender(<><ScopeProbe onScope={onScope} /><TaskBoardPane repositoryId={repositoryId} /></>);
    const scope = onScope.mock.lastCall?.[0] as PaletteScope;
    expect(scope.label).toBe("Search tasks");
    expect(scope.items.map((item) => item.id)).toEqual(["T-1", "T-3", "T-2"]);
    view.rerender(<ScopeProbe onScope={onScope} />);
    expect(onScope).toHaveBeenLastCalledWith(null);
  });

  it("shows a chosen task's card on the Board where tasks are read-only", async () => {
    const user = userEvent.setup();
    const onScope = vi.fn();
    render(<><ScopeProbe onScope={onScope} /><TaskBoardPane repositoryId={repositoryId} /></>);
    await user.click(screen.getByRole("button", { name: "Queue" }));
    expect(screen.queryByRole("region", { name: "Task board" })).not.toBeInTheDocument();
    act(() => { (onScope.mock.lastCall?.[0] as PaletteScope).onSelect("T-2"); });
    expect(screen.getByRole("button", { name: "Board" })).toHaveAttribute("aria-pressed", "true");
    const card = screen.getByRole("region", { name: "Task board" }).querySelector('[data-task-id="T-2"]');
    expect(card).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens a chosen task's modal in the desktop app", () => {
    setBridge({ taskAction: vi.fn() });
    const onScope = vi.fn();
    render(<><ScopeProbe onScope={onScope} /><TaskBoardPane repositoryId={repositoryId} /></>);
    act(() => { (onScope.mock.lastCall?.[0] as PaletteScope).onSelect("T-1"); });
    expect(within(screen.getByRole("dialog")).getByDisplayValue(/Fix the login redirect/)).toBeInTheDocument();
  });
});

describe("the Search bar on a page with a scope", () => {
  function Scoped({ scope }: { scope: PaletteScope }) {
    useEffect(() => setPaletteScope(scope), [scope]);
    return <main>Tasks content</main>;
  }
  const response = () => Promise.resolve(new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "Content-Type": "application/json" } }));

  it("searches the page's items first, chooses one without navigating, and returns to the plain search when the page leaves", async () => {
    const user = userEvent.setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(response);
    const onSelect = vi.fn();
    const scope: PaletteScope = { label: "Search tasks", placeholder: "Search tasks and destinations", emptyLine: "No tasks or destinations match that search.", items: taskSearchItems(searchBoard), onSelect };
    const view = render(<AppShell><Scoped scope={scope} /></AppShell>);
    const trigger = await screen.findByRole("button", { name: "Search Pomegr" });
    expect(trigger).toHaveTextContent("Search tasks");
    await user.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search Pomegr" });
    expect(search).toHaveAttribute("placeholder", "Search tasks and destinations");
    expect(screen.getAllByRole("option").slice(0, 4).map((option) => option.querySelector("strong")?.textContent)).toEqual(["Fix the login redirect", "Refactor the parser", "Write release notes", "Home"]);

    await user.type(search, "release");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: /Write release notes.*T-2/ })).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("T-2");
    expect(navigation.push).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Search Pomegr" })).not.toBeInTheDocument();

    await user.click(trigger);
    await user.type(screen.getByRole("combobox", { name: "Search Pomegr" }), "zzzz");
    expect(screen.getByText("No tasks or destinations match that search.")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    view.rerender(<AppShell><main>Other content</main></AppShell>);
    expect(screen.getByRole("button", { name: "Search Pomegr" })).toHaveTextContent(/^Search/);
    expect(screen.getByRole("button", { name: "Search Pomegr" })).not.toHaveTextContent("Search tasks");
  });
});
