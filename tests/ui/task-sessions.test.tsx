import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTaskReference } from "../../shared/session-catalog-contract";
import type { Task, TaskAssignedSession, TaskBoard } from "../../shared/task-contract";
import { chooseCommandOption } from "./command-select-helpers";

const { useTasks } = vi.hoisted(() => ({ useTasks: vi.fn() }));
vi.mock("../../app/tasks-store", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../app/tasks-store")>()), useTasks }));
vi.mock("../../app/agents-client", () => ({ useAgents: () => ({ data: { runs: [] }, loading: false, refreshing: false, connected: true, checkedAt: null }) }));
vi.mock("../../app/repository-inventory-client", () => ({ useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: [] }, loading: false, connected: true, refresh: vi.fn() }) }));

import { AssignedSessionsSection } from "../../app/components/design-system/DesignSystemAssignedSessionsSample";
import { SessionTaskSection } from "../../app/components/design-system/DesignSystemSessionTaskSample";
import { SessionTaskCell } from "../../app/components/tasks/SessionTaskCell";
import { TaskBoardPane } from "../../app/components/tasks/TaskBoardPane";
import { TaskCard } from "../../app/components/tasks/TaskCard";
import { ASSIGN_HELPER, TaskSessionsField, type TaskSessionCandidate } from "../../app/components/tasks/TaskSessionsField";
import { ASSIGN_FAILURE_MESSAGE, ASSIGN_LIMIT_MESSAGE, UNASSIGN_FAILURE_MESSAGE } from "../../app/components/tasks/task-desktop";
import { SESSION_CANDIDATES_SHOWN, parseSessionCandidates } from "../../app/components/tasks/use-task-session-candidates";
import { parseTaskBoard } from "../../app/tasks-store";

const repositoryId = "repo-0123456789abcdef01234567";
const started = { id: "claude:started", title: "Started session", state: "working", observedModel: null, observedEffort: null };
const session = (id: string, title: string | null, state = "idle"): TaskAssignedSession => ({ id: `claude:${id}`, title, state, observedModel: null, observedEffort: null });
const first = session("one", "First assigned");
const second = session("two", "Second assigned", "needs_input");

function task(overrides: Partial<Task> = {}): Task {
  return { review: null,
    id: "T-1", text: "Task text", columnId: "col-1", position: 1, featureId: null, group: null,
    run: { provider: null, model: null, effort: null }, completeWhen: { checks: [], own: null },
    state: "not_queued", scheduledAt: null, session: null, source: null, report: null,
    createdAt: "2026-10-08T10:00:00.000Z", updatedAt: "2026-10-08T10:00:00.000Z", ...overrides,
  };
}
function board(tasks: Task[]): TaskBoard {
  return {
    version: 1, readiness: "ready", repositoryId, columns: [{ id: "col-1", name: "Backlog", position: 0 }, { id: "col-2", name: "Done", position: 1 }],
    features: [], tasks, queue: { status: "idle", blockedBy: null, pauseReason: null, order: [] }, runModels: { codex: [] },
  };
}

describe("TaskSessionsField", () => {
  const candidates: TaskSessionCandidate[] = [{ id: "claude:c1", title: "Candidate one", state: "working" }, { id: "codex:c2", title: null, state: "idle" }];

  it("lists the started session first, then each assigned one, with roles, state chips and Unassign on assigned rows only", async () => {
    const onUnassign = vi.fn();
    render(<TaskSessionsField started={started} assigned={[first, second]} onUnassign={onUnassign} />);
    const group = screen.getByRole("group", { name: "Sessions" });
    // Sessions is a row of the Run settings list: a group in the value, named by the row's label.
    expect(group).toHaveClass("taskSessions");
    expect(group.closest(".taskRow")?.querySelector("dt")).toHaveTextContent("Sessions");
    expect(document.querySelector("fieldset, legend")).toBeNull();
    const rows = within(group).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole("link", { name: "Started session" })).toHaveAttribute("href", "/sessions/claude-started");
    expect(within(rows[0]).getByRole("link", { name: "Started session" })).toHaveClass("commandTextLink");
    expect(within(rows[0]).getByText("Started by Pomegr")).toBeInTheDocument();
    expect(within(rows[0]).getByText("In progress")).toHaveClass("commandChip");
    expect(within(rows[0]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(rows[1]).getByText("Assigned")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Idle")).toHaveClass("commandChip");
    expect(within(rows[2]).getByText("Needs input")).toHaveClass("commandChip", "warning");
    expect(within(rows[2]).getByRole("button", { name: "Unassign Second assigned" })).toHaveClass("commandQuietAction");
    await userEvent.setup().click(within(rows[1]).getByRole("button", { name: "Unassign First assigned" }));
    expect(onUnassign).toHaveBeenCalledWith("claude:one");
    // Read-only: no assign control without candidates.
    expect(screen.queryByRole("combobox", { name: "Session to assign" })).not.toBeInTheDocument();
    expect(screen.queryByText(ASSIGN_HELPER)).not.toBeInTheDocument();
  });

  it("names a session without a title Untitled session", () => {
    render(<TaskSessionsField started={null} assigned={[session("x", null)]} onUnassign={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Untitled session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unassign Untitled session" })).toBeInTheDocument();
  });

  it("assigns the chosen session once and clears the choice", async () => {
    const onAssign = vi.fn();
    const user = userEvent.setup();
    render(<TaskSessionsField started={null} assigned={[]} candidates={candidates} onAssign={onAssign} />);
    expect(screen.getByText(ASSIGN_HELPER)).toBeInTheDocument();
    const assign = screen.getByRole("button", { name: "Assign session" });
    expect(assign).toHaveClass("commandSecondaryAction");
    expect(assign).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Session to assign" })).toHaveTextContent("Choose a session");
    chooseCommandOption(screen.getByRole("combobox", { name: "Session to assign" }), "Candidate one · In progress");
    expect(assign).toBeEnabled();
    await user.click(assign);
    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("claude:c1");
    expect(assign).toBeDisabled();
    chooseCommandOption(screen.getByRole("combobox", { name: "Session to assign" }), "Untitled session · Idle");
    await user.click(assign);
    expect(onAssign).toHaveBeenLastCalledWith("codex:c2");
  });

  it("disables everything while busy", () => {
    render(<TaskSessionsField started={null} assigned={[first]} candidates={candidates} busy onAssign={vi.fn()} onUnassign={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Session to assign" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Assign session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Unassign First assigned" })).toBeDisabled();
  });

  it("shows the placeholder and disables the control when no other session exists", () => {
    render(<TaskSessionsField started={null} assigned={[]} candidates={[]} onAssign={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Session to assign" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Session to assign" })).toHaveTextContent("No other session in this repository");
    expect(screen.getByRole("button", { name: "Assign session" })).toBeDisabled();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("renders nothing without a session and without an assign control", () => {
    const { container } = render(<TaskSessionsField started={null} assigned={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an error line as an alert", () => {
    render(<TaskSessionsField started={null} assigned={[first]} error="The session could not be assigned." />);
    expect(screen.getByRole("alert")).toHaveTextContent("The session could not be assigned.");
  });
});

describe("TaskCard sessions line", () => {
  const line = (container: HTMLElement) => container.querySelector(".taskCardSessions") as HTMLElement | null;
  const renderCard = (t: Task) => render(<ul><TaskCard task={t} /></ul>).container;

  it("links the started session alone", () => {
    const l = line(renderCard(task({ session: started })))!;
    expect(l).toHaveClass("taskCardDetail");
    expect(within(l).getByRole("link", { name: "Open session" })).toHaveClass("commandTextLink", "taskCardLink");
    expect(l).toHaveTextContent(/^Open session$/);
  });

  it("counts the other sessions as +N more after the started one", () => {
    const l = line(renderCard(task({ session: started, assigned: [first, second] })))!;
    expect(within(l).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-started");
    expect(within(l).getByText("+2 more")).toBeInTheDocument();
    expect(within(l).queryByText("Assigned")).not.toBeInTheDocument();
  });

  it("links the first assigned session and says Assigned when Pomegr started none", () => {
    const l = line(renderCard(task({ assigned: [first] })))!;
    expect(within(l).getByRole("link", { name: "Open session" })).toHaveAttribute("href", "/sessions/claude-one");
    expect(within(l).getByText("Assigned")).toBeInTheDocument();
    expect(within(l).queryByText(/more/)).not.toBeInTheDocument();
    const many = line(renderCard(task({ id: "T-2", assigned: [first, second] })))!;
    expect(within(many).getByText("+1 more")).toBeInTheDocument();
  });

  it("has no line without any session", () => {
    expect(line(renderCard(task()))).toBeNull();
    expect(line(renderCard(task({ id: "T-3", assigned: [] })))).toBeNull();
  });
});

describe("SessionTaskCell with assigned tasks", () => {
  const ref = (id: string, state: SessionTaskReference["state"] = null): SessionTaskReference => ({ id, repositoryId, state, featureId: null, feature: null, issue: null });

  it("reads a sole assigned task like a started one, with the muted word Assigned", () => {
    const { container } = render(<SessionTaskCell task={null} assigned={[ref("T-12", "needs_review")]} />);
    expect(screen.getByRole("link", { name: "Open task T-12 on its board" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(container.querySelector(".commandChip")).toHaveTextContent("Needs review");
    expect(container.querySelector(".commandSessionTaskFeature")).toHaveTextContent("Assigned");
  });

  it("reads several assigned tasks as one line of ID links", () => {
    const { container } = render(<SessionTaskCell task={null} assigned={[ref("T-12"), ref("T-15", "done")]} />);
    const head = container.querySelector(".commandSessionTaskAssigned") as HTMLElement;
    expect(within(head).getByText("Assigned")).toHaveClass("commandSessionTaskFeature");
    expect(within(head).getAllByRole("link").map((link) => link.textContent)).toEqual(["T-12", "T-15"]);
    expect(container.querySelector(".commandChip")).toBeNull();
  });

  it("keeps the started task in full and lists the assigned ones after it", () => {
    const { container } = render(<SessionTaskCell task={ref("T-14")} assigned={[ref("T-12"), ref("T-15")]} />);
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["T-14", "T-12", "T-15"]);
    expect(within(container.querySelector(".commandSessionTaskAssigned") as HTMLElement).getByText("Assigned")).toBeInTheDocument();
  });

  it("ignores malformed assigned entries", () => {
    const bad = [null, 7, "T-1", { id: 3, repositoryId }, { id: "T-9" }] as unknown as SessionTaskReference[];
    const { container } = render(<SessionTaskCell task={null} assigned={bad} />);
    expect(container).toHaveTextContent(/^—$/);
    render(<SessionTaskCell task={null} assigned={[...bad, ref("T-12")]} />);
    expect(screen.getAllByRole("link", { name: "Open task T-12 on its board" })).toHaveLength(1);
    expect(screen.queryByRole("link", { name: /T-9/ })).not.toBeInTheDocument();
  });

  // T-188: a reviewer session shows the task it reviewed, marked Review, in the started task's form.
  it("marks a reviewer session's task with the muted word Review", () => {
    const { container } = render(<SessionTaskCell task={{ ...ref("T-12", "done"), role: "review" }} />);
    expect(screen.getByRole("link", { name: "Open task T-12 on its board" })).toHaveAttribute("href", `/tasks?repository=${repositoryId}`);
    expect(container.querySelector(".commandChip")).toHaveTextContent("Done");
    expect(container.querySelector(".commandSessionTaskFeature")).toHaveTextContent(/^Review$/);
    render(<SessionTaskCell task={ref("T-14")} />);
    expect(screen.getAllByText("Review")).toHaveLength(1);
  });

  it("has a design-system sample of a reviewer session", () => {
    render(<SessionTaskSection />);
    const section = screen.getByRole("heading", { level: 2, name: "Sessions list Task cell" }).closest("section") as HTMLElement;
    const reviewer = [...section.querySelectorAll(".designSystemSample")].find((element) => element.querySelector(":scope > span")?.textContent === "Reviewer session") as HTMLElement;
    expect(within(reviewer).getByRole("link", { name: "Open task T-12 on its board" })).toBeInTheDocument();
    expect(within(reviewer).getByText("Review")).toHaveClass("commandSessionTaskFeature");
  });

  it("titles the dash for a session that is neither started from a task nor assigned", () => {
    render(<SessionTaskCell task={null} assigned={[]} />);
    expect(screen.getByTitle("Not started from a task, reviewing one, or assigned to one")).toHaveTextContent("—");
    expect(document.querySelector(".commandSessionTask")).toBeNull();
  });
});

describe("parseTaskBoard assigned sessions", () => {
  const withAssigned = (assigned: unknown) => ({ ...board([task()]), tasks: [{ ...task(), assigned }] });

  it("keeps a valid assigned list and accepts none", () => {
    const kept = [first, { ...second, title: null, observedModel: "model-a", observedEffort: null }];
    expect(parseTaskBoard(withAssigned(kept), repositoryId)?.tasks[0].assigned).toEqual(kept);
    expect(parseTaskBoard(board([task()]), repositoryId)?.tasks[0].assigned).toBeUndefined();
    expect(parseTaskBoard(withAssigned([]), repositoryId)?.tasks[0].assigned).toEqual([]);
  });

  it("accepts 16 entries and rejects the whole board for 17", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => session(`s${index}`, "Title"));
    expect(parseTaskBoard(withAssigned(many(16)), repositoryId)).not.toBeNull();
    expect(parseTaskBoard(withAssigned(many(17)), repositoryId)).toBeNull();
  });

  it.each([
    ["not a list", "x"], ["an entry that is not an object", [7]], ["a missing id", [{ title: "t", state: "idle", observedModel: null, observedEffort: null }]],
    ["a numeric title", [{ ...first, title: 4 }]], ["a missing state", [{ id: "claude:a", title: null, observedModel: null, observedEffort: null }]], ["a numeric model", [{ ...first, observedModel: 3 }]],
  ])("rejects the board for %s", (_name, assigned) => {
    expect(parseTaskBoard(withAssigned(assigned), repositoryId)).toBeNull();
  });
});

describe("parseSessionCandidates", () => {
  it("keeps id, title and state only", () => {
    const parsed = parseSessionCandidates({ sessions: [{ id: "claude:abc", title: "  Fix it  ", activityStatus: "working", cwd: "/secret", prompt: "private" }] });
    expect(parsed).toEqual([{ id: "claude:abc", title: "Fix it", state: "working" }]);
  });

  it("turns Untitled session, blank and non-string titles into null and a missing status into unknown", () => {
    const parsed = parseSessionCandidates({ sessions: [{ id: "claude:a", title: "Untitled session", activityStatus: "idle" }, { id: "codex:b", title: "   " }, { id: "codex:c", title: 5, activityStatus: 7 }] });
    expect(parsed).toEqual([{ id: "claude:a", title: null, state: "idle" }, { id: "codex:b", title: null, state: "unknown" }, { id: "codex:c", title: null, state: "unknown" }]);
  });

  it("drops malformed IDs, non-objects and duplicates", () => {
    const parsed = parseSessionCandidates({ sessions: [{ id: "claude:a" }, { id: "claude:a", title: "again" }, { id: "../x" }, { id: "other:a" }, { id: 4 }, null, "claude:b", { id: "codex:ok" }] });
    expect(parsed?.map((row) => row.id)).toEqual(["claude:a", "codex:ok"]);
  });

  it("drops closed sessions", () => {
    const parsed = parseSessionCandidates({ sessions: [{ id: "claude:a", activityStatus: "closed" }, { id: "claude:b", activityStatus: "idle" }, { id: "claude:c", activityStatus: "stopped" }] });
    expect(parsed?.map((row) => row.id)).toEqual(["claude:b", "claude:c"]);
  });

  it("reads only the first 50 rows and rejects a malformed body", () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({ id: `claude:s${index}` }));
    expect(parseSessionCandidates({ sessions: rows })).toHaveLength(50);
    for (const body of [null, [], "x", {}, { sessions: "x" }]) expect(parseSessionCandidates(body)).toBeNull();
  });
});

describe("Task modal sessions", () => {
  const taskAction = vi.fn<(repositoryId: string, action: string, payload: unknown) => Promise<{ ok: true } | { ok: false; error: string }>>();
  const refresh = vi.fn(async () => {});
  const fetchMock = vi.fn();
  const directory = (rows: unknown[]) => fetchMock.mockImplementation(async (url: string) => String(url).startsWith("/api/sessions")
    ? { ok: true, json: async () => ({ sessions: rows }) } : { ok: false, json: async () => ({}) });
  const row = (id: string, title: string, activityStatus = "idle") => ({ id, title, activityStatus });
  async function open(t: Task) {
    useTasks.mockReturnValue({ board: board([t]), refresh });
    const user = userEvent.setup();
    render(<TaskBoardPane repositoryId={repositoryId} />);
    await user.click(screen.getByRole("button", { name: t.session?.title ?? t.text }));
    return { user, dialog: within(screen.getByRole("dialog", { name: "Task" })) };
  }
  /** The assign select, once the directory read has enabled it. */
  const ready = (dialog: ReturnType<typeof within>) => waitFor(() => {
    const found = dialog.getByRole("combobox", { name: "Session to assign" });
    expect(found).toBeEnabled();
    return found;
  });
  const optionLabels = (select: HTMLElement) => {
    fireEvent.click(select);
    const list = document.getElementById(select.getAttribute("aria-controls") ?? "") as HTMLElement;
    return within(list).getAllByRole("option").map((option) => option.textContent);
  };

  beforeEach(() => {
    taskAction.mockResolvedValue({ ok: true });
    (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = { taskAction };
    vi.stubGlobal("fetch", fetchMock);
    directory([]);
  });
  afterEach(() => {
    delete (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists the started and the assigned sessions and reads the directory once", async () => {
    const { dialog } = await open(task({ state: "queued", session: started, assigned: [first, second] }));
    const group = within(dialog.getByRole("group", { name: "Sessions" }));
    expect(group.getAllByRole("listitem")).toHaveLength(3);
    expect(group.getByText("Started by Pomegr")).toBeInTheDocument();
    expect(group.getAllByText("Assigned")).toHaveLength(2);
    expect(group.getAllByRole("button", { name: /^Unassign / })).toHaveLength(2);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/sessions?mode=directory&repositoryId=${repositoryId}&pageSize=50`);
  });

  it("offers only sessions that are not on the task, and at most ten", async () => {
    directory([row("claude:started", "Started session"), row("claude:one", "First assigned"), ...Array.from({ length: 14 }, (_, index) => row(`claude:free${index}`, `Free ${index}`))]);
    const { dialog } = await open(task({ state: "queued", session: started, assigned: [first] }));
    const labels = optionLabels(await ready(dialog));
    expect(labels).toHaveLength(SESSION_CANDIDATES_SHOWN);
    expect(labels[0]).toBe("Free 0 · Idle");
    expect(labels.join("|")).not.toMatch(/Started session|First assigned/);
  });

  it("offers fewer than ten when fewer remain, and none of the closed", async () => {
    directory([row("claude:a", "Open one"), row("claude:b", "Closed one", "closed")]);
    const { dialog } = await open(task());
    expect(optionLabels(await ready(dialog))).toEqual(["Open one · Idle"]);
  });

  it("assigns the chosen session with its ID and the task ID", async () => {
    directory([row("claude:free", "Free session", "working")]);
    const { user, dialog } = await open(task({ session: started }));
    chooseCommandOption(await ready(dialog), "Free session · In progress");
    await user.click(dialog.getByRole("button", { name: "Assign session" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "session_assign", { id: "T-1", sessionId: "claude:free" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("unassigns an assigned session", async () => {
    const { user, dialog } = await open(task({ state: "queued", session: started, assigned: [first] }));
    await user.click(dialog.getByRole("button", { name: "Unassign First assigned" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "session_unassign", { id: "T-1", sessionId: "claude:one" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows the limit message for a limit failure, the fixed failure otherwise, and the unassign failure", async () => {
    directory([row("claude:free", "Free session")]);
    const { user, dialog } = await open(task({ assigned: [first] }));
    chooseCommandOption(await ready(dialog), "Free session · Idle");
    taskAction.mockResolvedValueOnce({ ok: false, error: "limit" });
    await user.click(dialog.getByRole("button", { name: "Assign session" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent(ASSIGN_LIMIT_MESSAGE);
    chooseCommandOption(dialog.getByRole("combobox", { name: "Session to assign" }), "Free session · Idle");
    taskAction.mockResolvedValueOnce({ ok: false, error: "secret detail" });
    await user.click(dialog.getByRole("button", { name: "Assign session" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent(ASSIGN_FAILURE_MESSAGE));
    expect(dialog.getByRole("alert")).not.toHaveTextContent("secret");
    taskAction.mockResolvedValueOnce({ ok: false, error: "limit" });
    await user.click(dialog.getByRole("button", { name: "Unassign First assigned" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent(UNASSIGN_FAILURE_MESSAGE));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("offers no assign control for a done task but still lists and unassigns its sessions", async () => {
    const { user, dialog } = await open(task({ state: "done", session: started, assigned: [first] }));
    expect(dialog.getByRole("group", { name: "Sessions" })).toBeInTheDocument();
    expect(dialog.queryByRole("combobox", { name: "Session to assign" })).not.toBeInTheDocument();
    expect(dialog.queryByRole("button", { name: "Assign session" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(dialog.getByRole("button", { name: "Unassign First assigned" }));
    await waitFor(() => expect(taskAction).toHaveBeenCalledWith(repositoryId, "session_unassign", { id: "T-1", sessionId: "claude:one" }));
  });

  it("offers no assign control when the directory cannot be read", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { dialog } = await open(task({ session: started }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(dialog.queryByRole("combobox", { name: "Session to assign" })).not.toBeInTheDocument();
    expect(dialog.getByRole("group", { name: "Sessions" })).toBeInTheDocument();
  });
});

describe("Assigned sessions design-system section", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the section with its card, modal and Task cell samples from static data", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.reject(new Error("network use is forbidden")));
    render(<AssignedSessionsSection />);
    const section = screen.getByRole("heading", { level: 2, name: "Assigned sessions" }).closest("section") as HTMLElement;
    const labels = [...section.querySelectorAll(".designSystemSample > span")].map((element) => element.textContent);
    expect(labels).toEqual([
      "Card, stalled and resumed", "Card, started session and two assigned", "Card, not started, one assigned",
      "Task modal, Sessions", "Task modal, Sessions, none yet", "Sessions, paired phone or browser without assign",
      "Sessions list, assigned to one task", "Sessions list, assigned to several tasks", "Sessions list, started for one task and assigned to others",
    ]);
    expect(within(section).getAllByRole("group", { name: "Sessions" })).toHaveLength(3);
    expect(within(section).getAllByRole("combobox", { name: "Session to assign" })).toHaveLength(2);
    expect(section.querySelectorAll(".taskCardSessions")).toHaveLength(3);
    expect(within(section).getByText("+2 more")).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is documented in the surface pages and styled with tokens only", () => {
    const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");
    expect(read("docs", "internal", "design", "task-board.md")).toMatch(/Assigned sessions/);
    expect(read("docs", "internal", "design", "task-modal.md")).toContain("An assigned session can report this task complete or blocked.");
    const tasksCss = read("app", "styles", "tasks.css");
    for (const line of tasksCss.split(/\r?\n/).filter((entry) => entry.startsWith(".taskSessions"))) expect(line).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
