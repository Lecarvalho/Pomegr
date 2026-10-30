import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, installHarness, newUser, removeHarness, settle, harness, setBridge } from "./agent-chat-fixture";

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
  setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage, arilControl: control });
});
afterEach(() => { removeHarness(); });

const launcher = () => screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ });
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const header = () => panel().querySelector("header") as HTMLElement;

describe("the state of Aril beside its name", () => {
  it("reads On or Off in the panel header once the desktop has answered, and asks nothing while the panel is closed", async () => {
    render(<AgentChatDock />);
    await settle();
    expect(control).not.toHaveBeenCalled();
    const person = newUser();
    await person.click(launcher());
    await settle();
    expect(within(header()).getByText("On")).toHaveClass("commandChip", "positive", "agentChatState");
    expect(within(header()).queryByText("Off")).toBeNull();
    await person.click(within(header()).getByRole("button", { name: "Close Aril" }));
    await settle();
    const closedReads = reads;
    await settle(20_000);
    expect(reads).toBe(closedReads);
  });

  it("reads Off as a neutral chip, with no tone", async () => {
    state = { on: false, pairedOn: false };
    render(<AgentChatDock />);
    await newUser().click(launcher());
    await settle();
    const chip = within(header()).getByText("Off");
    expect(chip).toHaveClass("commandChip", "agentChatState");
    expect(chip).not.toHaveClass("positive");
  });

  it("draws nothing for a state it does not know yet, and a switch turned elsewhere reaches the open panel on the next ask", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    control.mockImplementationOnce(async () => { await gate; return { ok: true, ...state }; });
    render(<AgentChatDock />);
    await newUser().click(launcher());
    await settle();
    expect(within(header()).queryByText("On")).toBeNull();
    expect(within(header()).queryByText("Off")).toBeNull();
    release();
    await settle();
    expect(within(header()).getByText("On")).toBeInTheDocument();
    state = { on: false, pairedOn: false };
    await settle(5_000);
    expect(within(header()).getByText("Off")).toBeInTheDocument();
    expect(within(header()).queryByText("On")).toBeNull();
  });

  it("draws nothing when the desktop gives no control, as an older desktop does", async () => {
    setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage });
    render(<AgentChatDock />);
    await newUser().click(launcher());
    await settle();
    expect(within(header()).queryByText("On")).toBeNull();
    expect(within(header()).queryByText("Off")).toBeNull();
  });

  it("asks a paired phone through the paired route, and a phone that cannot be answered draws nothing", async () => {
    setBridge(undefined);
    harness.mode = "lan";
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { operation: string; payload: Record<string, unknown> };
      calls.push(body.operation);
      const answer = body.operation === "aril_switch" ? { ok: true, on: false, pairedOn: true } : await chat.agentChat(body.operation as never, body.payload);
      return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
    }));
    render(<AgentChatDock />);
    await newUser().click(launcher());
    await settle();
    expect(calls).toContain("aril_switch");
    expect(within(header()).getByText("Off")).toBeInTheDocument();
  });
});
