import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, installHarness, newUser, removeHarness, settle, harness, setBridge, REPO_A } from "./agent-chat-fixture";
import { renderDock } from "./dock-helper";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";
import { AGENT_CHAT_OPEN_EVENT } from "../../app/components/agent-chat/agent-chat-presentation";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname, useRouter: () => ({ replace: navigation.replace }) };
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
let state: { on: boolean; pairedOn: boolean };
let reads: number;
const control = vi.fn(async (operation: string) => {
  if (operation === "aril_switch") { reads += 1; return { ok: true, ...state }; }
  return { ok: false, error: "invalid" };
});

beforeEach(() => {
  chat = installHarness();
  state = { on: true, pairedOn: false };
  reads = 0;
  control.mockClear();
  navigation.replace.mockClear();
  setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage, arilControl: control });
});
afterEach(() => { removeHarness(); });

const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const anyLauncher = () => screen.queryByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panelOrNull = () => screen.queryByRole("region", { name: "Aril, the Pomegr agent" });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
// The closed panel is hidden, so a query by role does not see it.
const panelFrame = () => document.querySelector(".agentChatPanel") as HTMLElement;
const header = () => panel().querySelector("header") as HTMLElement;
/** Nothing of Aril is on the screen: no launcher, no panel (open or closed), no scrim, and no expanded page. */
const nothing = () => {
  expect(anyLauncher()).toBeNull();
  expect(panelOrNull()).toBeNull();
  expect(document.querySelector(".agentChatDock")).toBeNull();
  expect(document.querySelector(".agentChatScrim")).toBeNull();
};

describe("the dock follows the switch", () => {
  it("draws the launcher once the desktop has said that Aril is On, and the open panel names the state beside its name", async () => {
    await renderDock();
    expect(launcher()).toBeInTheDocument();
    const person = newUser();
    await person.click(launcher());
    await settle();
    expect(within(header()).getByText("On")).toHaveClass("commandChip", "positive", "agentChatState");
    expect(within(header()).queryByText("Off")).toBeNull();
  });

  it("draws nothing at all while Aril is Off: no launcher, no panel, no scrim, and no expanded page", async () => {
    state = { on: false, pairedOn: false };
    const { container } = await renderDock();
    nothing();
    expect(container).toBeEmptyDOMElement();
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("draws nothing for a state it does not know yet, and never shows the chat and then takes it back", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    state = { on: false, pairedOn: false };
    control.mockImplementationOnce(async () => { await gate; return { ok: true, ...state }; });
    const seen: boolean[] = [];
    const watcher = new MutationObserver(() => { seen.push(document.querySelector(".agentChatDock") !== null); });
    const { container } = render(<AgentChatDock />);
    watcher.observe(document.body, { childList: true, subtree: true });
    await settle();
    expect(container).toBeEmptyDOMElement();
    release();
    await settle();
    expect(container).toBeEmptyDOMElement();
    watcher.disconnect();
    expect(seen.some(Boolean)).toBe(false);
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("draws nothing when the desktop gives no control, as an older desktop does, or cannot answer", async () => {
    setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage });
    const { unmount } = await renderDock();
    nothing();
    unmount();
    setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage, arilControl: vi.fn(async () => ({ ok: false, error: "unavailable" })) });
    await renderDock();
    await settle(5_000);
    nothing();
  });

  it("closes an open panel when Aril turns Off, with its draft, and draws the launcher again, closed, when it is turned On", async () => {
    const person = newUser();
    await renderDock();
    await person.click(launcher());
    await settle();
    await person.type(screen.getByRole("textbox", { name: "Message Aril" }), "a draft that goes with the panel");
    expect(panel()).not.toHaveAttribute("hidden");
    state = { on: false, pairedOn: false };
    await settle(5_000);
    nothing();
    state = { on: true, pairedOn: false };
    await settle(5_000);
    expect(anyLauncher()).not.toBeNull();
    expect(panelFrame()).toHaveAttribute("hidden");
    await person.click(launcher());
    await settle();
    expect(screen.getByRole("textbox", { name: "Message Aril" })).toHaveValue("");
  });

  it("asks every five seconds for as long as it is mounted, and keeps what it knew when one ask fails", async () => {
    await renderDock();
    expect(reads).toBe(1);
    await settle(5_000);
    expect(reads).toBe(2);
    control.mockImplementationOnce(async () => ({ ok: false, error: "unavailable" }));
    await settle(5_000);
    expect(anyLauncher()).not.toBeNull();
    await settle(5_000);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(anyLauncher()).not.toBeNull();
  });

  it("asks a paired phone through the paired route, and draws nothing there while Aril is Off", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    state = { on: false, pairedOn: true };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      calls.push(body.operation);
      const answer = body.operation === "aril_switch" ? { ok: true, ...state } : await chat.agentChat(body.operation, body.payload);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }));
    await renderDock();
    expect(calls).toContain("aril_switch");
    nothing();
    // Turned On from the desktop, the phone draws the chat on its next ask; turned Off again, the phone takes it away.
    state = { on: true, pairedOn: true };
    await settle(5_000);
    expect(anyLauncher()).not.toBeNull();
    state = { on: false, pairedOn: true };
    await settle(5_000);
    nothing();
  });

  it("a phone that cannot be answered draws nothing", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await renderDock();
    await settle(5_000);
    nothing();
  });
});

describe("a link to the chat while Aril is Off", () => {
  const link = `/tasks?repository=${REPO_A}&aril=open`;

  it("lands on Home when the page loaded with it", async () => {
    state = { on: false, pairedOn: false };
    window.history.replaceState(null, "", link);
    harness.pathname = "/tasks";
    await renderDock();
    expect(navigation.replace).toHaveBeenCalledWith("/");
    nothing();
  });

  it("lands on Home when a link inside the app asks for the chat, and a page that never asked for it never moves", async () => {
    state = { on: false, pairedOn: false };
    await renderDock();
    expect(navigation.replace).not.toHaveBeenCalled();
    act(() => { window.dispatchEvent(new CustomEvent(AGENT_CHAT_OPEN_EVENT, { detail: { repositoryId: REPO_A, conversationId: null, messageId: null } })); });
    await settle();
    expect(navigation.replace).toHaveBeenCalledWith("/");
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    nothing();
  });

  it("opens the chat as it always did when Aril is On, and does not move", async () => {
    window.history.replaceState(null, "", link);
    harness.pathname = "/tasks";
    await renderDock();
    await settle();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(panel()).not.toHaveAttribute("hidden");
  });

  it("waits for the switch to be known before it moves: an On Aril keeps the page", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    control.mockImplementationOnce(async () => { await gate; return { ok: true, ...state }; });
    window.history.replaceState(null, "", link);
    harness.pathname = "/tasks";
    render(<AgentChatDock />);
    await settle();
    expect(navigation.replace).not.toHaveBeenCalled();
    release();
    await settle();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(panel()).not.toHaveAttribute("hidden");
  });
});
