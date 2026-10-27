import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, agentMessage, chatId, conversationOf, harness, installHarness, removeHarness, setInventory, settle, userMessage } from "./agent-chat-fixture";

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
import { agentChatLink, openAgentChatLink } from "../../app/components/agent-chat/agent-chat-presentation";

// Grant follow-ups in the chat panel (T-183): a notification's link opens its repository's chat at the follow-up.
let chat: FakeChat;
const followUpText = "Merged T-5, deleted the branch of T-5, and started T-6. Nothing needs you yet.";
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });

beforeEach(() => {
  chat = installHarness();
  setInventory([[REPO_A, "pomegr"], [REPO_B, "other"]]);
  chat.seed(REPO_B, conversationOf(1, [agentMessage(followUpText, { grantFollowUp: true }, "m-1")], { title: "Grant follow-ups" }),
    conversationOf(2, [userMessage("Newer question"), agentMessage("Newer answer")]));
  chat.seed(REPO_A, conversationOf(3, [userMessage("Repository A question"), agentMessage("Repository A answer")]));
});
afterEach(() => { removeHarness(); window.history.replaceState(null, "", "/"); });

describe("a follow-up's link", () => {
  it("parses only the Tasks page of a repository with an exact conversation and message", () => {
    expect(agentChatLink("/tasks", `?repository=${REPO_B}&aril=${chatId(1)}&message=m-1`)).toEqual({ repositoryId: REPO_B, conversationId: chatId(1), messageId: "m-1" });
    expect(agentChatLink("/tasks", `?repository=${REPO_B}&aril=open`)).toEqual({ repositoryId: REPO_B, conversationId: null, messageId: null });
    for (const [pathname, search] of [["/sessions", `?repository=${REPO_B}&aril=open`], ["/tasks", `?repository=${REPO_B}`], ["/tasks", `?repository=repo-x&aril=open`],
      ["/tasks", `?repository=${REPO_B}&aril=${chatId(1)}`], ["/tasks", `?repository=${REPO_B}&aril=open&message=m-1`], ["/tasks", `?repository=${REPO_B}&aril=chat-x&message=m-1`]]) {
      expect(agentChatLink(pathname, search)).toBeNull();
    }
  });

  it("opens the panel on the page it loads, in the follow-up's own repository and conversation, drawn as Aril's grant follow-up", async () => {
    harness.pathname = "/tasks";
    window.history.replaceState(null, "", `/tasks?repository=${REPO_B}&aril=${chatId(1)}&message=m-1`);
    render(<AgentChatDock />);
    await settle();
    expect(panel()).toBeVisible();
    expect(chat.calls("read").at(-1)).toEqual({ repositoryId: REPO_B, conversationId: chatId(1) });
    const message = within(log()).getByText(followUpText).closest("article")!;
    expect(message).toHaveAccessibleName("Aril");
    expect(message).toHaveAttribute("data-message-id", "m-1");
    expect(within(message).getByText("Grant follow-up")).toBeInTheDocument();
    expect(within(log()).queryByRole("button", { name: "Apply" })).toBeNull();
  });

  it("opens the chat from inside the app, as a tray click does, and never in another repository", async () => {
    render(<AgentChatDock />);
    await settle();
    expect(screen.queryByRole("log")).toBeNull();
    act(() => openAgentChatLink(`/tasks?repository=${REPO_B}&aril=${chatId(1)}&message=m-1`));
    await settle();
    expect(chat.calls("read").at(-1)).toEqual({ repositoryId: REPO_B, conversationId: chatId(1) });
    expect(within(log()).getByText(followUpText)).toBeInTheDocument();
    expect(within(log()).queryByText("Repository A answer")).toBeNull();
    act(() => openAgentChatLink("/tasks?repository=repo-unknown&aril=open"));
    await settle();
    expect(chat.calls("read").at(-1)).toEqual({ repositoryId: REPO_B, conversationId: chatId(1) });
  });
});
