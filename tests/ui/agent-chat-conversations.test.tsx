import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, STORAGE_KEY, agentMessage, chatId, conversationOf, harness, installHarness, newUser, removeHarness, setInventory, settle, userMessage } from "./agent-chat-fixture";
import { renderDock } from "./dock-helper";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";

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


let chat: FakeChat;

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const user = newUser;
/** The repositories the chat read the thread of, once each, in order. */
const listed = () => [...new Set(chat.calls("thread").map((payload) => payload.repositoryId))];
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
  it("closes on Escape and on Close, returns focus to the launcher, and keeps the draft", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    await person.type(field(), "A draft");
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
    await person.click(launcher());
    expect(field()).toHaveValue("A draft");
    expect(field()).toHaveFocus();
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
  });

  it("leaves Escape to an open list, and closes on the next Escape", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    await person.click(screen.getByRole("combobox", { name: "Model" }));
    expect(screen.getByRole("listbox", { name: "Model" })).toBeInTheDocument();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveFocus();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });

  it("never moves focus while an answer is written", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    await ask(person, "Cut it up");
    await person.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByRole("button", { name: "Dock" })).toHaveFocus();
    chat.write("Some text", "writing");
    await settle(500);
    chat.finish("All done");
    await settle(500);
    expect(screen.getByRole("button", { name: "Dock" })).toHaveFocus();
  });

  it("shows Answering on the launcher while the panel is closed, then a dot and a new-answer name until it is opened", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    await ask(person, "Think about it");
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(launcher()).toHaveTextContent("Aril · answering…");
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent, answering");
    expect(launcher().querySelector(".agentChatLauncherDot")).toBeNull();
    // A closed panel keeps following the answer.
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
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent");
    expect(launcher().querySelector(".agentChatLauncherDot")).toBeNull();
  });

  it("asks nothing while closed and idle, and keeps the dot away when the answer ended with the panel open", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    await ask(person, "Quick one");
    chat.finish("Done already");
    await settle(500);
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    const before = chat.agentChat.mock.calls.length;
    await settle(10_000);
    expect(chat.agentChat.mock.calls.length).toBe(before);
    expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent");
  });

  it("sends a message without a conversation, so the desktop continues the thread, and offers no way to pick or start one", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Old question"), agentMessage("Old answer")]));
    const person = user();
    await renderDock();
    await openPanel(person);
    expect(within(log()).getByText("Old answer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Conversations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Delete conversation/ })).toBeNull();
    await ask(person, "A new topic");
    expect(chat.calls("send")[0]).toMatchObject({ conversationId: null, text: "A new topic" });
    expect(chat.conversation(REPO_A, chatId(1))?.messages.map((message) => message.text)).toEqual(["Old question", "Old answer", "A new topic"]);
    // The old messages and the new one are one thread, in order.
    expect(within(log()).getByText("Old answer")).toBeInTheDocument();
    expect(within(log()).getByText("A new topic")).toBeInTheDocument();
  });

  it("follows the newest line only while the owner is at the bottom, and offers Jump to latest after they scroll up", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A")]));
    const person = user();
    await renderDock();
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

describe("the thread", () => {
  const AT_ONE = "2026-10-11T09:00:00.000Z";
  const stamped = (message: Record<string, unknown>, at: string) => ({ ...message, at });
  const seedThree = () => chat.seed(REPO_A,
    conversationOf(1, [stamped(userMessage("First topic"), AT_ONE), stamped(agentMessage("First answer"), "2026-10-11T09:01:00.000Z")], { title: "First topic" }),
    conversationOf(2, [stamped(userMessage("Second topic"), "2026-10-11T09:05:00.000Z"), stamped(agentMessage("Second answer"), "2026-10-11T09:06:00.000Z")], { title: "Second topic" }),
    conversationOf(3, [stamped(userMessage("Third topic"), "2026-10-11T09:03:00.000Z")], { title: "Third topic" }));

  it("shows the messages of every conversation of the repository as one thread in time order, with no conversation list", async () => {
    seedThree();
    const person = user();
    await renderDock();
    await openPanel(person);
    const articles = [...log().querySelectorAll<HTMLElement>("article")];
    expect(articles.map((article) => article.querySelector("p")?.textContent)).toBeDefined();
    const texts = ["First topic", "First answer", "Third topic", "Second topic", "Second answer"];
    const drawn = texts.map((text) => within(log()).getByText(text));
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index - 1].compareDocumentPosition(drawn[index]) & Node.DOCUMENT_POSITION_FOLLOWING, texts[index]).toBeTruthy();
    }
    expect(chat.calls("thread")[0]).toEqual({ repositoryId: REPO_A });
    expect(chat.calls("read")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Conversations" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Conversations" })).toBeNull();
    expect(screen.queryByText("Conversations are kept on this computer until you delete them.")).toBeNull();
    // Each line names the conversation it is stored in, which is how Apply finds its proposal.
    expect(within(log()).getByText("Third topic").closest("article")).toHaveAttribute("data-conversation-id", chatId(3));
    expect(within(log()).getByText("Second answer").closest("article")).toHaveAttribute("data-conversation-id", chatId(2));
  });

  it("says nothing of conversations when there are none, and shows the empty state", async () => {
    const person = user();
    await renderDock();
    await openPanel(person);
    expect(screen.getByRole("heading", { level: 3, name: "Ask Aril about this board" })).toBeInTheDocument();
    expect(screen.queryByText("No conversations yet.")).toBeNull();
  });

  it("shows the answer being written in whichever conversation it runs, with Stop, and no note of another conversation", async () => {
    seedThree();
    chat.turn = { repositoryId: REPO_A, conversationId: chatId(1), startedAt: "2026-10-11T10:00:00.000Z", provider: "claude", model: null, activity: "writing", text: "Partway" };
    const person = user();
    await renderDock();
    await openPanel(person);
    expect(within(log()).getByText("Partway")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.queryByText("Aril is answering in another conversation.")).toBeNull();
  });
});

describe("the repository", () => {
  const two: [string, string][] = [[REPO_A, "pomegr"], [REPO_B, "catalogus"]];

  it("draws no repository menu for one repository, and one in the composer for several", async () => {
    await renderDock();
    await openPanel();
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
    setInventory(two);
    await cleanupAndRender();
    await openPanel();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("pomegr");
    expect(screen.getByRole("combobox", { name: "Repository" }).closest("form")).toHaveClass("agentChatComposer");
  });

  async function cleanupAndRender() {
    document.body.innerHTML = "";
    await renderDock();
  }

  it("chooses from the validated repository parameter on a Tasks page", async () => {
    setInventory(two);
    harness.pathname = "/tasks";
    window.history.replaceState(null, "", `/tasks?repository=${REPO_B}`);
    window.localStorage.setItem(STORAGE_KEY, REPO_A);
    await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveTextContent("catalogus");
  });

  it("ignores a repository parameter that is not valid or not listed, and one outside the Tasks pages", async () => {
    setInventory(two);
    harness.pathname = "/tasks";
    window.history.replaceState(null, "", "/tasks?repository=repo-ffffffffffffffffffffffff");
    const first = await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
    first.unmount();
    chat.agentChat.mockClear();
    harness.pathname = "/sessions";
    window.history.replaceState(null, "", `/sessions?repository=${REPO_B}`);
    await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
  });

  it("chooses from a repository page's path, then the last one used, then the first listed", async () => {
    setInventory(two);
    harness.pathname = `/repositories/${REPO_B}/files`;
    window.localStorage.setItem(STORAGE_KEY, REPO_A);
    const first = await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    first.unmount();

    chat.agentChat.mockClear();
    harness.pathname = "/sessions";
    window.localStorage.setItem(STORAGE_KEY, REPO_B);
    const second = await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_B]);
    second.unmount();

    chat.agentChat.mockClear();
    window.localStorage.setItem(STORAGE_KEY, "not-an-id");
    await renderDock();
    await openPanel();
    expect(listed()).toEqual([REPO_A]);
  });

  it("remounts the chat for the repository the owner chooses, remembers only its id, and keeps focus on the menu", async () => {
    setInventory(two);
    chat.seed(REPO_A, conversationOf(1, [userMessage("Pomegr question"), agentMessage("Pomegr answer")]));
    chat.seed(REPO_B, conversationOf(1, [userMessage("Catalogus question"), agentMessage("Catalogus answer")]));
    const person = user();
    await renderDock();
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
    await renderDock();
    await openPanel();
    expect(screen.getByText("No repositories observed yet.")).toBeInTheDocument();
    expect(field()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(panel()).getByRole("button", { name: "Close Aril" })).toHaveFocus();
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("reads Loading while the repository inventory loads, and chooses once it arrives", async () => {
    setInventory([], true);
    const view = await renderDock();
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
