import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, agentMessage, conversationOf, harness, installHarness, newUser, removeHarness, setBridge, setInventory, settle, userMessage } from "./agent-chat-fixture";

// Home with Aril: the Aril line and Needs you from the Tasks home and the task logs (fixed rules, no model run), the composer and its
// suggestions, and the hand-off of a message to the docked panel (or the phone's sheet).
const taskHome = vi.hoisted(() => ({ value: null as unknown }));

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
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }) };
});
vi.mock("../../app/tasks-home-store", () => ({ useTaskHome: () => taskHome.value }));
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

let chat: FakeChat;
const hoursAgo = (hours: number) => Date.now() - hours * 3_600_000;
type LogEntry = { id: number; task: string; kind: string; at: number; pullRequest: number | null };
const logEntry = (id: number, task: string, kind: string, hours: number): LogEntry => ({ id, task, kind, at: hoursAgo(hours), pullRequest: null });
const logs = new Map<string, LogEntry[]>();
const answerLog = async (repositoryId: string) => ({ ok: true, log: { entries: logs.get(repositoryId) ?? [], more: false, arilCursor: 0 } });
const taskLog = vi.fn(answerLog);

const board = (repositoryId: string, overrides: Record<string, unknown> = {}) => ({
  repositoryId, readiness: "ready", counts: [0, 0, 0, 0, 0], openFeatures: 0, queue: { status: "idle", blockedBy: null, pauseReason: null }, updatedAt: new Date(hoursAgo(1)).toISOString(), ...overrides,
});
const homeOf = (overrides: Record<string, unknown> = {}) => ({ version: 1, readiness: "ready", boards: [board(REPO_A, { counts: [0, 1, 0, 1, 0] }), board(REPO_B)], attention: [], attentionTotal: 0, ...overrides });

/** The desktop app's bridge: the chat, its images, and the task log. */
function desktopBridge() {
  setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage, taskAction: vi.fn(), taskLog });
}

/** A phone: no bridge, and the paired-device routes of the chat and the task log. */
function pairPhone() {
  setBridge(undefined);
  harness.mode = "lan";
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { operation?: string; payload?: Record<string, unknown>; repositoryId?: string };
    if (url === "/api/agent-chat") return new Response(JSON.stringify(await chat.agentChat(String(body.operation), body.payload ?? {})), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/tasks/log-read") return new Response(JSON.stringify(await taskLog(String(body.repositoryId))), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error("offline");
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  chat = installHarness();
  harness.pathname = "/";
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  logs.clear();
  taskLog.mockReset();
  taskLog.mockImplementation(answerLog);
  taskHome.value = homeOf();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge();
});
afterEach(() => { removeHarness(); });

const user = newUser;
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const homeField = () => document.getElementById("home-aril-message") as HTMLTextAreaElement;
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const launcher = () => screen.queryByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const needsYou = () => screen.getByRole("region", { name: /^Needs you/ });

function home() {
  return render(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
}

/** The Tasks home with a paused queue, a task that needs review (its CI failed), a stalled task, and a blocked one. */
function busyHome() {
  taskHome.value = homeOf({
    boards: [board(REPO_A, { counts: [1, 1, 0, 1, 0] }), board(REPO_B, { queue: { status: "paused", blockedBy: null, pauseReason: "start_failed" } })],
    attention: [
      { repositoryId: REPO_A, taskId: "T-41", title: "Retry the upload with backoff", state: "needs_review" },
      { repositoryId: REPO_A, taskId: "T-35", title: "Cut the upload work into tasks", state: "stalled" },
      { repositoryId: REPO_B, taskId: "T-9", title: "Rename the export action", state: "blocked" },
    ],
    attentionTotal: 3,
  });
  logs.set(REPO_A, [logEntry(1, "T-40", "started", 30), logEntry(2, "T-41", "started", 5), logEntry(3, "T-41", "review", 3), logEntry(4, "T-41", "checks_failed", 1), logEntry(5, "T-42", "merged", 2), logEntry(6, "T-43", "done", 1)]);
  logs.set(REPO_B, [logEntry(1, "T-9", "blocked", 2)]);
}

describe("the Aril line and Needs you", () => {
  it("are written from the Tasks home and the task logs by fixed rules, and run no model", async () => {
    busyHome();
    home();
    await settle();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
    const rows = within(needsYou()).getAllByRole("link");
    expect(rows.map((row) => row.textContent)).toEqual([
      "clapline" + "Queue paused" + "A start failed",
      "pomegr" + "T-41" + "Retry the upload with backoff" + "Needs review · CI failed",
      "pomegr" + "T-35" + "Cut the upload work into tasks" + "Stalled",
      "clapline" + "T-9" + "Rename the export action" + "Blocked by agent",
    ]);
    expect(rows[1]).toHaveAttribute("href", `/tasks?repository=${REPO_A}`);
    expect(within(needsYou()).getByText("CI failed")).toHaveClass(/urgent/);
    expect(within(needsYou()).getByRole("heading", { name: /^Needs you/ })).toHaveTextContent("Needs you4");
    // One log read for each board, and the chat is asked for the thread's run only: no message, no model.
    expect(taskLog.mock.calls.map(([id]) => id).sort()).toEqual([REPO_A, REPO_B]);
    expect(chat.agentChat.mock.calls.every(([operation]) => operation === "thread" || operation === "warm")).toBe(true);
    expect(chat.calls("send")).toEqual([]);
  });

  it("draws nothing from the boards until the logs have answered, then draws the line and the rows together", async () => {
    busyHome();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    taskLog.mockImplementation(async (id: string) => { if (id === REPO_A) await held; return answerLog(id); });
    home();
    await settle();
    expect(screen.getByText("Reading the task logs…")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();
    expect(screen.queryByText(/^In the last 24 hours:/)).toBeNull();
    release();
    await settle();
    expect(screen.queryByText("Reading the task logs…")).toBeNull();
    expect(within(needsYou()).getByText(/CI failed/)).toBeInTheDocument();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
  });

  it("says that nothing was logged, and draws no Needs you when nothing waits", async () => {
    home();
    await settle();
    expect(screen.getByText("Nothing was logged in the last 24 hours.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();
  });

  it("draws no line when no log could be read, and keeps the rows without a detail", async () => {
    busyHome();
    taskLog.mockImplementation(async () => ({ ok: false, error: "unavailable" }) as never);
    home();
    await settle();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
    expect(screen.queryByText("Reading the task logs…")).toBeNull();
    expect(within(needsYou()).getAllByRole("link")[1]).toHaveTextContent("Needs review");
    expect(within(needsYou()).queryByText("CI failed")).toBeNull();
  });

  it("says so when only some logs could not be read", async () => {
    busyHome();
    taskLog.mockImplementation(async (id: string) => (id === REPO_B ? ({ ok: false, error: "unavailable" } as never) : answerLog(id)));
    home();
    await settle();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done. Some logs could not be read.")).toBeInTheDocument();
  });

  it("leaves out the items of a repository the inventory does not list", async () => {
    busyHome();
    setInventory([[REPO_A, "pomegr"]]);
    home();
    await settle();
    expect(within(needsYou()).getAllByRole("link").map((row) => row.textContent)).toEqual([
      "pomegr" + "T-41" + "Retry the upload with backoff" + "Needs review · CI failed",
      "pomegr" + "T-35" + "Cut the upload work into tasks" + "Stalled",
    ]);
  });

  it("shows five rows and a link to the rest", async () => {
    taskHome.value = homeOf({
      attention: Array.from({ length: 7 }, (_, index) => ({ repositoryId: REPO_A, taskId: `T-${index + 1}`, title: `Task ${index + 1}`, state: "blocked" })),
      attentionTotal: 7,
    });
    home();
    await settle();
    expect(within(needsYou()).getAllByRole("link")).toHaveLength(6);
    expect(within(needsYou()).getByRole("link", { name: "Show all 7" })).toHaveAttribute("href", "/tasks");
  });
});

describe("the composer on Home", () => {
  it("is the chat composer, with the repository, model, and effort, and the dock draws no launcher on Home", async () => {
    home();
    await settle();
    expect(homeField()).toHaveAccessibleName("Message Aril");
    const composer = homeField().closest("form")!;
    expect(composer).toHaveClass("agentChatComposer");
    expect(composer.parentElement!.closest(".agentChatHome")).not.toBeNull();
    expect(within(composer).getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(within(composer).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-large$/);
    expect(within(composer).getByRole("combobox", { name: "Effort" })).toHaveTextContent("Medium");
    expect(within(composer).getByRole("button", { name: "Attach image" })).toBeInTheDocument();
    expect(within(composer).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(composer).queryByRole("button", { name: "Stop" })).toBeNull();
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
    taskHome.value = homeOf({ boards: [board(REPO_A), board(REPO_B)] });
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

describe("Send on Home", () => {
  it("opens the panel on that repository's thread and sends the message there with the run the composer showed", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "High" }));
    await person.type(homeField(), "Which task should run first?");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toEqual([{ repositoryId: REPO_A, conversationId: null, text: "Which task should run first?", provider: "claude", model: "model-large", effort: "high" }]);
    expect(homeField()).toHaveValue("");
    expect(panel()).toBeVisible();
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveFocus();
    expect(within(log()).getByText("Which task should run first?")).toBeInTheDocument();
    expect(document.querySelector(".agentChatScrim")).not.toBeNull();
    // One send for one message: the panel does not send it again when it re-renders.
    await settle(2_000);
    expect(chat.calls("send")).toHaveLength(1);
  });

  it("sends once for each message, to the repository the composer shows", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Repository" }));
    await person.click(screen.getByRole("option", { name: "clapline" }));
    await person.type(homeField(), "First");
    await person.click(screen.getByRole("button", { name: "Send" }));
    await settle();
    expect(chat.calls("send").map((payload) => [payload.repositoryId, payload.text])).toEqual([[REPO_B, "First"]]);
    chat.finish("Done.");
    await settle(1_000);
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    await settle();
    await person.type(homeField(), "Second");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send").map((payload) => [payload.repositoryId, payload.text])).toEqual([[REPO_B, "First"], [REPO_B, "Second"]]);
    expect(within(log()).getByText("Second")).toBeInTheDocument();
  });

  it("returns focus to the Home message field when the panel closes, and draws no launcher", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("button", { name: "Open conversation" }));
    await settle();
    expect(panel()).toBeVisible();
    expect(launcher()).toBeNull();
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(homeField()).toHaveFocus();
    expect(launcher()).toBeNull();
  });

  it("opens the conversation without sending anything", async () => {
    chat.seed(REPO_B, conversationOf(1, [userMessage("Earlier question"), agentMessage("Earlier answer")]));
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Repository" }));
    await person.click(screen.getByRole("option", { name: "clapline" }));
    await person.type(homeField(), "Not sent yet");
    await person.click(screen.getByRole("button", { name: "Open conversation" }));
    await settle();
    expect(within(log()).getByText("Earlier answer")).toBeInTheDocument();
    expect(chat.calls("send")).toEqual([]);
    expect(homeField()).toHaveValue("Not sent yet");
  });

  it("keeps a draft that waits in the panel, and puts a refused message back in the panel's field with the fixed line", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("button", { name: "Open conversation" }));
    await settle();
    await person.type(within(panel()).getByRole("textbox", { name: "Message Aril" }), "A draft in the panel");
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    await settle();
    chat.refuse = "busy";
    await person.type(homeField(), "From Home");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Aril is already answering. Wait for it to finish.");
    // The draft was there first and stays; the refused message is not lost, and it is not typed over the draft.
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveValue("A draft in the panel");
    expect(within(log()).queryByText("From Home")).toBeNull();
  });

  it("puts a refused message in the panel's empty field", async () => {
    const person = user();
    home();
    await settle();
    chat.refuse = "unavailable";
    await person.type(homeField(), "From Home");
    await person.keyboard("{Enter}");
    await settle();
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveValue("From Home");
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Aril could not be reached. Try again.");
    expect(homeField()).toHaveValue("");
  });

  it("sends the images attached on Home with the message", async () => {
    const person = user();
    home();
    await settle();
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", { type: "image/png" });
    await person.upload(homeField().closest("form")!.querySelector<HTMLInputElement>('input[type="file"]')!, file);
    await settle();
    expect(within(homeField().closest("form")!).getByRole("list", { name: "Images to send" })).toBeInTheDocument();
    await person.type(homeField(), "What is wrong here?");
    await person.keyboard("{Enter}");
    await settle();
    const [sent] = chat.calls("send");
    expect(sent).toMatchObject({ text: "What is wrong here?", images: [expect.stringMatching(/^img-/)] });
    expect(within(homeField().closest("form")!).queryByRole("list", { name: "Images to send" })).toBeNull();
  });
});

describe("Home on a paired phone", () => {
  it("reads the logs and the thread through the paired routes, and sends through the panel's sheet", async () => {
    busyHome();
    const fetchMock = pairPhone();
    const person = user();
    home();
    await settle();
    expect(screen.getByText("In the last 24 hours: 1 started, 1 reached Review, 1 merged, 1 marked Done.")).toBeInTheDocument();
    expect(within(needsYou()).getByText(/CI failed/)).toBeInTheDocument();
    await person.type(homeField(), "From the phone");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(within(log()).getByText("From the phone")).toBeInTheDocument();
    const urls = new Set(fetchMock.mock.calls.map(([url]) => url));
    expect(urls.has("/api/tasks/log-read")).toBe(true);
    expect(urls.has("/api/agent-chat")).toBe(true);
    expect(launcher()).toBeNull();
  });
});

describe("Home in a browser that cannot reach the chat", () => {
  it("draws Needs you without a detail, and no Aril line, no log read, no composer, and no launcher", async () => {
    busyHome();
    setBridge(undefined);
    harness.mode = "local";
    home();
    await settle();
    expect(within(needsYou()).getAllByRole("link").map((row) => row.textContent)).toEqual([
      "clapline" + "Queue paused" + "A start failed",
      "pomegr" + "T-41" + "Retry the upload with backoff" + "Needs review",
      "pomegr" + "T-35" + "Cut the upload work into tasks" + "Stalled",
      "clapline" + "T-9" + "Rename the export action" + "Blocked by agent",
    ]);
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
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message Aril" })).toBeNull();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
  });

  it("says that task boards are unavailable when the Tasks home is, and nothing when it is desktop only", async () => {
    taskHome.value = { version: 1, readiness: "unavailable", boards: [], attention: [], attentionTotal: 0 };
    const view = home();
    await settle();
    expect(screen.getByText("Task boards are unavailable. Pomegr will retry.")).toBeInTheDocument();
    taskHome.value = { version: 1, readiness: "desktop_only", boards: [], attention: [], attentionTotal: 0 };
    view.rerender(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await settle();
    expect(screen.queryByText("Task boards are unavailable. Pomegr will retry.")).toBeNull();
    expect(screen.queryByText(/last 24 hours/)).toBeNull();
  });
});

