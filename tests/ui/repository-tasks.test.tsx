import { render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot, SessionActivityStatus } from "../../shared/monitor-contract";
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
import { QueueTaskCard } from "../../app/components/tasks/QueueTaskCard";
import { TaskBoardView } from "../../app/components/tasks/TaskBoardView";
import { sessionState } from "../../app/dashboard-utils";

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

describe("task card borrowing its session", () => {
  const session = (overrides: Partial<NonNullable<Task["session"]>> = {}): NonNullable<Task["session"]> => ({ id: "claude:abc123", title: "Parser refactor", state: "working", observedModel: null, ...overrides });
  const onlyCard = (tasks: Task[]) => {
    render(<TaskBoardView board={board({ tasks })} />);
    return screen.getByRole("listitem");
  };

  it.each<[SessionActivityStatus, string, string]>([
    ["working", "In progress", "positive"],
    ["needs_input", "Needs input", "warning"],
    ["idle", "Idle", ""],
    ["open", "Open", ""],
    ["stopped", "Stopped", ""],
    ["closed", "Closed", ""],
  ])("shows the %s session as the Sessions list labels it, never as Running", (state, label, tone) => {
    // The label is the Sessions list's own helper, not a copy of its table.
    expect(sessionState({ activityStatus: state }).label).toBe(label);
    const card = onlyCard([task(1, { state: "queued", session: session({ state }) })]);
    const chip = within(card).getByText(label);
    expect(chip).toHaveClass("commandChip");
    if (tone) expect(chip).toHaveClass(tone);
    expect(within(card).queryByText(/^Queued/)).not.toBeInTheDocument();
    expect(within(card).queryByText(/running/i)).not.toBeInTheDocument();
    expect(card.classList.contains("isLive")).toBe(state === "working");
  });

  it("shows the session title, the observed model and an Open session link to the session view", () => {
    const card = onlyCard([task(1, { text: "Refactor the parser", state: "queued", run: { provider: "claude", model: "opus", effort: "high" }, session: session({ observedModel: "opus" }) })]);
    expect(within(card).getByText("Parser refactor")).toBeInTheDocument();
    expect(within(card).queryByText("Refactor the parser")).not.toBeInTheDocument();
    expect(within(card).getByText("opus · high")).toBeInTheDocument();
    const observed = within(card).getByText(/^Observed model:/);
    expect(observed).toHaveTextContent("Observed model: opus");
    expect(observed).toHaveClass("taskCardDetail");
    expect(observed).not.toHaveClass("taskCardModelDiffers");
    expect(within(observed).getByText("opus").tagName).toBe("CODE");
    const link = within(card).getByRole("link", { name: "Open session" });
    expect(link).toHaveAttribute("href", "/sessions/claude-abc123");
    expect(link).toHaveClass("commandTextLink");
    expect(within(card).queryByText(/wall time/i)).not.toBeInTheDocument();
  });

  it("falls back to the task text while the session has no usable title", () => {
    render(<TaskBoardView board={board({ tasks: [
      task(1, { text: "Empty title", session: session({ title: "" }) }),
      task(2, { text: "Blank title", session: session({ title: "  " }) }),
      task(3, { text: "No title", session: session({ title: null }) }),
    ] })} />);
    for (const text of ["Empty title", "Blank title", "No title"]) expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open session" })).toHaveLength(3);
  });

  it("keeps the task's own chip while the monitor has no committed facts for the session", () => {
    const card = onlyCard([task(1, { text: "Fresh start", state: "queued", session: session({ title: null, state: "unknown" }) })]);
    expect(within(card).getByText("Queued")).toHaveClass("commandChip", "isInk");
    expect(within(card).queryByText("Unknown")).not.toBeInTheDocument();
    expect(card).not.toHaveClass("isLive");
    // The link does not depend on session facts.
    expect(within(card).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-abc123");
  });

  it.each<[TaskState, string]>([
    ["needs_review", "Needs review"],
    ["stalled", "Stalled"],
    ["blocked", "Blocked by agent"],
    ["done", "Done"],
  ])("keeps the %s outcome over a working session and still links to it", (state, label) => {
    const card = onlyCard([task(1, { state, session: session({ observedModel: "opus" }) })]);
    expect(within(card).getByText(label)).toHaveClass("commandChip");
    expect(within(card).queryByText("In progress")).not.toBeInTheDocument();
    expect(card.classList.contains("isLive")).toBe(false);
    expect(within(card).getByText("Parser refactor")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open session" })).toBeInTheDocument();
  });

  it("is unchanged for a task with no session", () => {
    const card = onlyCard([task(1, { state: "queued", run: { provider: "claude", model: "opus", effort: null } })]);
    expect(within(card).getByText("Queued")).toBeInTheDocument();
    expect(within(card).getByText("Task text 1")).toBeInTheDocument();
    expect(within(card).queryByRole("link")).not.toBeInTheDocument();
    expect(card).not.toHaveTextContent(/observed/i);
  });

  it("omits Open session for a session ID the session route cannot carry", () => {
    const card = onlyCard([task(1, { session: session({ id: "not a session id" }) })]);
    expect(within(card).queryByRole("link")).not.toBeInTheDocument();
  });

  describe("planned against observed model", () => {
    const planned = (model: string | null, observedModel: string | null) => task(1, { run: { provider: "claude", model, effort: null }, session: session({ observedModel }) });

    it("shows one amber line when they differ, instead of the muted observed line", () => {
      const card = onlyCard([planned("opus", "sonnet")]);
      const line = within(card).getByText(/^Planned/);
      expect(line).toHaveTextContent("Planned opus, observed sonnet");
      expect(line).toHaveClass("taskCardModelDiffers");
      expect(within(line).getByText("opus").tagName).toBe("CODE");
      expect(within(line).getByText("sonnet").tagName).toBe("CODE");
      expect(within(card).queryByText(/^Observed model:/)).not.toBeInTheDocument();
    });

    it.each<[string, string | null, string]>([
      ["equal", "claude-opus-4-1", "claude-opus-4-1"],
      ["equal ignoring case", "Claude-Opus-4-1", "claude-opus-4-1"],
      ["a planned alias inside the observed identifier", "opus", "claude-opus-4-1"],
      ["an observed alias inside the planned identifier", "claude-opus-4-1", "opus"],
      ["Default model planned", null, "sonnet"],
    ])("shows only the observed line when they match: %s", (_name, plannedModel, observed) => {
      const card = onlyCard([planned(plannedModel, observed)]);
      expect(within(card).getByText(/^Observed model:/)).toHaveTextContent(`Observed model: ${observed}`);
      expect(card).not.toHaveTextContent(/Planned .*observed/);
      expect(card.querySelector(".taskCardModelDiffers")).toBeNull();
    });

    it("shows no model line before a model is observed", () => {
      const card = onlyCard([planned("opus", null)]);
      expect(card).not.toHaveTextContent(/observed/i);
    });

    it("shows the observed line with no planned run at all", () => {
      const card = onlyCard([task(1, { session: session({ observedModel: "opus" }) })]);
      expect(card.querySelector(".taskCardRun")).toBeNull();
      expect(within(card).getByText(/^Observed model:/)).toHaveTextContent("Observed model: opus");
    });
  });

  it("draws the same borrowed chip, observed model and link on a queue card", () => {
    render(<ul><QueueTaskCard nextQueued={false} task={task(1, { state: "queued", run: { provider: "claude", model: "opus", effort: null }, session: session({ observedModel: "sonnet" }) })} /></ul>);
    const card = screen.getByRole("listitem");
    expect(within(card).getByText("In progress")).toHaveClass("positive");
    expect(within(card).getByText("Parser refactor")).toBeInTheDocument();
    expect(card).toHaveTextContent("Planned opus, observed sonnet");
    expect(within(card).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-abc123");
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
    // D73: the differs line is amber text only; model identifiers keep the data face; D75: the link is not stretched.
    expect(styles).toMatch(/\.taskCardDetail\.taskCardModelDiffers\s*\{[^}]*color:\s*var\(--command-amber\)/);
    expect(styles).toMatch(/\.taskCardDetail code\s*\{[^}]*var\(--font-data\)/);
    expect(styles).toMatch(/\.taskCardLink\s*\{[^}]*align-self:\s*flex-start/);
  });
});
