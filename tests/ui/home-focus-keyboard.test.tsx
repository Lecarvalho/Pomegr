import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, installHarness, newUser, removeHarness, setInventory, settle } from "./agent-chat-fixture";
import { desktopBridge, resetHome } from "./home-fixture";

// Where Home's composer block stands in focus mode on a phone, and what the layer behind it does. T-219, measured on the owner's phone (OnePlus CPH2583, Chrome 156, a
// layout viewport of 360x696): the keyboard opens in one step and takes 264px, and a block that follows it is moved by Chrome's own pan of the visual viewport, so it bumps
// toward the top of the screen. Moving it at once on the resize jumps it, and so does a relayout. The owner approved this: the block glides to a place the keyboard will not
// cover (top 184px there) as focus mode starts, the keyboard opens below it, and the block never moves again; the layer fades in and out instead of appearing and vanishing.
// The block is held by its bottom edge (`--focus-bottom`, 280px there), so a message that grows it moves its top edge up: with five lines typed it was 107 to 416px, Send at 348px and
// Back to Home at 416px, all above the keyboard, where a block held by its top went on to 493px, under it. `--focus-max` is the tallest it may grow, a gap under the header.
// jsdom does no layout, so the geometry is stubbed: the block, its composer, and the header answer the rectangles a phone gave.
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
import { KEYBOARD_STORAGE_KEY } from "../../app/components/home/focus-place";
import { GLIDE_EASE, GLIDE_MS } from "../../app/components/home/useComposerGlide";
import { DIM_FADE_MS } from "../../app/components/home/useDimLayer";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";

const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8").replace(/\r\n/g, "\n");
const pageCss = read("app", "HomeDashboard.module.css");

// The phone, in pixels. The block is 232px tall in focus mode, with its Back to Home action, and 150px at rest; its composer is 60px under its top.
const SCREEN = 696;
const KEYBOARD = 264;
const FOCUS_HEIGHT = 232;
/** Five lines typed on the phone that was measured: the block grew from 232px to 309px. */
const GROWN_HEIGHT = 309;
const REST_HEIGHT = 150;
const HEADER_BOTTOM = 56;
const COMPOSER_OFFSET = 60;
const REST_COMPOSER = 560;
const geometry = { restTop: 520, focusHeight: FOCUS_HEIGHT };

const LAYER = '[class*="_dim_"]';
const findBlock = () => document.querySelector<HTMLElement>('section[aria-label="Ask Aril"]');
const blockEl = () => findBlock()!;
const layerEl = () => document.querySelector<HTMLElement>(LAYER);
const wrapperEl = () => blockEl().parentElement!;
/** The place the component set when focus mode started: how far the block's bottom edge is from the bottom of the screen, and how tall it may grow. Empty where none is set. */
const bottomOf = () => blockEl().style.getPropertyValue("--focus-bottom");
const maxOf = () => blockEl().style.getPropertyValue("--focus-max");
/** Where the block is on the screen (the stub answers as a fixed block with `bottom` does), in pixels from the top and from the bottom of the screen. */
const topOf = () => blockEl().getBoundingClientRect().top;
const bottomEdgeOf = () => blockEl().getBoundingClientRect().bottom;
const stored = () => window.localStorage.getItem(KEYBOARD_STORAGE_KEY);
const rect = (top: number, height: number) => ({ x: 12, y: top, left: 12, top, right: 378, bottom: top + height, width: 366, height, toJSON: () => ({}) }) as DOMRect;

function stubMedia({ phone, reducedMotion }: { phone: boolean; reducedMotion: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query, matches: (phone && query === "(max-width: 760px)") || (reducedMotion && query === "(prefers-reduced-motion: reduce)"), onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
}

type FakeViewport = EventTarget & { height: number; scale: number; offsetTop: number };
function installViewport(): FakeViewport {
  const viewport = Object.assign(new EventTarget(), { height: SCREEN, scale: 1, offsetTop: 0 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}
/** What the keyboard does to the visual viewport: it shrinks, and Chrome may pan it. The layout viewport (`innerHeight`) is not touched. */
function resizeTo(viewport: FakeViewport, height: number) {
  viewport.height = height;
  viewport.dispatchEvent(new Event("resize"));
}

let chat: FakeChat;
let shell: HTMLElement;
let animate: ReturnType<typeof vi.fn>;
const realInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const setScreen = (height: number) => Object.defineProperty(window, "innerHeight", { configurable: true, value: height });

beforeEach(() => {
  chat = installHarness();
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
  stubMedia({ phone: true, reducedMotion: false });
  setScreen(SCREEN);
  geometry.restTop = 520;
  geometry.focusHeight = FOCUS_HEIGHT;
  const measure = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const focus = /_isFocus_/.test(this.closest('section[aria-label="Ask Aril"]')?.className ?? "");
    // A fixed block held by `bottom` ends that far above the bottom of the screen and begins one height higher; before the place is set it is at 0, which is only its height being read.
    const held = Number.parseFloat(findBlock()?.style.getPropertyValue("--focus-bottom") ?? "");
    const placed = Number.isNaN(held) ? Number.NaN : window.innerHeight - held - geometry.focusHeight;
    if (this.classList.contains("commandHeader")) return rect(0, HEADER_BOTTOM);
    if (this.matches('section[aria-label="Ask Aril"]')) return focus ? rect(Number.isNaN(placed) ? 0 : placed, geometry.focusHeight) : rect(geometry.restTop, REST_HEIGHT);
    if (this.classList.contains("agentChatComposer")) return focus ? rect((Number.isNaN(placed) ? 0 : placed) + COMPOSER_OFFSET, 100) : rect(REST_COMPOSER, 100);
    return measure.call(this);
  });
  animate = vi.fn(() => ({ cancel: vi.fn() }));
  Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true, writable: true });
});
afterEach(() => {
  shell?.remove();
  delete (Element.prototype as { animate?: unknown }).animate;
  window.localStorage.removeItem(KEYBOARD_STORAGE_KEY);
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  if (realInnerHeight) Object.defineProperty(window, "innerHeight", realInnerHeight);
  removeHarness();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Draws Home in the shell's markup, with its header, and answers the page once it has settled. */
async function renderHome() {
  shell = document.createElement("div");
  shell.className = "commandShell";
  const header = document.createElement("header");
  header.className = "commandHeader";
  const main = document.createElement("main");
  main.className = "commandMain";
  shell.append(header, main);
  document.body.append(shell);
  render(<SessionCatalogProvider sessions={[]}><HomeDashboard /></SessionCatalogProvider>, { container: main });
  await settle();
}
const field = () => document.getElementById("home-aril-message")!;
const focusHome = async () => { await renderHome(); await newUser().click(field()); };
const animationEnd = (element: Element) => { for (const type of ["animationend", "webkitAnimationEnd"]) fireEvent(element, new Event(type, { bubbles: true })); };
const leaveByTapping = async () => { await newUser().click(layerEl()!); };

describe("where the block is placed when focus mode starts", () => {
  it("is above the keyboard this device last had: 184px on the phone that was measured", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    await focusHome();
    expect(topOf()).toBe(SCREEN - KEYBOARD - FOCUS_HEIGHT - 16);
    expect(topOf()).toBe(184);
  });

  it("holds the block by its bottom edge: 280px above the bottom of the screen, which is the keyboard and the gap, with room to grow up to 348px", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    await focusHome();
    expect(bottomOf()).toBe(`${SCREEN - 184 - FOCUS_HEIGHT}px`);
    expect(bottomOf()).toBe(`${KEYBOARD + 16}px`);
    expect(maxOf()).toBe(`${SCREEN - 280 - HEADER_BOTTOM - 12}px`);
    expect(maxOf()).toBe("348px");
    expect([topOf(), bottomEdgeOf()]).toEqual([184, 416]);
  });

  it("is above a share of the screen where no keyboard was measured yet", async () => {
    setScreen(800);
    await focusHome();
    expect(stored()).toBeNull();
    expect(topOf()).toBe(800 - Math.round(0.38 * 800) - FOCUS_HEIGHT - 16);
  });

  it.each(["", "nonsense", "40", "99999"])("does not trust the stored height %j", async (value) => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, value);
    await focusHome();
    expect(topOf()).toBe(SCREEN - Math.round(0.38 * SCREEN) - FOCUS_HEIGHT - 16);
  });

  it("works where browser storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
      if (key === KEYBOARD_STORAGE_KEY) throw new Error("blocked");
      return key === HOME_PREFERENCES_STORAGE_KEY ? JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }) : null;
    });
    await focusHome();
    expect(topOf()).toBe(184);
  });

  it("stops below the header, whatever the keyboard, and then has no room to grow", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, "600");
    await focusHome();
    expect(topOf()).toBe(HEADER_BOTTOM + 12);
    expect(bottomOf()).toBe(`${SCREEN - (HEADER_BOTTOM + 12) - FOCUS_HEIGHT}px`);
    expect(maxOf()).toBe(`${FOCUS_HEIGHT}px`);
  });

  it("is never below the resting place of the block", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, "130");
    geometry.restTop = 200;
    await focusHome();
    expect(SCREEN - 130 - FOCUS_HEIGHT - 16).toBeGreaterThan(200);
    expect(topOf()).toBe(200);
  });

  it("is set before the glide measures the block, so the glide runs to the place the block stands in", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    await focusHome();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith([{ transform: `translate(0px, ${REST_COMPOSER - (184 + COMPOSER_OFFSET)}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: GLIDE_EASE });
  });

  it("does not set a place on the desktop, which centers the block with its own shift", async () => {
    stubMedia({ phone: false, reducedMotion: false });
    const viewport = installViewport();
    const listen = vi.spyOn(viewport, "addEventListener");
    await focusHome();
    expect(bottomOf()).toBe("");
    expect(listen).not.toHaveBeenCalled();
    resizeTo(viewport, 432);
    expect(stored()).toBeNull();
  });

  it("takes the stored place under reduced motion too, with no glide: the block is at its new place at once", async () => {
    stubMedia({ phone: true, reducedMotion: true });
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    await focusHome();
    expect(topOf()).toBe(184);
    expect(animate).not.toHaveBeenCalled();
  });

  it("clears the place when focus mode ends", async () => {
    await focusHome();
    expect(bottomOf()).not.toBe("");
    await leaveByTapping();
    expect(bottomOf()).toBe("");
  });
});

describe("the block while a message grows it", () => {
  // The owner's phone, five lines typed: the block went from 232px to 309px. Held by its top it ran from 184px to 493px, and Back to Home was under the keyboard, which starts at 432px.
  it("grows upward: the top edge moves up and the bottom edge stays, so Send and Back to Home stay above the keyboard", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    const person = newUser();
    await renderHome();
    await person.click(field());
    expect([topOf(), bottomEdgeOf()]).toEqual([184, 416]);
    const placed = blockEl().getAttribute("style");
    // The block is taller now. Nothing measures it again, so nothing sets a place again.
    geometry.focusHeight = GROWN_HEIGHT;
    await person.type(field(), "five lines");
    expect(blockEl().getAttribute("style")).toBe(placed);
    expect(bottomOf()).toBe("280px");
    expect([topOf(), bottomEdgeOf()]).toEqual([107, 416]);
    expect(bottomEdgeOf()).toBeLessThanOrEqual(SCREEN - KEYBOARD);
    // Held by its top edge it would have ended at 493px, under the keyboard.
    expect(184 + GROWN_HEIGHT).toBe(493);
    expect(184 + GROWN_HEIGHT).toBeGreaterThan(SCREEN - KEYBOARD);
  });

  it("stays within the cap under the header: the tallest block has its top edge a gap under the header", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    await focusHome();
    // The cap is what the stylesheet gives as `max-height`; a block as tall as that has its top 12px under the header.
    geometry.focusHeight = Number.parseFloat(maxOf());
    expect(topOf()).toBe(HEADER_BOTTOM + 12);
    expect(bottomEdgeOf()).toBe(416);
  });

  it("keeps the same bottom edge as the block shrinks again", async () => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, String(KEYBOARD));
    const person = newUser();
    await renderHome();
    await person.click(field());
    geometry.focusHeight = GROWN_HEIGHT;
    await person.type(field(), "x");
    expect(bottomEdgeOf()).toBe(416);
    geometry.focusHeight = FOCUS_HEIGHT;
    await person.clear(field());
    expect([topOf(), bottomEdgeOf()]).toEqual([184, 416]);
  });
});

describe("the keyboard while focus mode is on", () => {
  it("is measured from the visual viewport and kept for the next time, which then places the block with it", async () => {
    const viewport = installViewport();
    await focusHome();
    expect(topOf()).toBe(SCREEN - Math.round(0.38 * SCREEN) - FOCUS_HEIGHT - 16);
    resizeTo(viewport, SCREEN - 316);
    expect(stored()).toBe("316");
    // The next time focus mode starts, the block is placed above the keyboard that was measured.
    await newUser().click(screen.getByRole("button", { name: "Back to Home" }));
    await waitFor(() => expect(layerEl()).toBeNull());
    expect(bottomOf()).toBe("");
    await newUser().click(field());
    expect(topOf()).toBe(SCREEN - 316 - FOCUS_HEIGHT - 16);
  });

  it("keeps the last height it measured, as the keyboard settles", async () => {
    const viewport = installViewport();
    await focusHome();
    for (const height of [600, 500, 432]) resizeTo(viewport, height);
    expect(stored()).toBe("264");
  });

  it.each([["a browser bar", SCREEN - 56], ["no shrink", SCREEN], ["the whole screen", 0]])("does not take %s for a keyboard", async (_, height) => {
    window.localStorage.setItem(KEYBOARD_STORAGE_KEY, "301");
    const viewport = installViewport();
    await focusHome();
    resizeTo(viewport, height);
    expect(stored()).toBe("301");
  });

  it("does not take a pinch zoom for a keyboard", async () => {
    const viewport = installViewport();
    await focusHome();
    viewport.scale = 2.4;
    resizeTo(viewport, 300);
    expect(stored()).toBeNull();
  });

  it("stops measuring when focus mode ends", async () => {
    const viewport = installViewport();
    await focusHome();
    await leaveByTapping();
    resizeTo(viewport, 400);
    expect(stored()).toBeNull();
  });

  it("does not throw where browser storage cannot be written", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => { if (key === KEYBOARD_STORAGE_KEY) throw new Error("full"); });
    const viewport = installViewport();
    await focusHome();
    expect(() => resizeTo(viewport, 432)).not.toThrow();
  });

  it("changes nothing about the block while the keyboard opens, resizes, pans, and closes: it would jump, or move with Chrome's pan", async () => {
    const viewport = installViewport();
    await focusHome();
    const block = blockEl();
    const placed = block.getAttribute("style");
    const watcher = new MutationObserver(() => {});
    watcher.observe(block, { attributes: true, subtree: true });
    watcher.takeRecords();
    animate.mockClear();
    // The keyboard opens in one step on the phone that was measured, and Chrome pans the visual viewport 264px over about 200ms.
    resizeTo(viewport, 432);
    for (const offsetTop of [60, 130, 264]) { viewport.offsetTop = offsetTop; viewport.dispatchEvent(new Event("scroll")); }
    // It changes, then closes.
    resizeTo(viewport, 360);
    resizeTo(viewport, SCREEN);
    expect(watcher.takeRecords()).toEqual([]);
    expect(block.getAttribute("style")).toBe(placed);
    expect(block.className).toMatch(/_isFocus_/);
    expect(animate).not.toHaveBeenCalled();
    watcher.disconnect();
  });
});

describe("the layer behind the block fades", () => {
  it("fades in over the time of the content's own fade, with a keyframe from nothing to opaque", () => {
    expect(DIM_FADE_MS).toBe(280);
    expect(pageCss).toContain(`.content { display: flex; flex-direction: column; gap: var(--space-6); min-width: 0; transition: opacity ${DIM_FADE_MS}ms ease, transform ${DIM_FADE_MS}ms ease; }`);
    expect(pageCss).toContain(`animation: dimIn ${DIM_FADE_MS}ms ease both;`);
    expect(pageCss).toContain("@keyframes dimIn { from { opacity: 0; } to { opacity: 1; } }");
  });

  it("fades out over the same time with a keyframe from opaque to nothing, and does not catch a tap while it does", () => {
    expect(pageCss).toContain("@keyframes dimOut { from { opacity: 1; } to { opacity: 0; } }");
    expect(pageCss).toContain(".dim.isLeaving { animation-name: dimOut; pointer-events: none; }");
  });

  it("is mounted in focus mode and stays mounted, fading out, when focus mode ends; the block's wrapper stays above it meanwhile", async () => {
    await focusHome();
    const layer = layerEl()!;
    expect(layer.className).not.toMatch(/_isLeaving_/);
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
    await leaveByTapping();
    expect(layerEl()).toBe(layer);
    expect(layer.className).toMatch(/_isLeaving_/);
    expect(wrapperEl().className).toMatch(/_isReleasing_/);
    expect(blockEl().className).not.toMatch(/_isFocus_/);
  });

  it.each([
    ["Back to Home", async () => { await newUser().click(screen.getByRole("button", { name: "Back to Home" })); }],
    ["Escape", async () => { await newUser().keyboard("{Escape}"); }],
  ])("fades out when focus mode ends with %s too", async (_, leave) => {
    await focusHome();
    await leave();
    expect(layerEl()?.className).toMatch(/_isLeaving_/);
  });

  it("goes when its fade ends", async () => {
    await focusHome();
    await leaveByTapping();
    animationEnd(layerEl()!);
    expect(layerEl()).toBeNull();
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
  });

  it("goes after the time of its fade even if the browser never says that the fade ended", async () => {
    await focusHome();
    await leaveByTapping();
    expect(layerEl()).not.toBeNull();
    await waitFor(() => expect(layerEl()).toBeNull(), { timeout: 1_000 });
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
  });

  it("is the layer of focus mode again, not a second one, when the owner taps the field while it fades out", async () => {
    await focusHome();
    await leaveByTapping();
    const layer = layerEl()!;
    await newUser().click(field());
    expect(blockEl().className).toMatch(/_isFocus_/);
    expect(layerEl()).toBe(layer);
    expect(layer.className).not.toMatch(/_isLeaving_/);
    expect(document.querySelectorAll(LAYER)).toHaveLength(1);
  });

  it("goes at once under reduced motion: only end states, and no blink", async () => {
    stubMedia({ phone: true, reducedMotion: true });
    await focusHome();
    expect(layerEl()).not.toBeNull();
    await leaveByTapping();
    expect(layerEl()).toBeNull();
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
    expect(pageCss).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.dim, \.dim\.isLeaving \{ animation: none; \}/);
  });

  it("goes at once on the desktop, where it is transparent and would only catch clicks", async () => {
    stubMedia({ phone: false, reducedMotion: false });
    await focusHome();
    await leaveByTapping();
    expect(layerEl()).toBeNull();
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
  });

  it("goes at once on Send, which hands the screen to the panel and must not leave the layer over it", async () => {
    const person = newUser();
    await renderHome();
    await person.type(field(), "From the phone");
    expect(blockEl().className).toMatch(/_isFocus_/);
    await person.keyboard("{Enter}");
    expect(blockEl().className).toMatch(/_isThread_/);
    expect(layerEl()).toBeNull();
    expect(wrapperEl().className).not.toMatch(/_isReleasing_/);
  });
});
