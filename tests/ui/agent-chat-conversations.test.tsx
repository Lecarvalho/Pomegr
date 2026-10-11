import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, STORAGE_KEY, agentMessage, chatId, conversationOf, harness, installHarness, newUser, removeHarness, setInventory, settle, userMessage } from "./agent-chat-fixture";

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

describe("the panel", () => {
  it("minimizes on Escape and on Minimize, returns focus to the launcher, and keeps the draft", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.type(field(), "A draft");
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
    await person.click(launcher());
    expect(field()).toHaveValue("A draft");
    expect(field()).toHaveFocus();
    await person.click(within(panel()).getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
  });

  it("leaves Escape to an open list, and minimizes on the next Escape", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("combobox", { name: "Run on" }));
    expect(screen.getByRole("listbox", { name: "Run on" })).toBeInTheDocument();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Run on" })).toHaveFocus();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });

  it("never moves focus while an answer is written", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await ask(person, "Cut it up");
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Conversations" })).toHaveFocus();
    chat.write("Some text", "writing");
    await settle(500);
    chat.finish("All done");
    await settle(500);
    expect(screen.getByRole("button", { name: "Conversations" })).toHaveFocus();
  });

  it("shows Answering on the launcher while minimized, then a dot and a new-answer name until the panel is opened", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await ask(person, "Think about it");
    await person.click(within(panel()).getByRole("button", { name: "Minimize" }));
    expect(launcher()).toHaveTextContent("Aril · answering…");
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent, answering");
    expect(launcher().querySelector(".agentChatLauncherDot")).toBeNull();
    // A minimized panel keeps following the answer.
    chat.write("Partway there", "writing");
    await settle(500);
    chat.finish("Finished while you were away");
    await settle(500);
    expect(launcher()).toHaveTextContent(/^Aril$/);
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent, new answer");
    expect(launcher().querySelector(".agentChatLauncherDot")).not.toBeNull();
    await person.click(launcher());
    await settle();
    expect(within(log()).getByText("Finished while you were away")).toBeInTheDocument();
    await person.click(within(panel()).getByRole("button", { name: "Minimize" }));
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent");
    expect(launcher().querySelector(".agentChatLauncherDot")).toBeNull();
  });

  it("asks nothing while minimized and idle, and keeps the dot away when the answer ended with the panel open", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await ask(person, "Quick one");
    chat.finish("Done already");
    await settle(500);
    await person.click(within(panel()).getByRole("button", { name: "Minimize" }));
    const before = chat.agentChat.mock.calls.length;
    await settle(10_000);
    expect(chat.agentChat.mock.calls.length).toBe(before);
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent");
  });

  it("starts a new conversation, focuses the field, and leaves the conversation list", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Old question"), agentMessage("Old answer")]));
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(within(log()).getByText("Old answer")).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    await person.click(screen.getByRole("button", { name: "New conversation" }));
    await settle();
    expect(screen.getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-pressed", "false");
    expect(field()).toHaveFocus();
    await ask(person, "A new topic");
    expect(chat.calls("send")[0]).toMatchObject({ conversationId: null, text: "A new topic" });
  });

  it("follows the newest line only while the owner is at the bottom, and offers Jump to latest after they scroll up", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A")]));
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    const element = log();
    let top = 0;
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => 1_000 });
    Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 300 });
    Object.defineProperty(element, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
    // At the bottom: new text keeps the newest line in view.
    top = 700;
    fireEvent.scroll(element);
    await ask(person, "More");
    expect(top).toBe(1_000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    // Scrolled up: the view stays where the owner left it, and the quiet action appears.
    top = 100;
    fireEvent.scroll(element);
    chat.write("New text arrives while you read above", "writing");
    await settle(500);
    expect(top).toBe(100);
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    expect(jump).toHaveClass("commandQuietAction");
    await person.click(jump);
    expect(top).toBe(1_000);
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });
});

describe("saved conversations", () => {
  const seedThree = () => chat.seed(REPO_A,
    conversationOf(1, [userMessage("First topic"), agentMessage("First answer")], { title: "First topic" }),
    conversationOf(2, [userMessage("Second topic"), agentMessage("Second answer")], { title: "Second topic" }),
    conversationOf(3, [userMessage("Third topic")], { title: "Third topic" }));

  it("lists them with the open one marked, opens one, and leaves the list", async () => {
    seedThree();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    const toggle = screen.getByRole("button", { name: "Conversations" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await person.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { level: 3, name: "Conversations" })).toBeInTheDocument();
    expect(screen.queryByRole("log")).toBeNull();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    // Newest first; the newest one is open.
    expect(rows[0]).toHaveTextContent("Third topic");
    expect(rows[0].querySelector("[aria-current='true']")).not.toBeNull();
    expect(rows[1].querySelector("[aria-current]")).toBeNull();
    expect(rows[0]).toHaveTextContent(/1 message · [A-Z][a-z]{2} \d{1,2}, \d\d:\d\d/);
    expect(rows[1]).toHaveTextContent(/2 messages · /);
    expect(screen.getByText("Conversations are kept on this computer until you delete them.")).toBeInTheDocument();
    await person.click(within(rows[2]).getByRole("button", { name: /^First topic/ }));
    await settle();
    expect(chat.calls("read").at(-1)).toEqual({ repositoryId: REPO_A, conversationId: chatId(1) });
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(within(log()).getByText("First answer")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("says that there are none yet", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByText("No conversations yet.")).toBeInTheDocument();
  });

  it("deletes after an inline question, and keeps the conversation when asked to keep it", async () => {
    seedThree();
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    const remove = screen.getByRole("button", { name: "Delete conversation: Second topic" });
    expect(remove).toHaveClass("commandIconAction");
    await person.click(remove);
    const question = screen.getByRole("group", { name: "Delete Second topic?" });
    expect(within(question).getByRole("button", { name: "Delete" })).toHaveClass("commandSecondaryAction");
    expect(within(question).getByRole("button", { name: "Keep" })).toHaveClass("commandQuietAction");
    expect(within(question).getByRole("button", { name: "Keep" })).toHaveFocus();
    await person.click(within(question).getByRole("button", { name: "Keep" }));
    expect(screen.queryByRole("group", { name: /Delete/ })).toBeNull();
    expect(chat.calls("delete")).toEqual([]);
    // Escape answers the question first and does not minimize the panel.
    await person.click(screen.getByRole("button", { name: "Delete conversation: Second topic" }));
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: /Delete/ })).toBeNull();
    expect(panel()).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Delete conversation: Second topic" }));
    await person.click(screen.getByRole("button", { name: "Delete" }));
    await settle();
    expect(chat.calls("delete")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(2) }]);
    expect(screen.queryByText("Second topic")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("does not let the conversation whose answer is being written be deleted", async () => {
    seedThree();
    chat.turn = { repositoryId: REPO_A, conversationId: chatId(2), startedAt: "2026-10-11T10:00:00.000Z", provider: "claude", model: null, activity: "writing", text: "Partway" };
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: "Delete conversation: Second topic" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete conversation: First topic" })).toBeEnabled();
  });
});

describe("the repository", () => {
  const two: [string, string][] = [[REPO_A, "pomegr"], [REPO_B, "catalogus"]];

  it("draws no repository menu for one repository, and a compact one under the header for several", async () => {
    render(<AgentChatDock />);
    await openPanel();
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
    setInventory(two);
    cleanupAndRender();
    await openPanel();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
  });

  function cleanupAndRender() {
    document.body.innerHTML = "";
    render(<AgentChatDock />);
  }

  it("chooses from the validated repository parameter on a Tasks page", async () => {
    setInventory(two);
    harness.pathname = "/tasks";
    window.history.replaceState(null, "", `/tasks?repository=${REPO_B}`);
    window.localStorage.setItem(STORAGE_KEY, REPO_A);
    render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("catalogus");
  });

  it("ignores a repository parameter that is not valid or not listed, and one outside the Tasks pages", async () => {
    setInventory(two);
    harness.pathname = "/tasks";
    window.history.replaceState(null, "", "/tasks?repository=repo-ffffffffffffffffffffffff");
    const first = render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
    first.unmount();
    chat.agentChat.mockClear();
    harness.pathname = "/sessions";
    window.history.replaceState(null, "", `/sessions?repository=${REPO_B}`);
    render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
  });

  it("chooses from a repository page's path, then the last one used, then the first listed", async () => {
    setInventory(two);
    harness.pathname = `/repositories/${REPO_B}/files`;
    window.localStorage.setItem(STORAGE_KEY, REPO_A);
    const first = render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    first.unmount();

    chat.agentChat.mockClear();
    harness.pathname = "/sessions";
    window.localStorage.setItem(STORAGE_KEY, REPO_B);
    const second = render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    second.unmount();

    chat.agentChat.mockClear();
    window.localStorage.setItem(STORAGE_KEY, "not-an-id");
    render(<AgentChatDock />);
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
  });

  it("remounts the chat for the repository the owner chooses, remembers only its id, and keeps focus on the menu", async () => {
    setInventory(two);
    chat.seed(REPO_A, conversationOf(1, [userMessage("Pomegr question"), agentMessage("Pomegr answer")]));
    chat.seed(REPO_B, conversationOf(1, [userMessage("Catalogus question"), agentMessage("Catalogus answer")]));
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(within(log()).getByText("Pomegr answer")).toBeInTheDocument();
    await person.type(field(), "unsent draft");
    await person.click(screen.getByRole("combobox", { name: "Repository" }));
    await person.click(screen.getByRole("option", { name: "catalogus" }));
    await settle();
    expect(listed().at(-1)).toBe(REPO_B);
    expect(within(log()).getByText("Catalogus answer")).toBeInTheDocument();
    expect(within(log()).queryByText("Pomegr answer")).toBeNull();
    expect(field()).toHaveValue("");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(REPO_B);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("catalogus");
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveFocus();
    const stored = Object.keys(window.localStorage).map((key) => window.localStorage.getItem(key)).join("|");
    expect(stored).not.toMatch(/question|answer|draft/);
  });

  it("says that no repository is observed yet and disables the field, and asks nothing", async () => {
    setInventory([]);
    render(<AgentChatDock />);
    await openPanel();
    expect(screen.getByText("No repositories observed yet.")).toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(panel()).getByRole("button", { name: "Minimize" })).toHaveFocus();
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("reads Loading while the repository inventory loads, and chooses once it arrives", async () => {
    setInventory([], true);
    const view = render(<AgentChatDock />);
    await openPanel();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByText("No repositories observed yet.")).toBeNull();
    setInventory([[REPO_A, "pomegr"]]);
    view.rerender(<AgentChatDock />);
    await settle();
    expect(listed()).toEqual([REPO_A]);
    expect(screen.getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });
});
