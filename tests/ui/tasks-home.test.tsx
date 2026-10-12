import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TasksHome } from "../../app/components/tasks/TasksHome";
import { parseTaskHome, resetTaskHomeStoreForTests } from "../../app/tasks-home-store";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { TaskHome, TaskHomeBoard } from "../../shared/task-contract";

const repositoryId = "repo-0123456789abcdef01234567";
const otherRepositoryId = "repo-89abcdef0123456789abcdef";
const emptyRepositoryId = "repo-aaaaaaaaaaaaaaaaaaaaaaaa";
const repository = (id: string, displayName: string): RepositoryInventorySnapshot["repositories"][number] => ({
  id, name: displayName, displayName, sessionCount: 1, liveCount: 0, historyCount: 1, providerCount: 1, updatedAt: null, providers: [],
});
const repositories = [repository(repositoryId, "Example project"), repository(otherRepositoryId, "Another project"), repository(emptyRepositoryId, "Quiet project")];

const boardSummary = (id: string, overrides: Partial<TaskHomeBoard> = {}): TaskHomeBoard => ({
  repositoryId: id, readiness: "ready", counts: [12, 4, 2, 3, 41], openFeatures: 2, queue: { status: "running", blockedBy: null, pauseReason: null }, updatedAt: "2026-10-10T10:00:00.000Z", ...overrides,
});
const home = (overrides: Partial<TaskHome> = {}): TaskHome => ({ version: 1, readiness: "ready", boards: [], attention: [], attentionTotal: 0, ...overrides });

function serve(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  resetTaskHomeStoreForTests();
  vi.unstubAllGlobals();
});

describe("the Tasks home", () => {
  it("lists what waits for the owner, then one board row for each listed repository", async () => {
    const fetchMock = serve(home({
      boards: [
        boardSummary(otherRepositoryId, { counts: [3, 2, 1, 0, 17], openFeatures: 1, queue: { status: "blocked", blockedBy: "T-12", pauseReason: null }, updatedAt: "2026-10-11T10:00:00.000Z" }),
        boardSummary(repositoryId),
      ],
      attention: [
        { repositoryId: otherRepositoryId, taskId: "T-12", title: "Rebuild the import index", state: "blocked" },
        { repositoryId, taskId: "T-54", title: "Create the Tasks home", state: "needs_review" },
        { repositoryId: "repo-ffffffffffffffffffffffff", taskId: "T-1", title: "Gone repository", state: "stalled" },
      ],
      attentionTotal: 3,
    }));
    render(<TasksHome repositories={repositories} />);
    expect(screen.getByLabelText("Loading tasks")).toBeInTheDocument();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks?view=home", expect.objectContaining({ cache: "no-store" }));
    expect(screen.queryByLabelText("Loading tasks")).not.toBeInTheDocument();

    const links = within(needs).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([`/tasks?repository=${otherRepositoryId}`, `/tasks?repository=${repositoryId}`]);
    expect(links[0]).toHaveTextContent("Another project");
    expect(links[0]).toHaveTextContent("T-12");
    expect(within(links[0]).getByText("Blocked by agent")).toHaveClass("commandChip", "warning");
    expect(within(links[1]).getByText("Needs review")).toHaveClass("commandChip", "warning");
    // A task of a repository the inventory does not list has no board to open, so it is not drawn or counted.
    expect(within(needs).queryByText("Gone repository")).not.toBeInTheDocument();
    expect(needs.querySelector(".taskHomeCount")).toHaveTextContent("2");

    const boards = screen.getByRole("region", { name: "Boards" });
    expect(within(boards).getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Repository", "Queue", "Backlog", "Ready", "In progress", "Review", "Done", "Last change"]);
    // The board that changed last is first; a repository with no stored board keeps its place after them.
    const rows = within(boards).getAllByRole("row").slice(1);
    expect(rows.map((row) => within(row).getByRole("link").textContent)).toEqual(["Another project", "Example project", "Quiet project"]);
    expect(within(rows[0]).getByRole("link")).toHaveAttribute("href", `/tasks?repository=${otherRepositoryId}`);
    expect(within(rows[0]).getByText("Blocked by T-12")).toHaveClass("commandChip", "negative");
    expect(within(rows[0]).getAllByRole("cell").slice(1, 6).map((cell) => cell.textContent)).toEqual(["3", "2", "1", "0", "17"]);
    expect(within(rows[0]).getByText("1 open feature")).toBeInTheDocument();
    expect(within(rows[1]).getByText("On")).toHaveClass("commandChip");
    expect(within(rows[1]).getByText("2 open features")).toBeInTheDocument();
    expect(within(rows[2]).getByText("No tasks yet")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Off")).toHaveClass("commandChip");
    expect(within(rows[2]).getAllByRole("cell").slice(1).map((cell) => cell.textContent)).toEqual(["0", "0", "0", "0", "0", "—"]);
  });

  it("says nothing waits, words a paused queue, and never invents counts for a board that is unavailable", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId, { queue: { status: "paused", blockedBy: "T-3", pauseReason: "start_failed" } }),
      boardSummary(otherRepositoryId, { readiness: "unavailable", counts: [], openFeatures: 0, updatedAt: null }),
    ] }));
    render(<TasksHome repositories={repositories.slice(0, 2)} />);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(within(needs).getByText("Nothing waits for you.")).toBeInTheDocument();
    expect(within(needs).queryByRole("link")).not.toBeInTheDocument();
    const rows = within(screen.getByRole("region", { name: "Boards" })).getAllByRole("row").slice(1);
    expect(within(rows[0]).getByText("Paused")).toHaveClass("commandChip", "warning");
    expect(within(rows[1]).getByText("Board unavailable")).toBeInTheDocument();
    expect(within(rows[1]).getAllByRole("cell").map((cell) => cell.textContent)).toEqual(["—", "—", "—", "—", "—", "—", "—"]);
  });

  it("says how many wait when the list is capped", async () => {
    serve(home({ attention: [{ repositoryId, taskId: "T-1", title: "First", state: "stalled" }], attentionTotal: 60 }));
    render(<TasksHome repositories={repositories} />);
    expect(await screen.findByText("Showing the newest 1 of 60.")).toBeInTheDocument();
  });

  it("reduces a client that is not on this computer to the Desktop only notice, with no board row", async () => {
    serve(home({ readiness: "desktop_only" }), 403);
    render(<TasksHome repositories={repositories} />);
    expect(await screen.findByText("Desktop only")).toHaveClass("commandChip");
    expect(screen.getByText("Task boards are available in the Pomegr desktop app on this computer.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Boards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says tasks are unavailable when the monitor cannot answer, without a row", async () => {
    serve({ error: "down" }, 503);
    render(<TasksHome repositories={repositories} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Tasks are unavailable."));
    expect(screen.queryByRole("region", { name: "Boards" })).not.toBeInTheDocument();
  });
});

describe("the Tasks home answer", () => {
  it("accepts only the contract shape and serves no content from a home that is not ready", () => {
    const ready = home({ boards: [boardSummary(repositoryId)], attention: [{ repositoryId, taskId: "T-1", title: "First", state: "stalled" }], attentionTotal: 1 });
    expect(parseTaskHome(ready)).toEqual(ready);
    expect(parseTaskHome({ ...ready, readiness: "desktop_only" })).toEqual(home({ readiness: "desktop_only" }));
    expect(parseTaskHome({ ...ready, version: 2 })).toBeNull();
    expect(parseTaskHome({ ...ready, attention: [{ repositoryId, taskId: "T-1", title: "First", state: "queued" }] })).toBeNull();
    expect(parseTaskHome({ ...ready, attention: [{ repositoryId: "../etc", taskId: "T-1", title: "First", state: "stalled" }] })).toBeNull();
    expect(parseTaskHome({ ...ready, boards: [{ ...boardSummary(repositoryId), counts: [1, 2] }] })?.boards[0]).toMatchObject({ readiness: "unavailable", counts: [] });
    expect(parseTaskHome({ ...ready, boards: [boardSummary("not-a-repository")] })).toBeNull();
  });
});

describe("Tasks home styles", () => {
  const styles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");

  it("draws counts in the data font, keeps the queue chip an outline, and reflows each board to a card on phone", () => {
    expect(styles).toMatch(/\.taskHomeTable td\.taskHomeNumber\s*\{[^}]*var\(--font-data\)/);
    expect(styles).toMatch(/\.taskHomeNeed\s*\{[^}]*min-height:\s*44px/);
    expect(styles).toMatch(/\.commandChip\.taskHomeQueueOn\s*\{\s*color:\s*var\(--command-ink\);\s*\}/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[^@]*\.taskHomeTable thead\s*\{\s*display:\s*none/);
  });
});
