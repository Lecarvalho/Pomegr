import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, agentMessage, conversationOf, harness, installHarness, newUser, removeHarness, setBridge, settle, userMessage } from "./agent-chat-fixture";

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

import { WARM_DEBOUNCE_MS } from "../../app/agent-chat-client";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";

// The message field asks the desktop to keep a provider run ready when it gains focus, once for a burst of focus events. The request
// carries the run the composer shows and no text; closing the panel asks for nothing.
let chat: FakeChat;
const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const field = () => screen.getByRole("textbox", { name: "Message Aril" });

beforeEach(() => {
  chat = installHarness();
  chat.seed(REPO_A, conversationOf(1, [userMessage("First question"), agentMessage("First answer", { model: "model-large", effort: "high" })], { model: "model-large", effort: "high" }));
});
afterEach(() => { removeHarness(); });

const after = (milliseconds: number) => act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });

async function openPanel() {
  const person = newUser();
  render(<AgentChatDock />);
  await person.click(launcher());
  await settle();
  return person;
}

describe("asking the desktop to warm a run", () => {
  it("is asked once after the pause when the panel opens and focuses the field, with the run the composer shows and nothing else", async () => {
    await openPanel();
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm")).toEqual([{ repositoryId: REPO_A, provider: "claude", model: "model-large", effort: "high" }]);
    // No message, no draft, no conversation: the keys are the repository and the run.
    expect(Object.keys(chat.calls("warm")[0] as object).sort()).toEqual(["effort", "model", "provider", "repositoryId"]);
    expect(chat.calls("send")).toEqual([]);
  });

  it("is asked once for a burst of focus events, and again for the next focus after the pause", async () => {
    const person = await openPanel();
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm")).toHaveLength(1);
    for (let burst = 0; burst < 3; burst += 1) {
      await act(async () => { field().blur(); });
      await act(async () => { field().focus(); });
      await after(WARM_DEBOUNCE_MS / 5);
    }
    expect(chat.calls("warm")).toHaveLength(1);
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm")).toHaveLength(2);
    // A focus that is lost before the pause ends asks for nothing.
    await act(async () => { field().blur(); });
    await act(async () => { field().focus(); });
    await act(async () => { field().blur(); });
    await after(WARM_DEBOUNCE_MS * 2);
    expect(chat.calls("warm")).toHaveLength(2);
    // The next focus is another request.
    await person.click(field());
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm")).toHaveLength(3);
  });

  it("names the run the owner chose when the owner changed it before focusing the field again", async () => {
    const person = await openPanel();
    await after(WARM_DEBOUNCE_MS);
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "Low" }));
    field().blur();
    await person.click(field());
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm").at(-1)).toEqual({ repositoryId: REPO_A, provider: "claude", model: "model-large", effort: "low" });
  });

  it("is not asked by typing, sending, or the panel closing, and closing the panel asks the desktop nothing at all", async () => {
    const person = await openPanel();
    await after(WARM_DEBOUNCE_MS);
    const asked = chat.agentChat.mock.calls.length;
    const warmed = chat.calls("warm").length;
    await person.keyboard("hello");
    await person.click(screen.getByRole("button", { name: "Close Aril" }));
    await settle(WARM_DEBOUNCE_MS * 2);
    // Closing the panel is no request to the desktop: nothing can close the waiting run but the desktop's idle clock.
    for (const operation of ["stop", "delete", "send", "apply", "dismiss"]) expect(chat.calls(operation)).toEqual([]);
    expect(chat.calls("warm")).toHaveLength(warmed);
    expect(chat.agentChat.mock.calls.length).toBe(asked);
  });

  it("is dropped with the panel body when the repository's chat leaves before the pause ends", async () => {
    const { unmount } = render(<AgentChatDock />);
    await newUser().click(launcher());
    await settle();
    unmount();
    await after(WARM_DEBOUNCE_MS * 2);
    expect(chat.calls("warm")).toEqual([]);
  });

  it("is asked through the paired-device route on a phone, as every operation is", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      return new Response(JSON.stringify(await chat.agentChat(body.operation, body.payload)), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    await openPanel();
    await after(WARM_DEBOUNCE_MS);
    expect(chat.calls("warm")).toHaveLength(1);
    const warmRequest = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { operation: string }).find((body) => body.operation === "warm");
    expect(warmRequest).toBeDefined();
  });
});
