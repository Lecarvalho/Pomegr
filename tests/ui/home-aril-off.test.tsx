import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, harness, installHarness, newUser, removeHarness, setBridge, setInventory, settle } from "./agent-chat-fixture";
import { busyHome, desktopBridge, pairPhone, resetHome } from "./home-fixture";

// Home while Aril is Off: no composer and no suggestion chips, the rest of Home as it is, nothing drawn before the switch is known, and everything
// back when Aril is On. How the composer works when it is drawn is in home-aril.test.tsx and home-focus.test.tsx.
vi.mock("next/navigation", async () => {
  const { harness } = await import("./agent-chat-fixture");
  return { usePathname: () => harness.pathname };
});
vi.mock("../../app/hooks/ClientAccessContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/hooks/ClientAccessContext")>();
  const { harness } = await import("./agent-chat-fixture");
  return { ...actual, clientAccessMode: () => harness.mode, useClientAccess: () => ({ mode: harness.mode, canCopyTranscriptPath: false, accessExpired: false, markAccessExpired() {}, async refreshAccess() {} }) };
});
vi.mock("../../app/tasks-store", async () => {
  const { harness } = await import("./agent-chat-fixture");
  const { homeHarness } = await import("./home-fixture");
  return { useTasks: () => ({ board: harness.board, refresh: harness.refresh }), useTaskBoards: (ids: string[]) => new Map(ids.map((id) => [id, homeHarness.boards.get(id) ?? { readiness: "ready", repositoryId: id, tasks: [] }])) };
});
vi.mock("../../app/tasks-home-store", async () => {
  const { homeHarness } = await import("./home-fixture");
  return { useTaskHome: () => homeHarness.taskHome };
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

import { HomeDashboard } from "../../app/HomeDashboard";
import { AgentChatDock } from "../../app/components/agent-chat/AgentChatDock";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";

let chat: FakeChat;

beforeEach(() => {
  chat = installHarness();
  harness.pathname = "/";
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  // The What's new card is shown and its dialog is not opened by itself.
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
});
afterEach(() => { removeHarness(); });

const homeField = () => document.getElementById("home-aril-message");
const page = () => document.getElementById("home-page")!;
const home = () => render(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
/** Home's column: the content block, and the composer block when it is drawn. */
const columnOf = () => page().firstElementChild as HTMLElement;
const noComposer = () => {
  expect(homeField()).toBeNull();
  expect(screen.queryByRole("region", { name: "Ask Aril" })).toBeNull();
  expect(screen.queryByRole("list", { name: "Suggestions" })).toBeNull();
  expect(screen.queryByText("Enter to send · Esc to go back")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Open Aril, the Pomegr agent/ })).toBeNull();
};

describe("Home while Aril is Off", () => {
  it("has no composer and no suggestion chips, and the rest of Home is as it was, with no gap where the composer was", async () => {
    busyHome();
    chat.arilSwitch = { on: false, pairedOn: false };
    home();
    await settle();
    noComposer();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^Good (morning|afternoon|evening)$/);
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /^Continue/ })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "What’s new" })).toBeInTheDocument();
    // The column holds the content and nothing else: no empty block waits for a composer.
    expect(columnOf().children).toHaveLength(1);
    expect(columnOf().firstElementChild).not.toHaveAttribute("inert");
    // The chat is not asked anything, not even for the thread's run.
    expect(chat.agentChat).not.toHaveBeenCalled();
  });

  it("draws the last-24-hours tiles and their mark while Aril is Off, since the numbers come from Pomegr and not from the chat", async () => {
    busyHome();
    chat.arilSwitch = { on: false, pairedOn: false };
    home();
    await settle();
    noComposer();
    expect(screen.getByText("Last 24 hours")).toBeInTheDocument();
    const tiles = within(screen.getByRole("list", { name: "Tasks in the last 24 hours" })).getAllByRole("listitem");
    expect(tiles.map((tile) => tile.firstElementChild?.textContent)).toEqual(["1", "1", "1", "1"]);
  });

  it("draws the composer and the chips only when Aril is On", async () => {
    busyHome();
    home();
    await settle();
    expect(homeField()).not.toBeNull();
    expect(screen.getByRole("list", { name: "Suggestions" })).toBeInTheDocument();
    expect(columnOf().children).toHaveLength(2);
  });

  it("draws neither before the switch is known, and never draws the composer and then takes it back", async () => {
    busyHome();
    chat.arilSwitch = { on: false, pairedOn: false };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    chat.arilControl.mockImplementationOnce(async (...asked) => { await gate; return chat.arilControl.getMockImplementation()!(...asked); });
    const seen: boolean[] = [];
    const watcher = new MutationObserver(() => { seen.push(document.getElementById("home-aril-message") !== null); });
    home();
    watcher.observe(document.body, { childList: true, subtree: true });
    await settle();
    noComposer();
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
    release();
    await settle();
    noComposer();
    watcher.disconnect();
    expect(seen.some(Boolean)).toBe(false);
  });

  it("draws no composer when the desktop gives no control or cannot answer", async () => {
    busyHome();
    setBridge({ agentChat: chat.agentChat, agentChatImage: chat.agentChatImage });
    home();
    await settle(5_000);
    noComposer();
  });

  it("follows the switch: the composer goes when Aril is turned Off and comes back when it is turned On", async () => {
    busyHome();
    home();
    await settle();
    expect(homeField()).not.toBeNull();
    chat.arilSwitch = { on: false, pairedOn: false };
    await settle(5_000);
    noComposer();
    expect(columnOf().children).toHaveLength(1);
    chat.arilSwitch = { on: true, pairedOn: false };
    await settle(5_000);
    expect(homeField()).not.toBeNull();
    expect(screen.getByRole("list", { name: "Suggestions" })).toBeInTheDocument();
  });

  it("gives Home back when Aril is turned Off while the composer is lifted", async () => {
    busyHome();
    const person = newUser();
    home();
    await settle();
    await person.click(homeField()!);
    expect(page().querySelector('[class*="isHidden"]')).not.toBeNull();
    expect(page().querySelector('[class*="_content_"][inert]')).not.toBeNull();
    chat.arilSwitch = { on: false, pairedOn: false };
    await settle(5_000);
    noComposer();
    expect(page().querySelector('[class*="isHidden"]')).toBeNull();
    expect(page().querySelector('[class*="_content_"][inert]')).toBeNull();
    expect(page().querySelector('[class*="_dim_"]')).toBeNull();
    expect(within(page()).getByRole("region", { name: "Needs you" })).toBeInTheDocument();
  });

  it("on a paired phone, draws no composer while Aril is Off and the composer when it is On", async () => {
    busyHome();
    pairPhone(chat);
    chat.arilSwitch = { on: false, pairedOn: true };
    home();
    await settle();
    noComposer();
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
    chat.arilSwitch = { on: true, pairedOn: true };
    await settle(5_000);
    expect(homeField()).not.toBeNull();
    chat.arilSwitch = { on: false, pairedOn: true };
    await settle(5_000);
    noComposer();
  });

  it("does not move Home when a link to the chat is clicked inside the app while Aril is Off", async () => {
    chat.arilSwitch = { on: false, pairedOn: false };
    home();
    await settle();
    // Home is where such a link lands, so there is nothing to leave, and nothing opens.
    act(() => { window.dispatchEvent(new CustomEvent("pomegr:open-aril-chat", { detail: { repositoryId: REPO_A, conversationId: null, messageId: null } })); });
    await settle();
    noComposer();
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });
});
