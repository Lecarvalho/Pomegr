import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, agentMessage, chatId, conversationOf, installHarness, newUser, removeHarness, settle, userMessage, harness, setBridge } from "./agent-chat-fixture";

vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname };
});
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, useClientAccess: () => ({ mode: harness.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
vi.mock("../../app/tasks-store", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }) };
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

import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";

let chat: FakeChat;

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const user = newUser;
/** The repositories the chat asked about, once each, in order. */
const listed = () => [...new Set(chat.calls("list").map((payload) => payload.repositoryId))];
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const sendButton = () => screen.getByRole("button", { name: "Send" });

async function openPanel(person = user()) {
  await person.click(launcher());
  await settle();
  return person;
}

async function ask(person: ReturnType<typeof user>, text: string) {
  await person.type(field(), text);
  await person.keyboard("{Enter}");
  await settle();
}

describe("agent chat availability", () => {
  it("draws nothing on a local client without the desktop bridge, and nothing while the client is not yet known", () => {
    setBridge(undefined);
    const { container, rerender } = render(<AgentChatDock />);
    expect(container).toBeEmptyDOMElement();
    harness.mode = "unknown";
    rerender(<AgentChatDock />);
    expect(container).toBeEmptyDOMElement();
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("draws the launcher with the desktop bridge and asks nothing until the panel opens", () => {
    render(<AgentChatDock />);
    const button = launcher();
    expect(button).toHaveAccessibleName("Open Aril, the Pomegr agent");
    expect(button).toHaveTextContent("Aril");
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(button).toHaveClass("agentChatLauncher");
    expect(document.getElementById(button.getAttribute("aria-controls") ?? "none")).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("reaches the chat through the paired-device route on a paired phone, and through no bridge", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    chat.seed(REPO_A, conversationOf(1, [userMessage("Hello"), agentMessage("Hi from the desktop")]));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return new Response(JSON.stringify(await chat.agentChat(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentChatDock />);
    await openPanel();
    expect(await within(log()).findByText("Hi from the desktop")).toBeInTheDocument();
    const first = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(first[0]).toBe("/api/agent-chat");
    expect(first[1]).toMatchObject({ method: "POST", cache: "no-store" });
    expect(JSON.parse(String(first[1].body))).toEqual({ operation: "list", payload: { repositoryId: REPO_A } });
    expect(fetchMock.mock.calls.map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { operation: string }).operation).slice(0, 2)).toEqual(["list", "read"]);
    expect(chat.agentChat.mock.calls.length).toBe(fetchMock.mock.calls.length);
  });
});

describe("opening the panel", () => {
  it("opens on the newest conversation, hides the launcher, and puts focus in the message field", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Old question"), agentMessage("Old answer")]), conversationOf(2, [userMessage("New question"), agentMessage("New answer")]));
    render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
    expect(chat.calls("read")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(2) }]);
    expect(within(log()).getByText("New question")).toBeInTheDocument();
    expect(within(log()).getByText("New answer")).toBeInTheDocument();
    expect(within(log()).queryByText("Old question")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open Aril/ })).toBeNull();
    expect(panel().tagName).toBe("SECTION");
    expect(panel()).not.toHaveAttribute("aria-modal");
    expect(within(panel()).getByRole("heading", { level: 2, name: "Aril" })).toBeInTheDocument();
    expect(within(panel()).queryByText("Task-board agent")).toBeNull();
    expect(field()).toHaveFocus();
    // The panel never traps focus: Tab leaves the field for the next control.
    expect(field()).toHaveAttribute("placeholder", "Ask Aril…");
  });

  it("shows the empty state only once the list is ready, never before it, and its suggestions only fill the field", async () => {
    const person = user();
    render(<AgentChatDock />);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => { if (operation === "list") await gate; return original(operation, payload); });
    await person.click(launcher());
    // The list has not answered yet: a quiet line, not the empty state that would then be replaced.
    expect(within(log()).getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Ask Aril about this board")).toBeNull();
    release();
    await settle();
    expect(within(log()).queryByText("Loading…")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(screen.getByText("Aril reads this repository's task board and Pomegr's session evidence, and proposes board changes that you apply.")).toBeInTheDocument();
    expect(screen.getByText("Aril can be wrong. Check a proposal before you apply it.")).toBeInTheDocument();
    const suggestions = ["Break this feature into tasks:", "Which task should run first, and why?", "Is any task too big for one session?", "Which model fits this kind of task:"];
    for (const name of suggestions) expect(screen.getByRole("button", { name })).toHaveClass("commandSecondaryAction");
    await person.click(screen.getByRole("button", { name: "Break this feature into tasks:" }));
    expect(field()).toHaveValue("Break this feature into tasks: ");
    expect(field()).toHaveFocus();
    await person.click(screen.getByRole("button", { name: "Which task should run first, and why?" }));
    expect(field()).toHaveValue("Which task should run first, and why?");
    expect(chat.calls("send")).toEqual([]);
  });

  it("shows no empty state while a saved conversation is being read", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Question"), agentMessage("Answer")]));
    const person = user();
    render(<AgentChatDock />);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => { if (operation === "read") await gate; return original(operation, payload); });
    await person.click(launcher());
    await settle();
    expect(within(log()).getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("Ask Aril about this board")).toBeNull();
    release();
    await settle();
    expect(within(log()).getByText("Answer")).toBeInTheDocument();
  });

  it("names the provider and model of each answer, and adds one fixed line under an answer that did not complete", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      userMessage("One"),
      agentMessage("Fine.", { provider: "codex", model: "model-code" }, "m-2"),
      userMessage("Two", "m-3"),
      agentMessage("Half an answer", { status: "stopped" }, "m-4"),
      agentMessage("", { status: "failed" }, "m-5"),
      agentMessage("", { status: "timed_out" }, "m-6"),
      agentMessage("", { status: "interrupted" }, "m-7"),
    ]));
    render(<AgentChatDock />);
    await openPanel();
    const messages = within(log()).getAllByRole("article", { name: "Aril" });
    expect(messages[0]).toHaveTextContent("Codex · model-code");
    expect(messages[1]).toHaveTextContent("Claude Code · default model");
    expect(messages[0].querySelector(".agentChatMessageNote")).toBeNull();
    expect(messages[1]).toHaveTextContent("Half an answer");
    expect(messages[1]).toHaveTextContent("Stopped.");
    expect(messages[2]).toHaveTextContent("Aril could not finish this answer. Check that the provider's CLI is installed, signed in, and up to date.");
    expect(messages[3]).toHaveTextContent("This answer took too long and was stopped.");
    expect(messages[4]).toHaveTextContent("Pomegr closed before this answer was finished.");
    expect(within(log()).getAllByRole("article", { name: "You" })).toHaveLength(2);
  });
});

describe("sending a message", () => {
  it("sends the text, the provider and the model, shows the pending message once, then the streamed answer and the stored one", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    // The run starts on the newest known Claude model and Medium: never a default.
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-large$/);
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^Medium$/);
    let release = () => {};
    chat.hold = new Promise<void>((resolve) => { release = resolve; });
    await person.type(field(), "  Which task should run first?  ");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toEqual([{ repositoryId: REPO_A, conversationId: null, text: "Which task should run first?", provider: "claude", model: "model-large", effort: "medium" }]);
    // The message is on its way: drawn once, the field is empty, and the activity line has a fixed word.
    expect(within(log()).getAllByText("Which task should run first?")).toHaveLength(1);
    expect(field()).toHaveValue("");
    expect(within(log()).getByRole("status")).toHaveTextContent("Starting…");
    expect(screen.queryByRole("button", { name: "Send" })).toBeInTheDocument();
    release();
    await settle();
    expect(within(log()).getAllByText("Which task should run first?")).toHaveLength(1);
    expect(within(log()).getByRole("status")).toHaveTextContent("Thinking…");
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();

    chat.write("Reading the board first", "reading_files");
    await settle(500);
    expect(within(log()).getByText("Reading the board first")).toBeInTheDocument();
    expect(within(log()).getByRole("status")).toHaveTextContent("Reading repository files…");
    expect(within(log()).getAllByText("Which task should run first?")).toHaveLength(1);
    for (const [activity, label] of [["reading_sessions", "Reading sessions…"], ["reading_usage", "Reading usage limits…"], ["writing", "Writing…"]] as const) {
      chat.write("Reading the board first", activity);
      await settle(500);
      expect(within(log()).getByRole("status")).toHaveTextContent(label);
    }
    // The partial answer is not a live region of its own.
    expect(within(log()).getByText("Reading the board first").closest("[aria-live]")).toHaveAttribute("aria-live", "off");

    chat.finish("Run T-3 first: it unblocks the rest.");
    await settle(500);
    expect(within(log()).getByText("Run T-3 first: it unblocks the rest.")).toBeInTheDocument();
    expect(within(log()).queryByRole("status")).toBeNull();
    expect(within(log()).queryByText("Reading the board first")).toBeNull();
    expect(within(log()).getAllByText("Which task should run first?")).toHaveLength(1);
    expect(sendButton()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("lists only named models, grouped by provider, and sends the model and the effort the owner chooses", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("combobox", { name: "Model" }));
    const list = screen.getByRole("listbox", { name: "Model" });
    expect([...list.querySelectorAll(".commandSelectGroup")].map((heading) => heading.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual(["model-large, Claude Code", "model-code, Codex"]);
    expect(list.textContent).not.toMatch(/default/i);
    await person.click(screen.getByRole("option", { name: /^model-code/ }));
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-code$/);

    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    expect(within(screen.getByRole("listbox", { name: "Effort" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["Low", "Medium", "High", "Xhigh"]);
    await person.click(screen.getByRole("option", { name: "High" }));
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^High$/);
    await ask(person, "Is T-12 too big?");
    expect(chat.calls("send")).toEqual([{ repositoryId: REPO_A, conversationId: null, text: "Is T-12 too big?", provider: "codex", model: "model-code", effort: "high" }]);
  });

  it("keeps a chosen effort when only the model changes, and a chosen model when only the effort changes", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "Low" }));
    await person.click(screen.getByRole("combobox", { name: "Model" }));
    await person.click(screen.getByRole("option", { name: /^model-code/ }));
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^Low$/);
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "Xhigh" }));
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-code$/);
    await ask(person, "Is T-12 too big?");
    expect(chat.calls("send")[0]).toMatchObject({ provider: "codex", model: "model-code", effort: "xhigh" });
  });

  it("starts the run from the open conversation's provider, model, and effort", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A", { provider: "codex", model: "model-code", effort: "high" })], { provider: "codex", model: "model-code", effort: "high" }));
    render(<AgentChatDock />);
    await openPanel();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-code$/);
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^High$/);
    await ask(user(), "Follow up");
    expect(chat.calls("send")[0]).toMatchObject({ conversationId: chatId(1), provider: "codex", model: "model-code", effort: "high" });
  });

  it("shows the newest known model and Medium for a stored conversation that has no model and no effort", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A")]));
    render(<AgentChatDock />);
    await openPanel();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-large$/);
    expect(screen.getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^Medium$/);
    await ask(user(), "Follow up");
    expect(chat.calls("send")[0]).toMatchObject({ conversationId: chatId(1), provider: "claude", model: "model-large", effort: "medium" });
  });

  it("names the effort in the caption of an answer that stored one, and leaves an older answer's caption as it was", async () => {
    chat.seed(REPO_A, conversationOf(1, [
      userMessage("One"), agentMessage("Fine.", { provider: "codex", model: "model-code", effort: "xhigh" }, "m-2"),
      userMessage("Two", "m-3"), agentMessage("Older.", {}, "m-4"),
    ]));
    render(<AgentChatDock />);
    await openPanel();
    const answers = within(log()).getAllByRole("article", { name: "Aril" });
    expect(answers[0].querySelector(".agentChatMessageCaption")).toHaveTextContent("Codex · model-code · Xhigh");
    expect(answers[1].querySelector(".agentChatMessageCaption")).toHaveTextContent(/^Claude Code · default model$/);
  });

  it("names the effort on the answer being written and on the stored answer", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await ask(person, "Think about it");
    chat.write("Partway", "writing");
    await settle(500);
    expect(log().querySelector(".isWriting .agentChatMessageCaption")).toHaveTextContent("Claude Code · model-large · Medium");
    chat.finish("Done.");
    await settle(500);
    expect(within(log()).getByText("Done.").closest("article")!.querySelector(".agentChatMessageCaption")).toHaveTextContent("Claude Code · model-large · Medium");
  });

  it("sends on Enter, makes a new line on Shift+Enter, and never sends while an IME composition is confirmed", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.type(field(), "first line{Shift>}{Enter}{/Shift}second line");
    expect(field()).toHaveValue("first line\nsecond line");
    expect(chat.calls("send")).toEqual([]);
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true, keyCode: 229 });
    await settle();
    expect(chat.calls("send")).toEqual([]);
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(chat.calls("send")[0]).toMatchObject({ text: "first line\nsecond line" });
  });

  it("disables Send for an empty or too long message, and shows the counter only past 3,600 characters", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(sendButton()).toBeDisabled();
    fireEvent.change(field(), { target: { value: "   \n  " } });
    expect(sendButton()).toBeDisabled();
    fireEvent.change(field(), { target: { value: "x".repeat(3_600) } });
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByText(/\/ 4,000/)).toBeNull();
    fireEvent.change(field(), { target: { value: "x".repeat(3_601) } });
    expect(screen.getByText("3,601 / 4,000")).not.toHaveClass("isOver");
    fireEvent.change(field(), { target: { value: "x".repeat(4_001) } });
    expect(screen.getByText("4,001 / 4,000")).toHaveClass("isOver");
    expect(sendButton()).toBeDisabled();
    await person.type(field(), "{Enter}");
    expect(chat.calls("send")).toEqual([]);
  });

  it("stops the answer being written", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await ask(person, "Cut this feature into tasks");
    chat.write("Starting on the cut", "writing");
    await settle(500);
    await person.click(screen.getByRole("button", { name: "Stop" }));
    await settle(500);
    expect(chat.calls("stop")).toEqual([{ repositoryId: REPO_A, conversationId: expect.stringMatching(/^chat-/) }]);
    expect(within(log()).getByText("Starting on the cut")).toBeInTheDocument();
    expect(within(log()).getByText("Stopped.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("says that an answer is being written in another conversation, and disables Send", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q1"), agentMessage("A1")]), conversationOf(2, [userMessage("Q2")]));
    chat.turn = { repositoryId: REPO_A, conversationId: chatId(2), startedAt: "2026-10-11T10:00:00.000Z", provider: "claude", model: null, activity: "thinking", text: "" };
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    // The panel opens on the conversation being answered.
    expect(within(log()).getByRole("status")).toHaveTextContent("Thinking…");
    expect(screen.queryByText("Aril is answering in another conversation.")).toBeNull();
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    await person.click(screen.getByRole("button", { name: /^Conversation 1 / }));
    await settle();
    expect(screen.getByText("Aril is answering in another conversation.")).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: "Another question" } });
    expect(sendButton()).toBeDisabled();
  });
});

describe("refused operations", () => {
  const cases: [string, string, string][] = [
    ["busy", "busy", "Aril is already answering. Wait for it to finish."],
    ["cli_missing", "cli_missing", "Claude Code is not installed on this computer."],
    ["limit", "limit", "This repository holds 50 conversations. Delete one to start another."],
    ["not_found", "not_found", "That conversation is no longer there."],
    ["invalid", "invalid", "That message could not be sent."],
    ["unavailable", "unavailable", "Aril could not be reached. Try again."],
  ];
  it.each(cases)("says %s in one fixed line and keeps what was typed", async (_name, refusal, copy) => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    chat.refuse = refusal;
    await ask(person, "Please keep this text");
    expect(screen.getByRole("alert")).toHaveTextContent(copy);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(field()).toHaveValue("Please keep this text");
    expect(within(log()).queryByText("Please keep this text")).toBeNull();
    expect(within(log()).queryByRole("status")).toBeNull();
  });

  it("names the provider that was asked when its command-line tool is missing", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("combobox", { name: "Model" }));
    await person.click(screen.getByRole("option", { name: /^model-code, Codex/ }));
    chat.refuse = "cli_missing";
    await ask(person, "Hello");
    expect(screen.getByRole("alert")).toHaveTextContent("Codex is not installed on this computer.");
  });

  it("says a full conversation is full when one is open, and answers a bridge that fails with the unreachable line", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A")]));
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    chat.refuse = "limit";
    await ask(person, "One more");
    expect(screen.getByRole("alert")).toHaveTextContent("This conversation is full. Start a new one.");
    chat.refuse = null;
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => { if (operation === "send") throw new Error("the bridge failed"); return original(operation, payload); });
    await person.click(sendButton());
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Aril could not be reached. Try again.");
    expect(field()).toHaveValue("One more");
  });

  it("clears the line on the next operation", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    chat.refuse = "busy";
    await ask(person, "First try");
    expect(screen.getByRole("alert")).toBeInTheDocument();
    chat.refuse = null;
    await person.keyboard("{Enter}");
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(chat.calls("send")).toHaveLength(2);
  });
});
