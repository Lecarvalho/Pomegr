import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AT, FakeChat, REPO_A, agentMessage, chatId, conversationOf, harness, installHarness, newUser, proposalOf, removeHarness, settle, userMessage } from "./agent-chat-fixture";

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
import { mergeNewest, threadMessageKey, type LoadedThread } from "../../app/agent-chat-client";
import { SEARCH_DELAY_MS } from "../../app/agent-chat-search";
import { splitMatch } from "../../app/components/agent-chat/agent-chat-presentation";
import { AGENT_CHAT_BOUNDS, type AgentChatThreadMessage } from "../../shared/agent-chat-contract";
import { LIST_LIMIT, SEARCH_LIMIT, SEARCH_QUERY_LIMIT, THREAD_PAGE } from "../../desktop/runtime/agent-chat-thread.mjs";

// One continuous conversation for each repository: the thread loads older pages as the owner scrolls up, keeps the place of what
// they read, brings a message into view, and is searched.
let chat: FakeChat;
const user = newUser;
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const searchButton = () => within(panel()).getByRole("button", { name: "Search" });
const searchField = () => screen.getByRole("searchbox", { name: "Search messages" });

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); window.history.replaceState(null, "", "/"); });

async function openPanel(person = user()) {
  render(<AgentChatDock />);
  await person.click(launcher());
  await settle();
  return person;
}

const minute = (index: number) => `2026-10-11T09:${String(index).padStart(2, "0")}:00.000Z`;
/** A conversation of `count` messages, each one a minute after the one before, texted "<prefix> <n>". */
function exchange(number: number, count: number, prefix: string, from = 0) {
  return conversationOf(number, Array.from({ length: count }, (_, index) => {
    const at = minute(from + index);
    const id = `m-${index + 1}`;
    return index % 2 === 0 ? { ...userMessage(`${prefix} ${index + 1}`, id), at } : { ...agentMessage(`${prefix} ${index + 1}`, {}, id), at };
  }));
}

/** Gives the log a height the way a layout would: 100px for each message drawn, in a window of 250px. */
function layout(element: HTMLElement, state: { top: number }) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => element.querySelectorAll("article").length * 100 });
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => 250 });
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => state.top, set: (value: number) => { state.top = value; } });
}

const textsOf = () => [...log().querySelectorAll("article")].map((article) => article.querySelector("p:not(.agentChatMessageHead), .agentChatQuietText")?.textContent);

describe("older messages", () => {
  it("loads the page before the first message when the owner scrolls to the top, and keeps the place of what they read", async () => {
    chat.pageSize = 3;
    chat.seed(REPO_A, exchange(1, 8, "Message"));
    await openPanel();
    expect(textsOf()).toEqual(["Message 6", "Message 7", "Message 8"]);
    const place = { top: 0 };
    layout(log(), place);
    // At the top of three messages: the page before them is asked for, by the cursor the desktop gave.
    place.top = 0;
    fireEvent.scroll(log());
    await settle();
    expect(chat.calls("thread")[1]).toEqual({ repositoryId: REPO_A, before: expect.any(String) });
    expect(textsOf()).toEqual(["Message 3", "Message 4", "Message 5", "Message 6", "Message 7", "Message 8"]);
    // Three messages of 100px were added above: the log moved down by as much, so the owner still reads what they read.
    expect(place.top).toBe(300);
    // Away from the top, nothing is asked.
    const asked = chat.calls("thread").length;
    place.top = 300;
    fireEvent.scroll(log());
    await settle();
    expect(chat.calls("thread")).toHaveLength(asked);
    // The first page of the thread: the last one is loaded, and then there is nothing more to ask.
    place.top = 10;
    fireEvent.scroll(log());
    await settle();
    expect(textsOf().slice(0, 3)).toEqual(["Message 1", "Message 2", "Message 3"]);
    expect(textsOf()).toHaveLength(8);
    const done = chat.calls("thread").length;
    place.top = 0;
    fireEvent.scroll(log());
    await settle();
    expect(chat.calls("thread")).toHaveLength(done);
  });

  it("asks once while a page is on its way, and says that earlier messages load", async () => {
    chat.pageSize = 2;
    chat.seed(REPO_A, exchange(1, 6, "Message"));
    await openPanel();
    const place = { top: 0 };
    layout(log(), place);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => { if (operation === "thread" && "before" in payload) await gate; return original(operation, payload); });
    fireEvent.scroll(log());
    fireEvent.scroll(log());
    await settle();
    expect(screen.getByText("Loading earlier messages…")).toBeInTheDocument();
    expect(chat.calls("thread").filter((payload) => "before" in payload)).toHaveLength(1);
    release();
    await settle();
    expect(screen.queryByText("Loading earlier messages…")).toBeNull();
    expect(textsOf()).toEqual(["Message 3", "Message 4", "Message 5", "Message 6"]);
  });

  it("loads the page before a log that does not fill its height, once it has a height", async () => {
    chat.pageSize = 2;
    chat.seed(REPO_A, exchange(1, 6, "Message"));
    // The log has a height but its messages leave room: the desktop is asked again without a scroll.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 5_000 });
    try {
      await openPanel();
      await settle(100);
      expect(textsOf()).toHaveLength(6);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "clientHeight", original); else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    }
  });

  it("keeps the thread and loads nothing when the desktop refuses a page", async () => {
    chat.pageSize = 2;
    chat.seed(REPO_A, exchange(1, 6, "Message"));
    await openPanel();
    layout(log(), { top: 0 });
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => (operation === "thread" && "before" in payload ? { ok: false, error: "invalid" } : original(operation, payload)));
    fireEvent.scroll(log());
    await settle();
    expect(textsOf()).toEqual(["Message 5", "Message 6"]);
    expect(screen.getByRole("alert")).toHaveTextContent("That message could not be sent.");
  });
});

describe("a message brought into view", () => {
  const link = (conversationId: string, messageId: string) => `/tasks?repository=${REPO_A}&aril=${conversationId}&message=${messageId}`;

  it("is loaded by loading older pages, scrolled to, and marked for two seconds", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      chat.pageSize = 3;
      chat.seed(REPO_A, exchange(1, 6, "Old", 0), exchange(2, 6, "New", 10));
      harness.pathname = "/tasks";
      window.history.replaceState(null, "", link(chatId(1), "m-2"));
      render(<AgentChatDock />);
      await settle();
      expect(panel()).toBeVisible();
      const line = within(log()).getByText("Old 2").closest("article")!;
      expect(line).toHaveAttribute("data-conversation-id", chatId(1));
      expect(line).toHaveAttribute("data-message-id", "m-2");
      // Twelve messages in pages of three: the thread was read back until the message was there.
      expect(chat.calls("thread").filter((payload) => "before" in payload).length).toBeGreaterThanOrEqual(3);
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(line);
      expect(scrolled.mock.calls[0][0]).toEqual({ block: "center" });
      expect(line).toHaveClass("isMarked");
      await settle(2_100);
      expect(line).not.toHaveClass("isMarked");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("stops after ten pages, and leaves the thread at its newest line when the message is not there", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      chat.pageSize = 1;
      chat.seed(REPO_A, exchange(1, 30, "Message"));
      harness.pathname = "/tasks";
      window.history.replaceState(null, "", link(chatId(9), "m-1"));
      chat.seed(REPO_A, conversationOf(9, []));
      render(<AgentChatDock />);
      await settle(200);
      expect(chat.calls("thread").filter((payload) => "before" in payload)).toHaveLength(10);
      expect(scrolled).not.toHaveBeenCalled();
      expect(within(log()).getByText("Message 30")).toBeInTheDocument();
      expect(log().querySelector(".isMarked")).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("the proposal of an older conversation", () => {
  it("is applied in its own conversation, and its card shows the outcome where it stands", async () => {
    chat.seed(REPO_A,
      conversationOf(1, [{ ...userMessage("Plan it"), at: minute(0) }, { ...agentMessage("Here is a plan.", { proposal: proposalOf() }, "m-2"), at: minute(1) }]),
      conversationOf(2, [{ ...userMessage("A later question"), at: minute(5) }, { ...agentMessage("A later answer"), at: minute(6) }]));
    const person = await openPanel();
    expect(textsOf()).toContain("A later answer");
    await person.click(within(screen.getByRole("region", { name: "Proposed board changes" })).getByRole("button", { name: "Apply changes" }));
    await settle();
    expect(chat.calls("apply")).toEqual([{ repositoryId: REPO_A, conversationId: chatId(1), proposalId: "p-0123456789ab" }]);
    expect(screen.getByRole("region", { name: "Proposed board changes" }).querySelector(".commandChip")).toHaveTextContent("Applied");
    expect(harness.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("images in the thread", () => {
  it("reads each image through the conversation whose message holds it", async () => {
    const urlApi = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
    urlApi.createObjectURL = vi.fn(() => "blob:pomegr/1");
    urlApi.revokeObjectURL = vi.fn();
    try {
      const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
      const first = chat.storeImage("img-000000000001", png);
      const second = chat.storeImage("img-000000000002", png);
      chat.seed(REPO_A,
        conversationOf(1, [{ ...userMessage("First picture", "m-1"), at: minute(0), images: [first] }, { ...agentMessage("Seen"), at: minute(1) }]),
        conversationOf(2, [{ ...userMessage("Second picture", "m-1"), at: minute(2), images: [second] }, { ...agentMessage("Seen too"), at: minute(3) }]));
      await openPanel();
      expect(chat.agentChatImage.mock.calls.map(([, payload]) => payload).sort((left, right) => String(left.imageId).localeCompare(String(right.imageId)))).toEqual([
        { repositoryId: REPO_A, conversationId: chatId(1), imageId: first.id },
        { repositoryId: REPO_A, conversationId: chatId(2), imageId: second.id },
      ]);
      expect(log().querySelectorAll("img.agentChatImagePicture")).toHaveLength(2);
    } finally {
      delete urlApi.createObjectURL;
      delete urlApi.revokeObjectURL;
    }
  });
});

describe("search", () => {
  const seedSearchable = () => chat.seed(REPO_A,
    conversationOf(1, [{ ...userMessage("Add a retry to the upload client"), at: minute(0) }, { ...agentMessage("A retry needs backoff."), at: minute(1) }]),
    conversationOf(2, [{ ...userMessage("What about the rollback?"), at: minute(5) }, { ...agentMessage("Roll back with the button, and Retry the step."), at: minute(6) }]));

  it("opens under the header with the field focused, a pressed action, and one quiet line before anything is typed", async () => {
    seedSearchable();
    const person = await openPanel();
    expect(searchButton()).toHaveClass("commandIconAction");
    expect(searchButton()).toHaveAttribute("aria-pressed", "false");
    await person.click(searchButton());
    expect(searchButton()).toHaveAttribute("aria-pressed", "true");
    const region = screen.getByRole("search", { name: "Search the conversation" });
    expect(region).toHaveClass("agentChatSearch");
    expect(searchButton()).toHaveAttribute("aria-controls", region.id);
    expect(searchField()).toHaveFocus();
    expect(searchField()).toHaveAttribute("placeholder", "Search messages…");
    expect(searchField()).toHaveAttribute("maxlength", String(SEARCH_QUERY_LIMIT));
    expect(within(region).getByText("Search the messages of this repository.")).toBeInTheDocument();
    expect(panel().querySelector("header")!.nextElementSibling).toBe(region);
    // Nothing is asked for a field that holds nothing, or only spaces.
    await person.type(searchField(), "   ");
    await settle(SEARCH_DELAY_MS * 2);
    expect(chat.calls("search")).toEqual([]);
  });

  it("asks once after the owner stops typing, and lists the matches newest first with who wrote them, their time, and the text emphasized", async () => {
    seedSearchable();
    const person = await openPanel();
    await person.click(searchButton());
    await person.type(searchField(), "retry");
    expect(chat.calls("search")).toEqual([]);
    await settle(SEARCH_DELAY_MS + 50);
    expect(chat.calls("search")).toEqual([{ repositoryId: REPO_A, query: "retry" }]);
    const list = within(screen.getByRole("search")).getByRole("list", { name: "Matching messages" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].querySelector(".agentChatSearchWho")).toHaveTextContent("Aril");
    expect(rows[0]).toHaveTextContent("Roll back with the button, and Retry the step.");
    expect([...rows[0].querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["Retry"]);
    expect(rows[1].querySelector(".agentChatSearchWho")).toHaveTextContent("Aril");
    expect(rows[2].querySelector(".agentChatSearchWho")).toHaveTextContent("You");
    expect(rows[2].querySelector("time")).toHaveAttribute("datetime", minute(0));
    for (const row of rows) expect(within(row).getByRole("button")).toHaveClass("agentChatSearchResult");
    expect(within(screen.getByRole("search")).queryByText("Search the messages of this repository.")).toBeNull();
  });

  it("says in one quiet line that nothing matches, and that the desktop did not answer", async () => {
    seedSearchable();
    const person = await openPanel();
    await person.click(searchButton());
    await person.type(searchField(), "zebra");
    await settle(SEARCH_DELAY_MS + 50);
    expect(within(screen.getByRole("search")).getByText("No messages match.")).toBeInTheDocument();
    expect(screen.getByRole("search").querySelector("ul")).toBeNull();
    const original = chat.agentChat.getMockImplementation()!;
    chat.agentChat.mockImplementation(async (operation, payload) => (operation === "search" ? { ok: false, error: "unavailable" } : original(operation, payload)));
    await person.type(searchField(), "s");
    await settle(SEARCH_DELAY_MS + 50);
    expect(within(screen.getByRole("search")).getByText("Search could not be reached. Try again.")).toBeInTheDocument();
  });

  it("brings the chosen message into view, closes the search, and returns focus to Search", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      chat.pageSize = 2;
      seedSearchable();
      const person = await openPanel();
      expect(textsOf()).toEqual(["What about the rollback?", "Roll back with the button, and Retry the step."]);
      await person.click(searchButton());
      await person.type(searchField(), "backoff");
      await settle(SEARCH_DELAY_MS + 50);
      await person.click(within(screen.getByRole("search")).getByRole("button", { name: /backoff/ }));
      await settle();
      expect(screen.queryByRole("search")).toBeNull();
      expect(searchButton()).toHaveFocus();
      expect(searchButton()).toHaveAttribute("aria-pressed", "false");
      const line = within(log()).getByText("A retry needs backoff.").closest("article")!;
      expect(line).toHaveAttribute("data-conversation-id", chatId(1));
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(line);
      expect(line).toHaveClass("isMarked");
      await settle(2_100);
      expect(line).not.toHaveClass("isMarked");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("closes on Escape, with the field emptied and focus on Search, and leaves the panel open", async () => {
    seedSearchable();
    const person = await openPanel();
    await person.click(searchButton());
    await person.type(searchField(), "retry");
    await settle(SEARCH_DELAY_MS + 50);
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(panel()).toBeInTheDocument();
    expect(searchButton()).toHaveFocus();
    await person.click(searchButton());
    expect(searchField()).toHaveValue("");
    // Escape from the matches closes the search too.
    await person.type(searchField(), "retry");
    await settle(SEARCH_DELAY_MS + 50);
    within(screen.getByRole("search")).getAllByRole("button")[0].focus();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("search")).toBeNull();
    expect(panel()).toBeInTheDocument();
    // With the search closed, the next Escape closes the panel.
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });

  it("closes on a second press of Search and when a message is sent, and asks nothing when closed", async () => {
    seedSearchable();
    const person = await openPanel();
    await person.click(searchButton());
    await person.click(searchButton());
    expect(screen.queryByRole("search")).toBeNull();
    await person.click(searchButton());
    await person.type(field(), "A question{Enter}");
    await settle();
    expect(screen.queryByRole("search")).toBeNull();
    expect(chat.calls("search")).toEqual([]);
  });

  it("is a control of the panel for the repository in view, and not drawn where there is no repository", async () => {
    harness.inventory = { snapshot: { revision: 1, readiness: "ready", repositories: [] }, loading: false, connected: true, refresh: vi.fn(async () => {}) };
    await openPanel();
    expect(searchButton()).toBeDisabled();
  });
});

describe("the thread in memory", () => {
  const message = (conversationId: string, id: string): AgentChatThreadMessage => ({ conversationId, id, role: "user", text: id, at: AT });
  const loaded = (...keys: [string, string][]): LoadedThread => ({ messages: keys.map(([conversation, id]) => message(chatId(conversation === "a" ? 1 : 2), id)), before: "older" });

  it("replaces what is loaded with a first page, and with a page that touches nothing loaded", () => {
    const page = { messages: [message(chatId(1), "m-9")], before: "next" };
    expect(mergeNewest({ messages: [], before: null }, page)).toEqual(page);
    expect(mergeNewest(loaded(["a", "m-1"], ["a", "m-2"]), page)).toEqual(page);
    expect(mergeNewest(loaded(["a", "m-1"]), { messages: [], before: null })).toEqual({ messages: [], before: null });
  });

  it("keeps the older messages that were loaded and the cursor beyond them when the newest page moved on", () => {
    const before = loaded(["a", "m-1"], ["a", "m-2"], ["a", "m-3"], ["a", "m-4"]);
    const page = { messages: [message(chatId(1), "m-3"), message(chatId(1), "m-4"), message(chatId(2), "m-1")], before: "from the page" };
    const merged = mergeNewest(before, page);
    expect(merged.messages.map(threadMessageKey)).toEqual([`${chatId(1)}/m-1`, `${chatId(1)}/m-2`, `${chatId(1)}/m-3`, `${chatId(1)}/m-4`, `${chatId(2)}/m-1`]);
    expect(merged.before).toBe("older");
  });

  it("takes a changed message from the page, and the same message of another conversation is another message", () => {
    const stale = { ...message(chatId(1), "m-2"), text: "before" };
    const page = { messages: [{ ...message(chatId(1), "m-2"), text: "after" }, message(chatId(2), "m-2")], before: null };
    const merged = mergeNewest({ messages: [message(chatId(1), "m-1"), stale], before: "older" }, page);
    expect(merged.messages.map((entry) => entry.text)).toEqual(["m-1", "after", "m-2"]);
    expect(threadMessageKey(message(chatId(1), "m-2"))).not.toBe(threadMessageKey(message(chatId(2), "m-2")));
  });

  it("splits an excerpt around the searched text whatever its case, and leaves one without it whole", () => {
    expect(splitMatch("Retry the step", "retry")).toEqual({ before: "", match: "Retry", after: " the step" });
    expect(splitMatch("…a RETRY needs backoff…", " Retry ")).toEqual({ before: "…a ", match: "RETRY", after: " needs backoff…" });
    expect(splitMatch("Nothing here", "retry")).toBeNull();
    expect(splitMatch("Nothing here", "   ")).toBeNull();
  });

  it("agrees with the desktop on the bounds of a page, a search, a query, and a cursor", () => {
    expect(AGENT_CHAT_BOUNDS.threadPage).toBe(THREAD_PAGE);
    expect(AGENT_CHAT_BOUNDS.searchMatches).toBe(SEARCH_LIMIT);
    expect(AGENT_CHAT_BOUNDS.searchQueryLength).toBe(SEARCH_QUERY_LIMIT);
    expect(AGENT_CHAT_BOUNDS.cursorLength).toBe(200);
    expect(AGENT_CHAT_BOUNDS.listedConversations).toBe(LIST_LIMIT);
    // A repository has no limit of conversations: the contract names none.
    expect(Object.keys(AGENT_CHAT_BOUNDS)).not.toContain("conversationsPerRepository");
  });
});

describe("a conversation boundary", () => {
  it("draws nothing at the boundary and keeps the time order of messages that interleave", async () => {
    chat.seed(REPO_A,
      conversationOf(1, [{ ...userMessage("a1"), at: minute(0) }, { ...agentMessage("a2"), at: minute(4) }]),
      conversationOf(2, [{ ...userMessage("b1"), at: minute(1) }, { ...agentMessage("b2"), at: minute(3) }]));
    await openPanel();
    expect(textsOf()).toEqual(["a1", "b1", "b2", "a2"]);
    expect(log().querySelectorAll("hr, [role='separator']")).toHaveLength(0);
  });
});
