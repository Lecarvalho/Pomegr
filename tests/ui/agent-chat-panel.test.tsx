import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AT, FakeChat, REPO_A, REPO_B, agentMessage, conversationOf, harness, installHarness, newUser, removeHarness, setInventory, settle, userMessage } from "./agent-chat-fixture";

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

// The docked panel, its header, the composer, and the time of every message.
let chat: FakeChat;

beforeEach(() => { chat = installHarness(); });
afterEach(() => { removeHarness(); });

const user = newUser;
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const composer = () => field().closest("form") as HTMLFormElement;
const scrim = () => document.querySelector<HTMLElement>(".agentChatScrim");

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

/** A moment of today in local time, as an ISO string. */
function today(hour: number, minute: number) {
  const moment = new Date();
  moment.setHours(hour, minute, 0, 0);
  return moment.toISOString();
}

describe("the docked panel", () => {
  it("expands and docks again with the one header action, which is named and pressed by the mode", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(panel()).not.toHaveClass("isExpanded");

    const expand = within(panel()).getByRole("button", { name: "Expand" });
    expect(expand).toHaveAttribute("aria-pressed", "false");
    await person.click(expand);
    const dock = within(panel()).getByRole("button", { name: "Dock" });
    expect(dock).toHaveAttribute("aria-pressed", "true");
    expect(within(panel()).queryByRole("button", { name: "Expand" })).toBeNull();
    expect(panel()).toHaveClass("isExpanded");

    await person.click(dock);
    expect(within(panel()).getByRole("button", { name: "Expand" })).toHaveAttribute("aria-pressed", "false");
    expect(panel()).not.toHaveClass("isExpanded");

    // The mode is kept while the panel is closed, and nothing marks the document root: the page does not move.
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    await person.click(launcher());
    expect(panel()).toHaveClass("isExpanded");
    expect(document.documentElement.hasAttribute("data-aril-panel")).toBe(false);
  });

  it("keeps the draft and the focus on the Expand action while the mode changes, and never takes focus", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.type(field(), "A draft");
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    expect(within(panel()).getByRole("button", { name: "Dock" })).toHaveFocus();
    expect(field()).toHaveValue("A draft");
  });

  it("has the Aril glyph and name, three actions, and no caption, no Minimize, and no repository row", async () => {
    setInventory([[REPO_A, "pomegr"], [REPO_B, "catalogus"]]);
    render(<AgentChatDock />);
    await openPanel();
    const header = panel().querySelector("header")!;
    expect(within(header).getByRole("heading", { level: 2, name: "Aril" })).toBeInTheDocument();
    expect(header.querySelector(".agentChatGlyph")).not.toBeNull();
    expect([...header.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual(["Search", "Expand", "Close Aril"]);
    expect(header.textContent).not.toMatch(/Task-board agent/);
    expect(within(panel()).queryByRole("button", { name: "Minimize" })).toBeNull();
    expect(header.querySelector("[role='combobox']")).toBeNull();
    expect(header.querySelector(".agentChatRepository")).toBeNull();
    expect(composer().querySelector(".agentChatRepository")).not.toBeNull();
  });

  it("returns focus to the launcher when Close is pressed, whatever the mode", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("the scrim", () => {
  it("dims the page only while the panel is open, in either mode", async () => {
    const person = user();
    render(<AgentChatDock />);
    expect(scrim()).toBeNull();
    await openPanel(person);
    expect(scrim()).not.toBeNull();
    expect(document.querySelectorAll(".agentChatScrim")).toHaveLength(1);
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    expect(document.querySelectorAll(".agentChatScrim")).toHaveLength(1);
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    expect(scrim()).toBeNull();
  });

  it("is a pointer affordance only: out of the tab order and hidden from assistive technology", async () => {
    render(<AgentChatDock />);
    await openPanel();
    expect(scrim()).toHaveAttribute("tabindex", "-1");
    expect(scrim()).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("button", { name: "Close Aril" })).toHaveLength(1);
  });

  it("closes the panel on a click exactly as Close does, and returns focus to the launcher with the draft kept", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.type(field(), "A draft");
    await person.click(scrim()!);
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(scrim()).toBeNull();
    expect(launcher()).toHaveFocus();
    expect(launcher()).toHaveAttribute("aria-expanded", "false");
    await person.click(launcher());
    expect(field()).toHaveValue("A draft");
  });

  it("closes an expanded panel too", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    await person.click(scrim()!);
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
    expect(launcher()).toHaveFocus();
  });
});

describe("the composer", () => {
  it("holds the repository choice only when more than one repository is listed, right after Attach, before the model", async () => {
    setInventory([[REPO_A, "pomegr"], [REPO_B, "catalogus"]]);
    render(<AgentChatDock />);
    await openPanel();
    const repository = within(composer()).getByRole("combobox", { name: "Repository" });
    expect(repository).toHaveTextContent("pomegr");
    const attach = within(composer()).getByRole("button", { name: "Attach image" });
    const model = within(composer()).getByRole("combobox", { name: "Model" });
    const effort = within(composer()).getByRole("combobox", { name: "Effort" });
    const send = within(composer()).getByRole("button", { name: "Send" });
    const before = (left: Element, right: Element) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(attach, repository)).toBe(true);
    expect(before(repository, model)).toBe(true);
    expect(before(model, effort)).toBe(true);
    expect(before(effort, send)).toBe(true);
    expect(screen.getAllByRole("combobox", { name: "Repository" })).toHaveLength(1);
  });

  it("draws no repository choice for one repository", async () => {
    render(<AgentChatDock />);
    await openPanel();
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
    expect(within(composer()).getByRole("combobox", { name: "Model" })).toBeInTheDocument();
    expect(within(composer()).queryByRole("combobox", { name: "Run on" })).toBeNull();
  });

  it("keeps working with no repository: a disabled field and Send, and no repository choice", async () => {
    setInventory([]);
    render(<AgentChatDock />);
    await openPanel();
    expect(field()).toBeDisabled();
    expect(within(composer()).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.queryByRole("combobox", { name: "Repository" })).toBeNull();
  });

  it("asks \"Ask Aril…\", and draws a round Send with an arrow that becomes a round Stop with a square while an answer is written", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(field()).toHaveAttribute("placeholder", "Ask Aril…");
    const send = within(composer()).getByRole("button", { name: "Send" });
    expect(send).toHaveAttribute("type", "submit");
    expect(send).toHaveClass("commandIconAction", "agentChatSend");
    expect(send.querySelector("path")).not.toBeNull();
    expect(send.querySelector("rect")).toBeNull();
    expect(send).toBeDisabled();

    await ask(person, "Cut this feature into tasks");
    chat.write("Starting on the cut", "writing");
    await settle(500);
    const stop = within(composer()).getByRole("button", { name: "Stop" });
    expect(stop).toHaveAttribute("type", "button");
    expect(stop).toHaveClass("commandIconAction", "agentChatSend");
    expect(stop.querySelector("rect")).not.toBeNull();
    expect(within(composer()).queryByRole("button", { name: "Send" })).toBeNull();

    await person.click(stop);
    await settle(500);
    expect(chat.calls("stop")).toHaveLength(1);
    expect(within(composer()).getByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});

describe("the model and the effort", () => {
  it("show the newest known Claude model and Medium, in two selects after the spacer", async () => {
    render(<AgentChatDock />);
    await openPanel();
    const model = within(composer()).getByRole("combobox", { name: "Model" });
    const effort = within(composer()).getByRole("combobox", { name: "Effort" });
    expect(model).toHaveTextContent(/^model-large$/);
    expect(effort).toHaveTextContent(/^Medium$/);
    const spacer = composer().querySelector(".agentChatSpacer")!;
    expect(spacer.compareDocumentPosition(model.parentElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(model.parentElement!.compareDocumentPosition(effort.parentElement!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(composer().textContent).not.toMatch(/default/i);
  });

  it("start on the newest known Codex model when no Claude model is known", async () => {
    harness.agents = { ...harness.agents, data: { runs: [] } };
    try {
      render(<AgentChatDock />);
      await openPanel();
      expect(within(composer()).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-code$/);
      await ask(user(), "Hello");
      expect(chat.calls("send")[0]).toMatchObject({ provider: "codex", model: "model-code", effort: "medium" });
    } finally {
      harness.agents = { data: { runs: [{ source: "Claude Code", model: "model-large" }] }, loading: false, refreshing: false, connected: true, checkedAt: null };
    }
  });

  it("read the provider's own name, never the word default, when no model is known at all", async () => {
    harness.agents = { ...harness.agents, data: { runs: [] } };
    harness.board = { ...harness.board, runModels: { codex: [] } };
    try {
      const person = user();
      render(<AgentChatDock />);
      await openPanel(person);
      const model = within(composer()).getByRole("combobox", { name: "Model" });
      expect(model).toHaveTextContent(/^Claude Code$/);
      await person.click(model);
      expect(within(screen.getByRole("listbox", { name: "Model" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["Claude Code", "Codex"]);
      await person.keyboard("{Escape}");
      await ask(person, "Hello");
      expect(chat.calls("send")[0]).toMatchObject({ provider: "claude", model: null, effort: "medium" });
    } finally {
      harness.agents = { data: { runs: [{ source: "Claude Code", model: "model-large" }] }, loading: false, refreshing: false, connected: true, checkedAt: null };
    }
  });

  it("keep the conversation's model even when the known models no longer list it", async () => {
    chat.seed(REPO_A, conversationOf(1, [userMessage("Q"), agentMessage("A", { model: "model-retired" })], { model: "model-retired", effort: "low" }));
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    expect(within(composer()).getByRole("combobox", { name: "Model" })).toHaveTextContent(/^model-retired$/);
    expect(within(composer()).getByRole("combobox", { name: "Effort" })).toHaveTextContent(/^Low$/);
    await person.click(within(composer()).getByRole("combobox", { name: "Model" }));
    expect(within(screen.getByRole("listbox", { name: "Model" })).getAllByRole("option").map((option) => option.textContent)).toEqual(["model-large, Claude Code", "model-retired, Claude Code", "model-code, Codex"]);
  });
});

describe("the time of every message", () => {
  it("shows the time of the owner's message below its bubble, and the time of Aril's answer between its name and its caption", async () => {
    const earlier = new Date(2026, 9, 11, 10, 0).toISOString();
    chat.seed(REPO_A, conversationOf(1, [
      { ...userMessage("Which task first?"), at: earlier },
      { ...agentMessage("T-3 first.", { provider: "codex", model: "model-code" }), at: today(9, 5) },
    ]));
    render(<AgentChatDock />);
    await openPanel();

    const owner = within(log()).getByRole("article", { name: "You" });
    const bubble = owner.querySelector(".agentChatBubble")!;
    expect(bubble).toHaveTextContent("Which task first?");
    const ownerTime = owner.querySelector("time")!;
    expect(ownerTime).toHaveClass("agentChatMessageTime");
    expect(ownerTime).toHaveAttribute("datetime", earlier);
    expect(ownerTime).toHaveTextContent("Oct 11, 10:00");
    expect(ownerTime).toHaveAttribute("title", "Oct 11, 2026, 10:00:00");
    expect(bubble.contains(ownerTime)).toBe(false);
    expect(bubble.compareDocumentPosition(ownerTime) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const answer = within(log()).getByRole("article", { name: "Aril" });
    const head = answer.querySelector(".agentChatMessageHead")!;
    expect([...head.children].map((child) => child.className)).toEqual(["agentChatMessageName", "agentChatMessageTime", "agentChatMessageCaption"]);
    expect(head.querySelector("time")).toHaveTextContent("09:05");
    expect(head.querySelector("time")).toHaveAttribute("datetime", today(9, 5));
    expect(head.querySelector("time")).toHaveAttribute("title", expect.stringMatching(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, 09:05:00$/));
    expect(head.querySelector(".agentChatMessageCaption")).toHaveTextContent("Codex · model-code");
  });

  it("draws no time for a message whose time cannot be read", async () => {
    chat.seed(REPO_A, conversationOf(1, [{ ...userMessage("Hello"), at: "not a time" }, { ...agentMessage("Hi"), at: "" }]));
    render(<AgentChatDock />);
    await openPanel();
    expect(log().querySelector("time")).toBeNull();
    expect(within(log()).getByText("Hello")).toBeInTheDocument();
  });

  it("shows a time for the message on its way and for the answer being written, from the time the turn started", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    let release = () => {};
    chat.hold = new Promise<void>((resolve) => { release = resolve; });
    await person.type(field(), "Is T-12 too big?");
    await person.keyboard("{Enter}");
    await settle();
    // On its way: the owner's message already shows when it was sent, and the answer's head too.
    const pendingOwner = within(log()).getByRole("article", { name: "You" });
    expect(pendingOwner.querySelector("time")).toHaveAttribute("datetime", expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
    const sentAt = pendingOwner.querySelector("time")!.getAttribute("datetime")!;
    expect(Math.abs(Date.now() - Date.parse(sentAt))).toBeLessThan(60_000);
    const starting = log().querySelector(".isWriting")!;
    expect(starting.querySelector(".agentChatMessageHead time")).toHaveAttribute("datetime", sentAt);

    release();
    await settle();
    chat.turn!.startedAt = today(9, 7);
    chat.write("Reading the board first", "reading_files");
    await settle(500);
    const writing = log().querySelector(".isWriting")!;
    expect(writing.querySelector(".agentChatMessageHead time")).toHaveTextContent("09:07");
    expect(writing.querySelector(".agentChatMessageHead time")).toHaveAttribute("datetime", today(9, 7));
    expect(within(writing as HTMLElement).getByRole("status")).toHaveTextContent("Reading repository files…");
  });
});

describe("a grant follow-up as a quiet line", () => {
  const first = "Merged T-5 and started T-6. Nothing needs you yet.";
  const second = "Could not merge T-7. T-7 needs you.";

  beforeEach(() => {
    setInventory([[REPO_A, "pomegr"], [REPO_B, "other"]]);
    chat.seed(REPO_A, conversationOf(1, [
      userMessage("Keep going"),
      agentMessage("I will.", {}, "m-2"),
      { ...agentMessage(first, { grantFollowUp: true }, "m-3"), at: today(9, 10) },
      { ...agentMessage(second, { grantFollowUp: true }, "m-4"), at: today(9, 12) },
    ], { title: "Grant follow-ups" }));
  });

  it("draws an icon, the text, and the time, muted, with no Aril head, no caption, and no card", async () => {
    render(<AgentChatDock />);
    await openPanel();
    const lines = log().querySelectorAll<HTMLElement>(".agentChatQuietLine");
    expect([...lines].map((line) => line.querySelector(".agentChatQuietText")?.textContent)).toEqual([first, second]);
    const line = lines[0];
    expect(line.tagName).toBe("ARTICLE");
    expect(line).toHaveAccessibleName("Aril");
    expect(line.querySelector("svg.commandIcon")).not.toBeNull();
    expect(line.querySelector("time")).toHaveTextContent("09:10");
    expect(line.querySelector("time")).toHaveAttribute("datetime", today(9, 10));
    expect(line.querySelector(".agentChatMessageHead, .agentChatMessageName, .agentChatMessageCaption")).toBeNull();
    expect(line).not.toHaveClass("agentChatMessage");
    expect(within(line).queryByText("Aril")).toBeNull();
    expect(within(line).queryByText("Grant follow-up")).toBeNull();
    expect(line.querySelector(".agentChatProposal")).toBeNull();
    // An ordinary answer in the same log keeps its head.
    expect(log().querySelectorAll(".agentChatMessageHead")).toHaveLength(1);
    // The follow-up is not a message of Aril to answer: Send still depends on the owner's text only.
    expect(within(composer()).getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("brings the line a notification opened into view, as the log did for the message it replaces", async () => {
    const scrolled = vi.fn();
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scrolled;
    try {
      harness.pathname = "/tasks";
      window.history.replaceState(null, "", `/tasks?repository=${REPO_A}&aril=chat-000000000001&message=m-4`);
      render(<AgentChatDock />);
      await settle();
      expect(panel()).toBeVisible();
      const line = within(log()).getByText(second).closest("article")!;
      expect(line).toHaveAttribute("data-message-id", "m-4");
      expect(scrolled).toHaveBeenCalledTimes(1);
      expect(scrolled.mock.contexts[0]).toBe(line);
    } finally {
      Element.prototype.scrollIntoView = original;
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("the stamp of a message", () => {
  it("is the instant the desktop stamped, not the instant the log was drawn", async () => {
    chat.seed(REPO_A, conversationOf(1, [{ ...userMessage("Old"), at: AT }, { ...agentMessage("Older answer"), at: AT }]));
    render(<AgentChatDock />);
    await openPanel();
    for (const time of log().querySelectorAll("time")) expect(time).toHaveAttribute("datetime", AT);
    expect(log().querySelectorAll("time")).toHaveLength(2);
  });
});
