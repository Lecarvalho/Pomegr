import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, agentMessage, conversationOf, harness, installHarness, newUser, removeHarness, setInventory, settle, userMessage } from "./agent-chat-fixture";
import { busyHome, desktopBridge, resetHome } from "./home-fixture";

// Home's focus mode and what Send does from it: focusing the composer (or picking a chip) lifts it and fades the rest of Home out; Send turns the page into the
// maximized Aril view on that repository's thread, and closing that view gives the page back to Home.
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
const realMatchMedia = window.matchMedia;

beforeEach(() => {
  chat = installHarness();
  harness.pathname = "/";
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
});
afterEach(() => {
  removeHarness();
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
});

const user = newUser;
const homeField = () => document.getElementById("home-aril-message") as HTMLTextAreaElement;
const page = () => document.getElementById("home-page")!;
const block = () => screen.getByRole("region", { name: "Ask Aril" });
const hidden = () => page().querySelector('[class*="isHidden"]');
const dim = () => document.querySelector<HTMLElement>('[class*="_dim_"]');
const hint = () => screen.getByText("Enter to send · Esc to go back");
const panel = () => screen.getByRole("region", { name: "Aril, the Pomegr agent" });
const log = () => screen.getByRole("log", { name: "Conversation with Aril" });
const inFocusMode = () => /isFocus/.test(block().className);
const home = (rows: never[] = []) => render(<SessionCatalogProvider sessions={rows}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);

function mediaMatching(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn((query: string) => ({ matches: matches(query), media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
}

describe("focus mode", () => {
  it("starts when the composer's field is focused: the rest of Home fades out and the composer lifts, with the hint under it", async () => {
    busyHome();
    const person = user();
    home();
    await settle();
    expect(inFocusMode()).toBe(false);
    expect(hidden()).toBeNull();
    expect(page().querySelector("[inert]")).toBeNull();
    expect(hint()).toHaveAttribute("aria-hidden", "true");
    expect(dim()).toBeNull();
    await person.click(homeField());
    expect(inFocusMode()).toBe(true);
    // Everything but the composer block fades out and cannot be reached; the greeting, Needs you, Continue, and the status line are in it.
    const faded = hidden()!;
    expect(faded).not.toBeNull();
    expect(faded).toHaveAttribute("inert");
    expect(faded).toContainElement(screen.getByRole("heading", { level: 1 }));
    expect(faded).toContainElement(screen.getByRole("region", { name: "Needs you" }));
    expect(faded).toContainElement(screen.getByRole("region", { name: /^Continue/ }));
    expect(faded).toContainElement(screen.getByRole("complementary", { name: "Provider service status" }));
    expect(faded).not.toContainElement(block());
    // The chips stay above the composer, and the hint shows under it.
    expect(within(block()).getByRole("list", { name: "Suggestions" })).toBeInTheDocument();
    expect(hint()).toHaveAttribute("aria-hidden", "false");
    expect(dim()).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Aril, the Pomegr agent" })).toBeNull();
  });

  it("starts when a chip is picked: its words go in the field, nothing is sent", async () => {
    const person = user();
    home();
    await settle();
    await person.click(within(screen.getByRole("list", { name: "Suggestions" })).getAllByRole("button")[0]);
    expect(inFocusMode()).toBe(true);
    expect(homeField()).toHaveFocus();
    expect(homeField().value).toMatch(/\S/);
    expect(chat.calls("send")).toEqual([]);
  });

  it("does not start when another control of the composer is used, or when the page is only read", async () => {
    const person = user();
    home();
    await settle();
    await person.click(within(block()).getByRole("button", { name: "Attach image" }));
    expect(inFocusMode()).toBe(false);
    await person.tab();
    expect(hidden()).toBeNull();
  });

  it("ends with Escape: Home comes back, the draft stays, and focus goes to the page, not into the composer", async () => {
    const person = user();
    home();
    await settle();
    await person.type(homeField(), "A draft I keep");
    expect(inFocusMode()).toBe(true);
    await person.keyboard("{Escape}");
    expect(inFocusMode()).toBe(false);
    expect(hidden()).toBeNull();
    expect(page().querySelector("[inert]")).toBeNull();
    expect(hint()).toHaveAttribute("aria-hidden", "true");
    expect(homeField()).toHaveValue("A draft I keep");
    expect(page()).toHaveFocus();
    expect(chat.calls("send")).toEqual([]);
    // Focusing the field again starts it again.
    await person.click(homeField());
    expect(inFocusMode()).toBe(true);
  });

  it("ends with a click outside while the field is empty, and not while it holds a draft", async () => {
    const person = user();
    home();
    await settle();
    await person.click(homeField());
    await person.click(dim()!);
    expect(inFocusMode()).toBe(false);
    expect(dim()).toBeNull();

    await person.type(homeField(), "Not empty");
    expect(inFocusMode()).toBe(true);
    await person.click(dim()!);
    expect(inFocusMode()).toBe(true);
    expect(homeField()).toHaveValue("Not empty");
    await person.clear(homeField());
    await person.click(dim()!);
    expect(inFocusMode()).toBe(false);
  });

  it("leaves Escape to an open list of the composer first", async () => {
    const person = user();
    home();
    await settle();
    await person.click(homeField());
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await person.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(inFocusMode()).toBe(true);
    await person.keyboard("{Escape}");
    expect(inFocusMode()).toBe(false);
  });

  it("lifts the block to the middle of the content area, measured from where it is, and brings it back", async () => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const size = this.classList.contains("commandMain") ? { top: 0, height: 900 } : this.getAttribute("aria-label") === "Ask Aril" ? { top: 700, height: 200 } : { top: 0, height: 0 };
      return { ...size, bottom: size.top + size.height, left: 0, right: 0, width: 0, x: 0, y: size.top, toJSON() {} } as DOMRect;
    });
    const person = user();
    render(<div className="commandMain"><SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider></div>);
    await settle();
    expect(block().style.getPropertyValue("--focus-shift")).toBe("0px");
    await person.click(homeField());
    // The block's top is 700 and it is 200 high, in an area 900 high: the middle is 350, so it moves up by 350.
    expect(block().style.getPropertyValue("--focus-shift")).toBe("-350px");
    await person.keyboard("{Escape}");
    expect(block().style.getPropertyValue("--focus-shift")).toBe("0px");
  });
});

describe("Send from focus mode", () => {
  beforeEach(() => { chat.seed(REPO_A, conversationOf(1, [userMessage("Is T-214 ready for me?"), agentMessage("Not yet.")])); });

  it("turns the page into the maximized Aril view on that repository's thread, with the message sent through the panel's own send", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Effort" }));
    await person.click(screen.getByRole("option", { name: "High" }));
    await person.type(homeField(), "Which task should run first?");
    expect(inFocusMode()).toBe(true);
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toEqual([{ repositoryId: REPO_A, conversationId: null, text: "Which task should run first?", provider: "claude", model: "model-large", effort: "high" }]);
    // The existing expanded view: the earlier messages, then the new one, and the answer being written. The chips go away, and Home waits under it.
    expect(panel()).toHaveClass("isExpanded", "isEntering");
    expect(within(log()).getByText("Is T-214 ready for me?")).toBeInTheDocument();
    expect(within(log()).getByText("Not yet.")).toBeInTheDocument();
    expect(within(log()).getByText("Which task should run first?")).toBeInTheDocument();
    expect(within(panel()).getByRole("status")).toHaveTextContent(/Thinking…|Starting…/);
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveFocus();
    expect(/isThread/.test(block().className)).toBe(true);
    expect(hidden()).not.toBeNull();
    expect(hint()).toHaveAttribute("aria-hidden", "true");
    expect(homeField()).toHaveValue("");
    // One send for one message, and the messages stop fading in once the entry is over.
    await settle(3_000);
    expect(chat.calls("send")).toHaveLength(1);
    expect(panel()).not.toHaveClass("isEntering");
    expect(panel()).toHaveClass("isExpanded");
  });

  it("starts the panel's composer where Home's was, and settles it to the bottom, unless the owner asks for reduced motion", async () => {
    const top = (element: Element) => (element.closest(".agentChatPanel") ? 700 : 300);
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return { top: top(this), height: 100, bottom: top(this) + 100, left: 0, right: 0, width: 0, x: 0, y: top(this), toJSON() {} } as DOMRect;
    });
    const person = user();
    home();
    await settle();
    await person.type(homeField(), "First");
    await person.keyboard("{Enter}");
    await settle();
    const composer = within(panel()).getByRole("textbox", { name: "Message Aril" }).closest("form")!;
    expect(composer.style.transition).toMatch(/^transform 480ms cubic-bezier\(\.2, \.8, \.2, 1\)$/);

    // Under reduced motion the composer is simply where it belongs.
    removeHarness();
    chat = installHarness();
    harness.pathname = "/";
    setInventory([[REPO_A, "pomegr"]]);
    desktopBridge(chat);
    mediaMatching((query) => /prefers-reduced-motion: reduce/.test(query));
    document.body.replaceChildren();
    const quiet = user();
    home();
    await settle();
    await quiet.type(homeField(), "Second");
    await quiet.keyboard("{Enter}");
    await settle();
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" }).closest("form")!.style.transition).toBe("");
  });

  it("gives the page back to Home when the maximized view closes: the parts return, the composer is not lifted, and focus is on the page", async () => {
    const person = user();
    const view = home();
    await settle();
    await person.type(homeField(), "Hello");
    await person.keyboard("{Enter}");
    await settle();
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    await settle();
    expect(/isThread|isFocus/.test(block().className)).toBe(false);
    expect(hidden()).toBeNull();
    expect(page().querySelector("[inert]")).toBeNull();
    expect(page()).toHaveFocus();
    expect(homeField()).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: /^Open Aril, the Pomegr agent/ })).toBeNull();
    // The panel's own mode is what it was: the next opening from another page is docked, not maximized.
    harness.pathname = "/sessions";
    view.rerender(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await person.click(screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ }));
    await settle();
    expect(panel()).not.toHaveClass("isExpanded");
  });

  it("keeps a maximized panel that was already maximized, and a draft that waits in the panel", async () => {
    harness.pathname = "/sessions";
    const person = user();
    const view = home();
    await settle();
    await person.click(screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ }));
    await settle();
    await person.click(within(panel()).getByRole("button", { name: "Expand" }));
    await person.type(within(panel()).getByRole("textbox", { name: "Message Aril" }), "A draft in the panel");
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    harness.pathname = "/";
    view.rerender(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await settle();
    await person.type(homeField(), "From Home");
    await person.keyboard("{Enter}");
    await settle();
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveValue("A draft in the panel");
    await person.click(within(panel()).getByRole("button", { name: "Close Aril" }));
    harness.pathname = "/sessions";
    view.rerender(<SessionCatalogProvider sessions={[]}><HomeDashboard /><AgentChatDock /></SessionCatalogProvider>);
    await person.click(screen.getByRole("button", { name: /^Open Aril, the Pomegr agent/ }));
    expect(panel()).toHaveClass("isExpanded");
  });

  it("puts a refused message back in the panel's field with the fixed line, and the page is the thread", async () => {
    chat.refuse = "busy";
    const person = user();
    home();
    await settle();
    await person.type(homeField(), "From Home");
    await person.keyboard("{Enter}");
    await settle();
    expect(within(panel()).getByRole("textbox", { name: "Message Aril" })).toHaveValue("From Home");
    expect(within(panel()).getByRole("alert")).toHaveTextContent("Aril is already answering. Wait for it to finish.");
    expect(panel()).toHaveClass("isExpanded");
  });

  it("sends to the repository the composer shows", async () => {
    const person = user();
    home();
    await settle();
    await person.click(screen.getByRole("combobox", { name: "Repository" }));
    await person.click(screen.getByRole("option", { name: "clapline" }));
    await person.type(homeField(), "For the other one");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send").map((payload) => [payload.repositoryId, payload.text])).toEqual([[REPO_B, "For the other one"]]);
    expect(within(panel()).getByRole("combobox", { name: "Repository" })).toHaveTextContent("clapline");
  });
});

describe("focus mode on a phone", () => {
  it("fills the screen with the composer above the keyboard, no lift, and a way back that needs no Escape key", async () => {
    mediaMatching((query) => query === "(max-width: 760px)");
    const listeners = new Map<string, () => void>();
    const viewport = { height: 500, offsetTop: 0, addEventListener: (name: string, handler: () => void) => listeners.set(name, handler), removeEventListener: (name: string) => listeners.delete(name) };
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const person = user();
    home();
    await settle();
    expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
    await person.click(homeField());
    expect(inFocusMode()).toBe(true);
    expect(block().style.getPropertyValue("--focus-shift")).toBe("0px");
    expect(block().style.getPropertyValue("--keyboard-inset")).toBe("300px");
    // The keyboard closes a little: the block follows.
    viewport.height = 600;
    listeners.get("resize")?.();
    expect(block().style.getPropertyValue("--keyboard-inset")).toBe("200px");
    await person.click(screen.getByRole("button", { name: "Back to Home" }));
    expect(inFocusMode()).toBe(false);
    expect(block().style.getPropertyValue("--keyboard-inset")).toBe("");
    expect(listeners.size).toBe(0);
  });

  it("hands the page to the full-screen sheet on Send", async () => {
    mediaMatching((query) => query === "(max-width: 760px)");
    const person = user();
    home();
    await settle();
    await person.type(homeField(), "From the phone");
    await person.keyboard("{Enter}");
    await settle();
    expect(chat.calls("send")).toHaveLength(1);
    expect(within(log()).getByText("From the phone")).toBeInTheDocument();
    expect(panel()).toHaveClass("isExpanded");
  });
});

