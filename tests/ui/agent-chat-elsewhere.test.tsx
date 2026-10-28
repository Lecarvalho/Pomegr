import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, agentMessage, chatId, conversationOf, harness, installHarness, newUser, removeHarness, setBridge, settle, userMessage } from "./agent-chat-fixture";

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
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
/** The slow pace at which an open, idle panel asks the list again. */
const IDLE = 5_000;

async function openPanel(person = user()) {
  await person.click(launcher());
  await settle();
  return person;
}

/** Drives the chat through the paired-device route, as a phone does, instead of the desktop bridge. */
function pairDevice() {
  setBridge(undefined);
  harness.mode = "lan";
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
    return new Response(JSON.stringify(await chat.agentChat(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A message sent to the open conversation from another device shows as this panel's own: the turn, then both stored messages. */
async function followsTurnStartedElsewhere(person: ReturnType<typeof user>) {
  render(<AgentChatDock />);
  await openPanel(person);
  expect(within(log()).getByText("First answer")).toBeInTheDocument();
  await chat.sendElsewhere(REPO_A, chatId(1), "Sent from the phone");
  chat.write("Working on it from afar", "writing");
  await settle(IDLE);
  expect(within(log()).getByText("Sent from the phone")).toBeInTheDocument();
  expect(within(log()).getByText("Working on it from afar")).toBeInTheDocument();
  expect(within(log()).getByRole("status")).toHaveTextContent("Writing…");
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  chat.finish("Answered for the phone");
  await settle(1_000);
  expect(within(log()).getByText("Answered for the phone")).toBeInTheDocument();
  expect(within(log()).queryByRole("status")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

  // A whole turn that ends between two asks is read again from the newer stored conversation.
  await chat.sendElsewhere(REPO_A, chatId(1), "A quick one from the phone");
  chat.finish("A quick answer");
  await settle(IDLE);
  expect(within(log()).getByText("A quick one from the phone")).toBeInTheDocument();
  expect(within(log()).getByText("A quick answer")).toBeInTheDocument();
}

describe("a turn started from another device", () => {
  beforeEach(() => { chat.seed(REPO_A, conversationOf(1, [userMessage("First question"), agentMessage("First answer")])); });

  it("reaches an open, idle panel on the desktop without reopening it", async () => {
    await followsTurnStartedElsewhere(user());
    // The panel stayed mounted: it listed once on opening and then only at the idle pace.
    expect(chat.calls("list").length).toBeGreaterThan(1);
  });

  it("reaches an open, idle panel on a paired device through the paired-device route", async () => {
    const fetchMock = pairDevice();
    await followsTurnStartedElsewhere(user());
    expect(fetchMock.mock.calls.every(([url]) => url === "/api/agent-chat")).toBe(true);
    expect(chat.agentChat.mock.calls.length).toBe(fetchMock.mock.calls.length);
  });

  it("shows a new conversation started elsewhere in the list, and keeps Send busy while it is answered", async () => {
    const person = user();
    render(<AgentChatDock />);
    await openPanel(person);
    await chat.sendElsewhere(REPO_A, null, "A new topic from the phone");
    await settle(IDLE);
    expect(screen.getByText("Aril is answering in another conversation.")).toBeInTheDocument();
    await person.click(screen.getByRole("button", { name: "Conversations" }));
    expect(screen.getByRole("button", { name: /^A new topic from the phone/ })).toBeInTheDocument();
  });

  it("asks nothing while the panel is closed and idle, so the launcher learns nothing of it", async () => {
    for (const paired of [false, true]) {
      const fetchMock = paired ? pairDevice() : null;
      const sent = `Sent while closed${paired ? " on a paired device" : ""}`;
      const person = user();
      const { unmount } = render(<AgentChatDock />);
      await openPanel(person);
      await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
      const before = chat.agentChat.mock.calls.length;
      const fetched = fetchMock?.mock.calls.length ?? 0;
      await chat.sendElsewhere(REPO_A, chatId(1), sent);
      await settle(IDLE * 3);
      expect(chat.agentChat.mock.calls.length).toBe(before);
      expect(fetchMock?.mock.calls.length ?? 0).toBe(fetched);
      expect(launcher()).toHaveAccessibleName("Open Aril, the Pomegr agent");
      // Opening the panel again reads the turn.
      await person.click(launcher());
      await settle();
      expect(within(log()).getByText(sent)).toBeInTheDocument();
      chat.finish("Done");
      unmount();
    }
  });
});
