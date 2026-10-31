import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryInventorySnapshot } from "../../shared/monitor-contract";
import type { Task, TaskBoard, TaskHome, TaskHomeBoard, TaskQueuePauseReason, TaskQueueStatus } from "../../shared/task-contract";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: navigation.push, replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", () => ({ useTasks }));
// Which client this is, as `/api/client-access` would answer; each test sets it.
const access = vi.hoisted(() => ({ mode: "local" as "unknown" | "local" | "lan" }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => ({ mode: access.mode }), clientAccessMode: () => access.mode }));

import { TasksHome } from "../../app/components/tasks/TasksHome";
import { parseTaskHome, resetTaskHomeStoreForTests } from "../../app/tasks-home-store";

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

type Calls = { url: string; init?: RequestInit }[];
/** Serves the home answer to `/api/tasks?view=home` (the next one on each read, the last one repeating) and `{ ok: true }` to a paired action. */
function serve(...bodies: unknown[]) {
  const calls: Calls = [];
  let reads = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith("/api/tasks/action")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    const body = bodies[Math.min(reads, bodies.length - 1)];
    reads += 1;
    return new Response(JSON.stringify(body), { status: body && (body as { __status?: number }).__status ? (body as { __status: number }).__status : 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls, reads: () => reads };
}
const readBodies = (calls: Calls) => calls.filter((call) => call.url === "/api/tasks?view=home");

const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: true } | { ok: false; error: string }>>();
function setBridge(bridge: unknown) {
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = bridge;
}

beforeEach(() => {
  access.mode = "local";
  taskAction.mockResolvedValue({ ok: true });
  useTasks.mockReturnValue({ board: { version: 1, readiness: "loading", repositoryId, columns: [], features: [], tasks: [], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } }, refresh: vi.fn(async () => {}) });
});
afterEach(() => {
  cleanup();
  resetTaskHomeStoreForTests();
  setBridge(undefined);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// CSS-module class names are hashed, so a class is found by its source name inside the hash.
const hasClass = (element: Element | null, name: string) => (element?.className ?? "").toString().split(" ").some((value) => value.includes(name));
const boardsSection = () => screen.getByRole("region", { name: "Boards" });
const card = (name: string) => screen.getByRole("article", { name });
const cardNames = () => within(boardsSection()).getAllByRole("article").map((article) => within(article).getByRole("heading", { level: 3 }).textContent);

describe("the Tasks overview header", () => {
  it("sums open (not Done), in review, and done over the boards, with real data", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId, { counts: [243, 0, 1, 2, 122] }),
      boardSummary(otherRepositoryId, { counts: [38, 1, 0, 0, 153] }),
      // A board of a repository the inventory no longer lists has no card, so it adds nothing.
      boardSummary("repo-ffffffffffffffffffffffff", { counts: [9, 9, 9, 9, 9] }),
    ] }));
    render(<TasksHome repositories={repositories} />);
    const totals = await screen.findByRole("list", { name: "Totals across all boards" });
    expect(within(totals).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["285 open", "2 in review", "275 done"]);
    expect(screen.queryByText(/unavailable\./)).not.toBeInTheDocument();
  });

  it("counts a board that is unavailable as no task, and says so", async () => {
    serve(home({ boards: [boardSummary(repositoryId, { counts: [1, 1, 1, 1, 1] }), boardSummary(otherRepositoryId, { readiness: "unavailable", counts: [], openFeatures: 0, updatedAt: null })] }));
    render(<TasksHome repositories={repositories} />);
    const totals = await screen.findByRole("list", { name: "Totals across all boards" });
    expect(within(totals).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["4 open", "1 in review", "1 done"]);
    expect(screen.getByText("Without 1 board that is unavailable.")).toBeInTheDocument();
  });

  it("shows zeros when no board has a task, and no total before the home is ready", async () => {
    serve(home());
    render(<TasksHome repositories={repositories} />);
    expect(screen.queryByRole("list", { name: "Totals across all boards" })).not.toBeInTheDocument();
    const totals = await screen.findByRole("list", { name: "Totals across all boards" });
    expect(within(totals).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["0 open", "0 in review", "0 done"]);
  });
});

describe("Needs you", () => {
  const attention = [
    { repositoryId: otherRepositoryId, taskId: "T-12", title: "Rebuild the import index", state: "blocked" as const },
    { repositoryId, taskId: "T-54", title: "Create the Tasks home", state: "needs_review" as const },
    { repositoryId: "repo-ffffffffffffffffffffffff", taskId: "T-1", title: "Gone repository", state: "stalled" as const },
  ];

  it("draws Home's soft rows: the title, then the ID, the repository and the state, each one link to the task's board", async () => {
    const { fetchMock } = serve(home({ boards: [boardSummary(otherRepositoryId), boardSummary(repositoryId)], attention, attentionTotal: 3 }));
    render(<TasksHome repositories={repositories} />);
    expect(screen.getByLabelText("Loading tasks")).toBeInTheDocument();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks?view=home", expect.objectContaining({ cache: "no-store" }));
    expect(screen.queryByLabelText("Loading tasks")).not.toBeInTheDocument();
    const links = within(needs).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([`/tasks?repository=${otherRepositoryId}`, `/tasks?repository=${repositoryId}`]);
    expect(links[0]).toHaveTextContent("Rebuild the import index");
    expect(links[0]).toHaveTextContent("T-12 · Another project · Blocked by agent");
    expect(links[1]).toHaveTextContent("T-54 · Example project · Needs review");
    expect(within(links[1]).getByText("Create the Tasks home")).toHaveAttribute("title", "Create the Tasks home");
    // Home's card: the heading carries no count, and no row is a chip.
    expect(within(needs).getByRole("heading", { name: "Needs you" })).toHaveTextContent(/^Needs you$/);
    expect(needs.querySelector(".commandChip")).toBeNull();
    // A task of a repository the inventory does not list has no board to open, so it is not drawn or counted.
    expect(within(needs).queryByText("Gone repository")).not.toBeInTheDocument();
    expect(within(needs).queryByText(/Showing the newest/)).not.toBeInTheDocument();
  });

  it("keeps the keyboard path: each row is one tab stop, and Enter follows its link", async () => {
    serve(home({ boards: [boardSummary(repositoryId)], attention: [attention[1]], attentionTotal: 1 }));
    render(<TasksHome repositories={repositories} />);
    const needs = await screen.findByRole("region", { name: "Needs you" });
    const link = within(needs).getByRole("link");
    await userEvent.tab();
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
  });

  it("says nothing waits, and how many wait when the list is capped", async () => {
    serve(home({ boards: [boardSummary(repositoryId)] }));
    const first = render(<TasksHome repositories={repositories} />);
    expect(within(await screen.findByRole("region", { name: "Needs you" })).getByText("Nothing waits for you.")).toBeInTheDocument();
    first.unmount();
    resetTaskHomeStoreForTests();
    serve(home({ attention: [{ repositoryId, taskId: "T-1", title: "First", state: "stalled" }], attentionTotal: 60 }));
    render(<TasksHome repositories={repositories} />);
    expect(await screen.findByText("Showing the newest 1 of 60.")).toBeInTheDocument();
  });
});

describe("a board card", () => {
  const counts = [243, 0, 1, 2, 122];

  it("shows the name, the open features and the last change, the five counts dimmed at zero, and Open board", async () => {
    serve(home({ boards: [boardSummary(repositoryId, { counts, openFeatures: 21, updatedAt: "2026-10-10T10:00:00.000Z" })] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    const article = card("Example project");
    expect(within(article).getByText(/^21 open features/)).toBeInTheDocument();
    expect(article.querySelector("time")).toHaveAttribute("datetime", "2026-10-10T10:00:00.000Z");
    const terms = within(article).getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["Backlog", "Ready", "In progress", "Review", "Done"]);
    const values = within(article).getAllByRole("definition");
    expect(values.map((value) => value.textContent)).toEqual(["243", "0", "1", "2", "122"]);
    // Only the stage with no task is dimmed, and a Review count that is not zero is amber.
    expect(values.map((value) => hasClass(value, "isZero"))).toEqual([false, true, false, false, false]);
    expect(hasClass(values[3], "isReview")).toBe(true);
    const open = within(article).getByRole("link", { name: "Open board of Example project" });
    expect(open).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(open).toHaveTextContent("Open board");
  });

  it("draws the flow bar from the counts: a segment for each stage that holds a task, none for a zero", async () => {
    serve(home({ boards: [boardSummary(repositoryId, { counts })] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    const bar = within(card("Example project")).getByRole("img");
    expect(bar).toHaveAccessibleName("243 Backlog, 0 Ready, 1 In progress, 2 Review, 122 Done");
    const segments = [...bar.querySelectorAll<HTMLElement>("[data-stage]")];
    expect(segments.map((segment) => segment.dataset.stage)).toEqual(["Backlog", "In progress", "Review", "Done"]);
    // 243 and 122 of 368 are 66% and 33.2%; one task and two tasks are narrower than 1.5% and are drawn at 1.5%.
    expect(segments.map((segment) => segment.style.width)).toEqual(["66%", "1.5%", "1.5%", "33.2%"]);
    expect(segments.map((segment) => segment.className)).toEqual([expect.stringContaining("toneBacklog"), expect.stringContaining("toneProgress"), expect.stringContaining("toneReview"), expect.stringContaining("toneDone")]);
  });

  it("names the stage colors once, in the section header", async () => {
    serve(home({ boards: [boardSummary(repositoryId), boardSummary(otherRepositoryId)] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    const legends = screen.getAllByRole("list", { name: "Stages" });
    expect(legends).toHaveLength(1);
    expect(within(legends[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Backlog", "Ready", "In progress", "Review", "Done"]);
    expect(legends[0].closest("section")).toBe(boardsSection());
    expect(legends[0].parentElement).toContainElement(within(boardsSection()).getByRole("heading", { name: "Boards" }));
  });

  it("orders the cards by the last change and leaves the boards with no task for the compact rows", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId, { updatedAt: "2026-10-10T10:00:00.000Z" }),
      boardSummary(otherRepositoryId, { updatedAt: "2026-10-11T10:00:00.000Z" }),
    ] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(cardNames()).toEqual(["Another project", "Example project"]);
    const quiet = within(screen.getByRole("list", { name: "Boards with no tasks" }));
    expect(quiet.getAllByRole("listitem")).toHaveLength(1);
    expect(quiet.getByText("Quiet project")).toBeInTheDocument();
    expect(quiet.getByText("No tasks yet")).toBeInTheDocument();
  });

  it("draws a compact row for a board that holds no task, a repository with no stored board, and a board that is unavailable", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId),
      boardSummary(otherRepositoryId, { counts: [0, 0, 0, 0, 0], openFeatures: 0, updatedAt: null }),
      boardSummary(emptyRepositoryId, { readiness: "unavailable", counts: [], openFeatures: 0, updatedAt: null }),
    ] }));
    render(<TasksHome repositories={[...repositories, repository("repo-bbbbbbbbbbbbbbbbbbbbbbbb", "Unstored project")]} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(cardNames()).toEqual(["Example project"]);
    const rows = within(screen.getByRole("list", { name: "Boards with no tasks" })).getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual(["Another projectNo tasks yet", "Quiet projectBoard unavailable", "Unstored projectNo tasks yet"]);
    // An unavailable board never reads a count or offers a task.
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]).queryByRole("link")).not.toBeInTheDocument();
  });

  it("draws one card for each board with tasks and no card when none has", async () => {
    serve(home({ boards: [boardSummary(repositoryId, { counts: [0, 0, 0, 0, 0] })] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(within(boardsSection()).queryByRole("article")).not.toBeInTheDocument();
    expect(within(boardsSection()).queryByRole("list", { name: "Stages" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Boards with no tasks" })).getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("the moving line", () => {
  it("is made only of counts and the queue, and pulses only while a task is in progress", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId, { counts: [5, 2, 3, 4, 9], queue: { status: "running", blockedBy: null, pauseReason: null }, updatedAt: "2026-10-12T10:00:00.000Z" }),
      boardSummary(otherRepositoryId, { counts: [5, 2, 0, 0, 9], queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: "2026-10-11T10:00:00.000Z" }),
    ] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    const running = card("Example project");
    expect(within(running).getByText("3 in progress · 4 in review")).toBeInTheDocument();
    expect(running.querySelector("[class*=pulse]")).not.toBeNull();
    const idle = card("Another project");
    expect(within(idle).getByText("Nothing running · 2 ready to start")).toBeInTheDocument();
    expect(idle.querySelector("[class*=pulse]")).toBeNull();
  });

  it("words a blocked and a paused queue", async () => {
    serve(home({ boards: [
      boardSummary(repositoryId, { counts: [1, 1, 0, 0, 0], queue: { status: "blocked", blockedBy: "T-12", pauseReason: null }, updatedAt: "2026-10-12T10:00:00.000Z" }),
      boardSummary(otherRepositoryId, { counts: [1, 1, 0, 0, 0], queue: { status: "paused", blockedBy: null, pauseReason: "start_failed" as TaskQueuePauseReason }, updatedAt: "2026-10-11T10:00:00.000Z" }),
    ] }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(within(card("Example project")).getByText("Nothing running · Queue blocked by T-12")).toBeInTheDocument();
    expect(within(card("Another project")).getByText("Nothing running · Queue paused: A start failed")).toBeInTheDocument();
  });
});

describe("the queue switch of a card", () => {
  const queued = (status: TaskQueueStatus, extra: Partial<TaskHomeBoard["queue"]> = {}) =>
    home({ boards: [boardSummary(repositoryId, { queue: { status, blockedBy: null, pauseReason: null, ...extra } })] });
  const switchOf = () => within(card("Example project")).getByRole("switch", { name: "Queue of Example project" });
  const queueCalls = () => taskAction.mock.calls.filter((call) => call[1] === "queue_settings");

  it("is read only in a browser that may not change a board: the word, and no switch", async () => {
    serve(queued("running"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(within(card("Example project")).getByText("Queue on")).toBeInTheDocument();
    expect(within(card("Example project")).queryByRole("switch")).not.toBeInTheDocument();
    expect(within(card("Example project")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("is not drawn while the client does not yet know which it is, so it never appears and goes", async () => {
    access.mode = "unknown";
    serve(queued("running"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it.each<[TaskQueueStatus, boolean]>([["idle", false], ["running", true], ["blocked", true], ["paused", true]])("reads %s as checked %s in the desktop app", async (status, checked) => {
    setBridge({ taskAction });
    serve(queued(status, status === "blocked" ? { blockedBy: "T-12" } : status === "paused" ? { pauseReason: "start_failed" } : {}));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(switchOf()).toHaveAttribute("aria-checked", String(checked));
    expect(switchOf()).toHaveAccessibleDescription(status === "idle" ? "Queue off" : status === "running" ? "Queue on" : status === "blocked" ? "Blocked by T-12" : "Paused");
  });

  it("turns the queue on with the same action as the Board, then reads the home again and follows it", async () => {
    setBridge({ taskAction });
    const { calls } = serve(queued("idle"), queued("running"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(switchOf());
    await waitFor(() => expect(queueCalls()).toEqual([[repositoryId, "queue_settings", { on: true }]]));
    // The switch follows the committed home: it is disabled while the action runs and checked once the read answers.
    await waitFor(() => expect(switchOf()).toHaveAttribute("aria-checked", "true"));
    expect(switchOf()).toBeEnabled();
    expect(readBodies(calls)).toHaveLength(2);
  });

  it("turns a running, a blocked, and a paused queue off, and asks for no confirmation", async () => {
    setBridge({ taskAction });
    serve(queued("running"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(switchOf());
    await waitFor(() => expect(queueCalls()).toEqual([[repositoryId, "queue_settings", { on: false }]]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers to try a paused queue again, as pressing On does on the Board", async () => {
    setBridge({ taskAction });
    serve(queued("paused", { pauseReason: "start_failed" }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(within(card("Example project")).getByRole("button", { name: "Retry the queue of Example project" }));
    await waitFor(() => expect(queueCalls()).toEqual([[repositoryId, "queue_settings", { on: true }]]));
  });

  it("offers no retry unless the queue is paused", async () => {
    setBridge({ taskAction });
    serve(queued("blocked", { blockedBy: "T-12" }));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(within(card("Example project")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("keeps the committed state and says so when the change fails", async () => {
    setBridge({ taskAction });
    taskAction.mockResolvedValue({ ok: false, error: "unavailable" });
    serve(queued("idle"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(switchOf());
    expect(await screen.findByRole("status")).toHaveTextContent("The queue setting could not be changed.");
    expect(switchOf()).toHaveAttribute("aria-checked", "false");
    expect(switchOf()).toBeEnabled();
  });

  it("is disabled while the action runs", async () => {
    setBridge({ taskAction });
    let finish: (value: { ok: true }) => void = () => {};
    taskAction.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    serve(queued("idle"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(switchOf());
    await waitFor(() => expect(switchOf()).toBeDisabled());
    await act(async () => { finish({ ok: true }); });
    await waitFor(() => expect(switchOf()).toBeEnabled());
  });

  it("is drawn on a paired device, which sends the same action through the board action route", async () => {
    access.mode = "lan";
    const { calls } = serve(queued("idle"), queued("running"));
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    await userEvent.click(switchOf());
    await waitFor(() => expect(calls.some((call) => call.url === "/api/tasks/action")).toBe(true));
    const post = calls.find((call) => call.url === "/api/tasks/action")!;
    expect(post.init?.method).toBe("POST");
    expect(JSON.parse(String(post.init?.body))).toEqual({ repositoryId, action: "queue_settings", payload: { on: true } });
    await waitFor(() => expect(switchOf()).toHaveAttribute("aria-checked", "true"));
  });
});

describe("+ New task on a board with no task", () => {
  const quietHome = () => home({ boards: [boardSummary(repositoryId)] });
  const readyBoard = (): TaskBoard => ({ version: 1, readiness: "ready", repositoryId: emptyRepositoryId, columns: ["Backlog", "Ready", "In progress", "Review", "Done"].map((name, position) => ({ id: `col-${position + 1}`, name, position })), features: [], tasks: [] as Task[], queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] } });

  it("is not drawn to a client that cannot create a task, nor before the client knows which it is", async () => {
    serve(quietHome());
    const view = render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(screen.queryByRole("button", { name: /New task/ })).not.toBeInTheDocument();
    view.unmount();
    resetTaskHomeStoreForTests();
    access.mode = "unknown";
    serve(quietHome());
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(screen.queryByRole("button", { name: /New task/ })).not.toBeInTheDocument();
  });

  it("opens the existing new-task dialog for that repository, reading its board only when asked", async () => {
    setBridge({ taskAction });
    useTasks.mockReturnValue({ board: readyBoard(), refresh: vi.fn(async () => {}) });
    serve(quietHome());
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(useTasks).not.toHaveBeenCalled();
    const quiet = within(screen.getByRole("list", { name: "Boards with no tasks" }));
    const buttons = quiet.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["+ New task in Another project", "+ New task in Quiet project"]);
    await userEvent.click(buttons[1]);
    const dialog = await screen.findByRole("dialog", { name: "New task" });
    expect(useTasks).toHaveBeenCalledWith(emptyRepositoryId);
    expect(within(dialog).getByText("Quiet project · in Backlog")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(buttons[1]).toHaveFocus();
  });

  it("is also drawn on a paired device", async () => {
    access.mode = "lan";
    serve(quietHome());
    render(<TasksHome repositories={repositories} />);
    await screen.findByRole("region", { name: "Boards" });
    expect(screen.getAllByRole("button", { name: /New task/ })).toHaveLength(2);
  });
});

describe("the states of the page", () => {
  it("reduces a client that is not on this computer to the Desktop only notice, with no board and no total", async () => {
    serve({ ...home({ readiness: "desktop_only" }), __status: 403 });
    render(<TasksHome repositories={repositories} />);
    expect(await screen.findByText("Desktop only")).toHaveClass("commandChip");
    expect(screen.getByText("Task boards are available in the Pomegr desktop app on this computer.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Boards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Totals across all boards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says tasks are unavailable when the monitor cannot answer, without a card or a total", async () => {
    serve({ error: "down", __status: 503 });
    render(<TasksHome repositories={repositories} />);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Tasks are unavailable."));
    expect(screen.queryByRole("region", { name: "Boards" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Totals across all boards" })).not.toBeInTheDocument();
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
