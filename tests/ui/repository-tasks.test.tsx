import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskState } from "../../shared/task-contract";

const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ replace: navigation.replace, push: navigation.push }),
}));
const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));

import { RepositoryDetailView } from "../../app/components/repositories/RepositoryDetailView";
import { repositoryTabs } from "../../app/components/repositories/repository-route";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";

const repositoryId = "repo-0123456789abcdef01234567";
const inventory: RepositoryInventorySnapshot = { revision: 1, readiness: "ready", repositories: [{
  id: repositoryId, name: "Example project", displayName: "Example project", sessionCount: 1, liveCount: 0, historyCount: 1, providerCount: 1, updatedAt: null,
  providers: [{ provider: "claude", source: "Claude Code", sessionCount: 1, supported: false, status: "unavailable", failureKind: null, currentRevision: null, revisions: [] }],
}] };

const columns = ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position }));

function task(id: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `T-${id}`, text: `Task text ${id}`, columnId: "col-1", position: id, featureId: null, step: null,
    run: { provider: null, model: null, effort: null }, doneWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}

function board(overrides: Partial<TaskBoard> = {}): TaskBoard {
  return { version: 1, readiness: "ready", repositoryId, columns, features: [], tasks: [], queue: { status: "idle", blockedBy: null, order: [] }, ...overrides };
}

const column = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  navigation.search = "tab=tasks";
  useTasks.mockReturnValue({ board: board(), refresh: vi.fn() });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(inventory), { headers: { "Content-Type": "application/json" } }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("repository Tasks tab", () => {
  it("adds a Tasks tab between Git and Plugin and renders the board for this repository", async () => {
    expect(repositoryTabs.map(([id]) => id)).toEqual(["overview", "files", "git", "tasks", "plugin", "inventory", "reporting"]);
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="tasks" />);
    const tab = await screen.findByRole("tab", { name: "Tasks" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveAttribute("aria-controls", screen.getByRole("tabpanel").id);
    expect(useTasks).toHaveBeenCalledWith(repositoryId);
    expect(within(screen.getByRole("tabpanel")).getByRole("heading", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Task board" })).toBeInTheDocument();
  });

  it("does not read the board while another tab is open", async () => {
    navigation.search = "tab=git";
    render(<RepositoryDetailView repositoryId={repositoryId} initialTab="git" />);
    await screen.findByRole("tab", { name: "Tasks" });
    expect(screen.getByRole("tab", { name: "Tasks" })).toHaveAttribute("aria-selected", "false");
    expect(useTasks).not.toHaveBeenCalled();
  });
});

describe("task board", () => {
  it("draws the five default columns with their counts and an empty state", () => {
    render(<TaskBoardView board={board()} />);
    expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Backlog", "Ready", "In progress", "Review", "Done"]);
    for (const { name } of columns) expect(within(column(name)).getByText("0")).toBeInTheDocument();
    expect(screen.getByText("No tasks on this board yet.")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("counts each column's tasks and keeps them in position order", () => {
    render(<TaskBoardView board={board({ tasks: [
      task(3, { columnId: "col-2", position: 1 }), task(2, { columnId: "col-1", position: 2 }), task(1, { columnId: "col-1", position: 0 }), task(4, { columnId: "col-5", state: "done" }),
    ] })} />);
    expect(within(column("Backlog")).getByText("2")).toBeInTheDocument();
    expect(within(column("Ready")).getByText("1")).toBeInTheDocument();
    expect(within(column("Review")).getByText("0")).toBeInTheDocument();
    expect(within(column("Done")).getByText("1")).toBeInTheDocument();
    expect(within(column("Backlog")).getAllByRole("listitem").map((card) => within(card).getByText(/^T-\d+$/).textContent)).toEqual(["T-1", "T-2"]);
    expect(screen.queryByText("No tasks on this board yet.")).not.toBeInTheDocument();
  });

  it("shows a card's ID, state chip and text", () => {
    render(<TaskBoardView board={board({ tasks: [task(7, { text: "Board keyboard navigation" })] })} />);
    const card = within(column("Backlog")).getByRole("listitem");
    expect(within(card).getByText("T-7")).toBeInTheDocument();
    expect(within(card).getByText("Not queued")).toHaveClass("commandChip");
    expect(within(card).getByText("Board keyboard navigation")).toBeInTheDocument();
  });

  it.each<[TaskState, string, string]>([
    ["not_queued", "Not queued", ""],
    ["queued", "Queued", "isInk"],
    ["scheduled", "Scheduled", "info"],
    ["needs_review", "Needs review", "warning"],
    ["stalled", "Stalled", "warning"],
    ["blocked", "Blocked by agent", "warning"],
    ["done", "Done", ""],
  ])("labels the %s state %s as an outline chip", (state, label, modifier) => {
    render(<TaskBoardView board={board({ tasks: [task(1, { state })] })} />);
    const card = screen.getByRole("listitem");
    const chip = within(card).getByText(label);
    expect(chip).toHaveClass("commandChip");
    if (modifier) expect(chip).toHaveClass(modifier);
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
    expect(card).toHaveClass(["needs_review", "stalled", "blocked"].includes(state) ? "isAttention" : "taskCard");
    expect(card.classList.contains("isDone")).toBe(state === "done");
  });

  it("shows the session title instead of the text once the session has one, and that session's state", () => {
    render(<TaskBoardView board={board({ tasks: [
      task(1, { text: "Refactor the parser", state: "queued", session: { id: "claude:abc", title: "Parser refactor session", state: "working", observedModel: "opus" } }),
      task(2, { text: "Fix flaky test", state: "queued", session: { id: "claude:def", title: null, state: "needs_input", observedModel: null } }),
      task(3, { text: "Ship the guide", state: "done", session: { id: "claude:ghi", title: "Guide session", state: "idle", observedModel: null } }),
    ] })} />);
    const [live, waiting, done] = screen.getAllByRole("listitem");
    expect(within(live).getByText("Parser refactor session")).toBeInTheDocument();
    expect(within(live).queryByText("Refactor the parser")).not.toBeInTheDocument();
    expect(within(live).getByText("In progress")).toHaveClass("positive");
    expect(live).toHaveClass("isLive");
    expect(within(live).queryByText("Queued")).not.toBeInTheDocument();
    expect(within(waiting).getByText("Fix flaky test")).toBeInTheDocument();
    expect(within(waiting).getByText("Needs input")).toHaveClass("warning");
    expect(waiting).not.toHaveClass("isLive");
    // A finished task keeps its outcome; the bound session's idle state is not borrowed over it.
    expect(within(done).getByText("Done")).toBeInTheDocument();
    expect(within(done).getByText("Guide session")).toBeInTheDocument();
  });

  it("renders task text as plain text and offers no control to change a task", () => {
    render(<TaskBoardView board={board({ tasks: [task(1, { text: "<img src=x onerror=alert(1)> **bold**" })] })} />);
    expect(screen.getByText("<img src=x onerror=alert(1)> **bold**")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryAllByRole("link")).toEqual([]);
    expect(document.querySelector("[draggable]")).toBeNull();
  });

  it("holds the layout with a placeholder while loading, with no columns or counts", () => {
    render(<TaskBoardView board={board({ readiness: "loading", columns: [], tasks: [] })} />);
    expect(screen.getByLabelText("Loading tasks")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
    expect(screen.queryByText("No tasks on this board yet.")).not.toBeInTheDocument();
  });

  it("says tasks are unavailable without content, and never shows task text from a board that is not ready", () => {
    render(<TaskBoardView board={board({ readiness: "unavailable", tasks: [task(1, { text: "Must not render" })] })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Tasks are unavailable.");
    expect(screen.queryByText("Must not render")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("points a client that is not on this computer to the desktop app", () => {
    render(<TaskBoardView board={board({ readiness: "desktop_only", columns: [], tasks: [] })} />);
    expect(screen.getByText("The task board is available in the Pomegr desktop app on this computer.")).toBeInTheDocument();
    expect(screen.getByText("Desktop only")).toHaveClass("commandChip");
    expect(screen.queryByRole("heading", { level: 3 })).not.toBeInTheDocument();
  });

  it("moves from the placeholder to the board without showing a state it then retracts", async () => {
    useTasks.mockReturnValue({ board: board({ readiness: "loading", columns: [], tasks: [] }), refresh: vi.fn() });
    const view = render(<RepositoryDetailView repositoryId={repositoryId} initialTab="tasks" />);
    expect(await screen.findByLabelText("Loading tasks")).toBeInTheDocument();
    useTasks.mockReturnValue({ board: board({ tasks: [task(1)] }), refresh: vi.fn() });
    view.rerender(<RepositoryDetailView repositoryId={repositoryId} initialTab="tasks" />);
    await waitFor(() => expect(screen.queryByLabelText("Loading tasks")).not.toBeInTheDocument());
    expect(screen.queryByText(/unavailable/i)).not.toBeInTheDocument();
    expect(within(column("Backlog")).getByText("Task text 1")).toBeInTheDocument();
  });
});

describe("task board styles", () => {
  const entry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");

  it("registers the stylesheet beside its siblings and uses tokens only", () => {
    expect(entry).toMatch(/@import "\.\/styles\/tasks\.css";/);
    expect(styles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(styles).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    for (const [, radius] of styles.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^var\(--(?:control|panel)-radius\)$/);
    expect(styles).toMatch(/\.taskCard\s*\{[^}]*border-radius:\s*var\(--panel-radius\)/);
    expect(styles).toMatch(/\.taskCardId\s*\{[^}]*var\(--font-data\)/);
    expect(styles).toMatch(/\.taskBoardGrid\s*\{[^}]*minmax\(220px, 1fr\)/);
  });
});
