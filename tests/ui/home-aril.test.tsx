import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, agentMessage, conversationOf, harness, installHarness, newUser, removeHarness, setBridge, setInventory, settle, userMessage } from "./agent-chat-fixture";
import { answerLog, busyHome, desktopBridge, homeHarness, homeOf, board, liveSession, pairPhone, resetHome, taskLog } from "./home-fixture";

// Home with Aril: the Aril line, Needs you, and the running sessions from the Tasks home, the task logs, and the sessions Pomegr observes (fixed rules,
// no model run), and the composer with its suggestion chips. How focus mode works and how Send reaches the maximized panel is in home-focus.test.tsx.
vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname };
});
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, clientAccessMode: () => harness.mode, useClientAccess: () => ({ mode: harness.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
vi.mock("../../app/tasks-store", async () => {
  const { harness } = await import("./agent-chat-fixture");
  const { homeHarness } = await import("./home-fixture");
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }), useTaskBoards: (ids: string[]) => new Map(ids.map((id) => [id, homeHarness.boards.get(id) ?? { readiness: "ready", repositoryId: id, tasks: [] }])) };
});
vi.mock("../../app/tasks-home-store", async () => {
  const { homeHarness } = await import("./home-fixture");
  return { useTaskHome: () => homeHarness.taskHome };
});
vi.mock("../../app/agents-client", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useAgents: () => harness.agents };
});
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useRepositoryInventory: () => harness.inventory };
});

import { HomeDashboard } from "../../app/HomeDashboard";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";
import type { SessionSummary } from "../../shared/monitor-contract";

let chat: FakeChat;

beforeEach(() => {
  chat = installHarness();
  harness.pathname = "/";
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
});
afterEach(() => { removeHarness(); });

const user = newUser;
const homeField = () => document.getElementById("home-aril-message") as HTMLTextAreaElement;
const launcher = () => screen.queryByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const needsYou = () => screen.getByRole("region", { name: "Needs you" });
const rowsOf = (region: HTMLElement) => within(region).getAllByRole("link").map((row) => row.textContent);

function home(sessions: SessionSummary[] = []) {
  return render(<SessionCatalogProvider sessions={sessions}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
}

const waitingIn = (repositoryId: string) => liveSession("claude:waiting", { repositoryId, activityStatus: "needs_input", needsInput: true, title: "Answer me", createdAt: new Date(Date.now() - 2 * 60_000).toISOString() });

describe("the Aril line and Needs you", () => {
  it("are written from the Tasks home, the task logs, and the sessions by fixed rules, and run no model", async () => {
    busyHome();
    home([waitingIn(REPO_B)]);
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
    // One line for each thing to do: the action, a failure in amber, and the repository on the right. No task ID and no title.
    expect(rowsOf(needsYou())).toEqual([
      "Answer a session that is waiting for youclapline",
      "Review 1 finished taskCI failedpomegr",
      "Check 1 stalled taskpomegr",
      "Unblock 1 taskclapline",
      "Restart the paused queueA start failedclapline",
    ]);
    expect(needsYou()).not.toHaveTextContent(/T-\d|Retry the upload|Cut the upload|Rename the export/);
    expect(within(needsYou()).getByText("CI failed")).toHaveClass(/urgent/);
    expect(within(needsYou()).getByText("A start failed")).toHaveClass(/urgent/);
    // Each line links to the right place: the session, or the board of its repository.
    const links = within(needsYou()).getAllByRole("link").map((row) => row.getAttribute("href"));
    expect(links).toEqual(["/sessions/claude-waiting", `/tasks?repository=${REPO_A}`, `/tasks?repository=${REPO_A}`, `/tasks?repository=${REPO_B}`, `/tasks?repository=${REPO_B}`]);
    // One log read for each board, and the chat is asked for the thread's run only: no message, no model.
    expect(taskLog.mock.calls.map(([id]) => id).sort()).toEqual([REPO_A, REPO_B]);
    expect(chat.agentChat.mock.calls.every(([operation]) => operation === "thread" || operation === "warm")).toBe(true);
    expect(chat.calls("send")).toEqual([]);
  });

  it("draws nothing from the boards until the logs have answered, then draws the line and the lines together", async () => {
    busyHome();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    taskLog.mockImplementation(async (id: string) => { if (id === REPO_A) await held; return answerLog(id); });
    home();
    await settle();
    expect(screen.getByText("Reading the task logs…")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.queryByText(/^In the last 24 hours:/)).toBeNull();
    release();
    await settle();
    expect(screen.queryByText("Reading the task logs…")).toBeNull();
    expect(within(needsYou()).getByText("CI failed")).toBeInTheDocument();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
  });

  it("says that nothing was logged, and draws no Needs you when nothing waits", async () => {
    home();
    await settle();
    expect(screen.getByText("Nothing was logged in the last 24 hours.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("draws no line when no log could be read, and keeps the lines without a failure detail", async () => {
    busyHome();
    taskLog.mockImplementation(async () => ({ ok: false, error: "unavailable" }) as never);
    home();
    await settle();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
    expect(screen.queryByText("Reading the task logs…")).toBeNull();
    expect(within(needsYou()).getByText("Review 1 finished task")).toBeInTheDocument();
    expect(within(needsYou()).queryByText("CI failed")).toBeNull();
  });

  it("says so when only some logs could not be read", async () => {
    busyHome();
    taskLog.mockImplementation(async (id: string) => (id === REPO_B ? ({ ok: false, error: "unavailable" } as never) : answerLog(id)));
    home();
    await settle();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done. Some logs could not be read.")).toBeInTheDocument();
  });

  it("leaves out the lines of a repository the inventory does not list", async () => {
    busyHome();
    setInventory([[REPO_A, "pomegr"]]);
    home();
    await settle();
    expect(rowsOf(needsYou())).toEqual(["Review 1 finished taskCI failedpomegr", "Check 1 stalled taskpomegr"]);
  });

  it("shows eight lines and counts the rest", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `repo-${String(index).repeat(24)}`);
    setInventory(ids.map((id, index) => [id, `repo ${index}`]));
    homeHarness.taskHome = homeOf({ boards: ids.map((id) => board(id, { queue: { status: "paused", blockedBy: null, pauseReason: "cli_missing" } })) });
    home();
    await settle();
    expect(within(needsYou()).getAllByRole("link")).toHaveLength(8);
    expect(within(needsYou()).getByText("2 more things need you.")).toBeInTheDocument();
  });

  it("makes a session that waits a line even where the Tasks home cannot be read", async () => {
    homeHarness.taskHome = { version: 1, readiness: "unavailable", boards: [], attention: [], attentionTotal: 0 };
    home([waitingIn(REPO_A)]);
    await settle();
    expect(rowsOf(needsYou())).toEqual(["Answer a session that is waiting for youpomegr"]);
    expect(screen.getByText("Task boards are unavailable. Pomegr will retry.")).toBeInTheDocument();
  });
});

describe("Continue", () => {
  it("shows the running sessions: a state dot, the title, the state, its repository, and when it last changed; a waiting one first and in amber", async () => {
    homeHarness.boards = new Map([[REPO_A, { readiness: "ready", repositoryId: REPO_A, tasks: [{ id: "T-50", text: "[ui] Build the new Home\nDetails.", session: { id: "claude:task-run" } }] }]]);
    home([
      liveSession("claude:task-run", { title: "Session of the task" }),
      liveSession("claude:other", { title: "Rough overlay polish", provider: "claude", updatedAt: new Date(Date.now() - 90_000).toISOString() }),
      waitingIn(REPO_B),
      liveSession("claude:idle", { activityStatus: "idle" }),
    ]);
    await settle();
    const region = screen.getByRole("region", { name: /^Continue/ });
    expect(within(region).getByRole("heading", { name: /^Continue/ })).toHaveTextContent("Continue · 3 running");
    const list = within(region).getByRole("list", { name: "Running sessions" });
    expect(within(list).getAllByRole("link").map((row) => row.textContent)).toEqual([
      "Answer meWaiting for youclapline · updated just now",
      "Build the new HomeWorkingpomegr · updated just now",
      "Rough overlay polishWorkingpomegr · updated 1 min ago",
    ]);
    expect(within(list).getByText("Waiting for you")).toHaveClass(/waiting/);
    expect(within(list).getAllByText("Working")[0]).not.toHaveClass(/waiting/);
    // A session started for a task shows the task's title, and any other shows its own: the title of an idle session is not drawn at all.
    expect(within(list).queryByText("Session of the task")).toBeNull();
    expect(within(list).getAllByRole("link")[0]).toHaveAttribute("href", "/sessions/claude-waiting");
    expect(within(region).queryByRole("link", { name: /Open last viewed session/ })).toBeNull();
  });

  it("shows at most four sessions and counts all that run", async () => {
    home(Array.from({ length: 6 }, (_, index) => liveSession(`claude:s${index}`)));
    await settle();
    const region = screen.getByRole("region", { name: /^Continue/ });
    expect(within(region).getAllByRole("link", { name: /updated/ }).filter((row) => row.closest("ul")?.getAttribute("aria-label") === "Running sessions")).toHaveLength(4);
    expect(within(region).getByRole("heading", { name: /^Continue/ })).toHaveTextContent("Continue · 6 running");
  });

  it("waits for the board a title comes from, so a title is never drawn and then replaced", async () => {
    homeHarness.boards = new Map([[REPO_A, { readiness: "loading", repositoryId: REPO_A, tasks: [] }]]);
    const view = home([liveSession("claude:task-run", { title: "Session of the task" })]);
    await settle();
    expect(screen.queryByRole("list", { name: "Running sessions" })).toBeNull();
    expect(screen.queryByText("Session of the task")).toBeNull();
    homeHarness.boards = new Map([[REPO_A, { readiness: "ready", repositoryId: REPO_A, tasks: [{ id: "T-50", text: "Build the new Home", session: { id: "claude:task-run" } }] }]]);
    view.rerender(<SessionCatalogProvider sessions={[liveSession("claude:task-run", { title: "Session of the task" })]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await settle();
    expect(within(screen.getByRole("list", { name: "Running sessions" })).getByText("Build the new Home")).toBeInTheDocument();
    expect(screen.queryByText("Session of the task")).toBeNull();
  });

  it("shows the last viewed session when nothing runs, as before", async () => {
    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: "claude:idle", seenUpdateId: HOME_UPDATE_ID }));
    home([liveSession("claude:idle", { activityStatus: "idle", title: "Quiet work" })]);
    await settle();
    expect(screen.queryByRole("list", { name: "Running sessions" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open last viewed session: Quiet work" })).toHaveAttribute("href", "/sessions/claude-idle");
    expect(screen.getByRole("heading", { name: /^Continue/ })).toHaveTextContent(/^Continue$/);
  });

  it("keeps the pins in one small line", async () => {
    window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [{ kind: "view", id: "usage-limits" }, { kind: "project", id: "pomegr" }], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
    home([liveSession("claude:a")]);
    await settle();
    const list = screen.getByRole("list", { name: "Pinned" });
    expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual(["Usage limits", "pomegr"]);
    expect(screen.getByRole("link", { name: "Browse sessions" })).toHaveAttribute("href", "/sessions");
  });
});

describe("the status line", () => {
  it("is quiet: a dot and the name of each provider, and What's new on the same line", async () => {
    home();
    await settle();
    const status = screen.getByRole("complementary", { name: "Provider service status" });
    expect(within(status).getByText("Claude Code")).toBeInTheDocument();
    expect(within(status).getByText("Codex")).toBeInTheDocument();
    expect(status.parentElement).toBe(screen.getByRole("complementary", { name: "What’s new" }).parentElement);
    expect(screen.queryByText("Provider status")).toBeNull();
  });
});

describe("the composer on Home", () => {
  it("is the chat composer, with the repository, model, and effort, and the dock draws no launcher on Home", async () => {
    home();
    await settle();
    expect(homeField()).toHaveAccessibleName("Message Aril");
    const composer = homeField().closest("form")!;
    expect(composer).toHaveClass("agentChatComposer");
    expect(composer.closest(".agentChatHome")).not.toBeNull();
    expect(within(composer).getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(within(composer).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-large$/);
    expect(within(composer).getByRole("combobox", { name: "Effort" })).toHaveTextContent("Medium");
    expect(within(composer).getByRole("button", { name: "Attach image" })).toBeInTheDocument();
    expect(within(composer).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(composer).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open conversation" })).toBeNull();
    expect(launcher()).toBeNull();
  });

  it("starts from the run the repository's thread last ran with", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Question"), agentMessage("Answer", { provider: "codex", model: "model-code" })], { provider: "codex", model: "model-code", effort: "high" }));
    home();
    await settle();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-code$/);
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("High");
  });

  it("offers up to three fixed suggestions as chips, and a chip fills the field and sends nothing", async () => {
    busyHome();
    const person = user();
    home();
    await settle();
    const chips = within(screen.getByRole("list", { name: "Suggestions" })).getAllByRole("button");
    expect(chips.map((chip) => chip.textContent)).toEqual(["What needs my attention first?", "Which task should run first, and why?", "Is any task too big for one session?"]);
    for (const chip of chips) expect(chip).toHaveClass("commandQuietAction", "agentChatSuggestionChip");
    await person.type(homeField(), "an earlier draft");
    await person.click(chips[1]);
    expect(homeField()).toHaveValue("Which task should run first, and why?");
    expect(homeField()).toHaveFocus();
    expect(chat.calls("send")).toEqual([]);
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });

  it("falls back to the fixed suggestions when no board holds work and nothing waits", async () => {
    homeHarness.taskHome = homeOf({ boards: [board(REPO_A), board(REPO_B)] });
    home();
    await settle();
    expect(within(screen.getByRole("list", { name: "Suggestions" })).getAllByRole("button").map((chip) => chip.textContent)).toEqual(["Break this feature into tasks: ", "Which model fits this kind of task: "]);
  });

  it("is disabled with no repository", async () => {
    setInventory([]);
    home();
    await settle();
    expect(homeField()).toBeDisabled();
    expect(screen.getByText("No repositories observed yet.")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();
  });

  it("keeps its draft and drops the choice of run when another repository is chosen, and remembers the repository", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "High" }));
    await person.type(homeField(), "Plan this");
    await person.click(screen.getByRole("combobox", { name: "Repository" }));
    await person.click(screen.getByRole("option", { name: "clapline" }));
    await settle();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("clapline");
    expect(homeField()).toHaveValue("Plan this");
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent("Medium");
    expect(window.localStorage.getItem("pomegr.agentChat.repository")).toBe(REPO_B);
    expect(chat.calls("thread").map((payload) => payload.repositoryId)).toEqual([REPO_A, REPO_B]);
  });

  it("asks the desktop to keep a run ready while the field keeps its focus, as the panel's field does", async () => {
    const person = user();
    home();
    await settle();
    await person.click(homeField());
    await settle(300);
    expect(chat.calls("warm")).toEqual([{ repositoryId: REPO_A, provider: "claude", model: "model-large", effort: "medium" }]);
  });
});

describe("Home on a paired phone", () => {
  it("reads the logs and the thread through the paired routes, and sends through the panel's sheet", async () => {
    busyHome();
    const fetchMock = pairPhone(chat);
    const person = user();
    home();
    await settle();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
    expect(within(needsYou()).getByText(/CI failed/)).toBeInTheDocument();
    await person.type(homeField(), "From the phone");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(within(screen.getByRole("log", { name: "Conversation with Aril" })).getByText("From the phone")).toBeInTheDocument();
    const urls = new Set(fetchMock.mock.calls.map(([url]) => url));
    expect(urls.has("/api/tasks/log-read")).toBe(true);
    expect(urls.has("/api/agent-chat")).toBe(true);
    expect(launcher()).toBeNull();
  });
});

describe("Home in a browser that cannot reach the chat", () => {
  it("draws Needs you without a failure detail, and no Aril line, no log read, no composer, and no launcher", async () => {
    busyHome();
    setBridge(undefined);
    harness.mode = "local";
    home();
    await settle();
    expect(rowsOf(needsYou())).toEqual(["Review 1 finished taskpomegr", "Check 1 stalled taskpomegr", "Unblock 1 taskclapline", "Restart the paused queueA start failedclapline"]);
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
    expect(screen.queryByText("Reading the task logs…")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message Aril" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();
    expect(launcher()).toBeNull();
    expect(taskLog).not.toHaveBeenCalled();
  });

  it("draws nothing of the boards while the client is not yet known, so nothing is drawn and then taken away", async () => {
    busyHome();
    setBridge(undefined);
    harness.mode = "unknown";
    home();
    await settle();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message Aril" })).toBeNull();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
  });

  it("says that task boards are unavailable when the Tasks home is, and nothing when it is desktop only", async () => {
    homeHarness.taskHome = { version: 1, readiness: "unavailable", boards: [], attention: [], attentionTotal: 0 };
    const view = home();
    await settle();
    expect(screen.getByText("Task boards are unavailable. Pomegr will retry.")).toBeInTheDocument();
    homeHarness.taskHome = { version: 1, readiness: "desktop_only", boards: [], attention: [], attentionTotal: 0 };
    view.rerender(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await settle();
    expect(screen.queryByText("Task boards are unavailable. Pomegr will retry.")).toBeNull();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
  });
});

