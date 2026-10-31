import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installHarness, newUser, removeHarness, setInventory, settle, REPO_A } from "./agent-chat-fixture";
import { desktopBridge, resetHome } from "./home-fixture";

// The composer block of Home on a phone follows the keyboard (T-219, reported on a paired Android phone): when the owner taps the composer the block bumped toward the
// top of the screen, then went down to its place above the keyboard. A browser measurement at 390x844 with a stand-in visual viewport explained it. The block was fixed with
// `bottom` set to `innerHeight - visualViewport.height - visualViewport.offsetTop` under a 300ms transition. While the keyboard opens, the visual viewport is panned (the
// browser scrolls the focused field into view) after it is resized, and a fixed block moves on the screen with the pan. The transition was still chasing the inset of the
// frame before the pan, so the block went past its final place by the pan, and came back. A pair of values that disagree for a frame (`innerHeight` against `height`)
// did the same. The block is now placed against the visual viewport alone, every frame, and eased only in screen space.
// jsdom does no layout, so the test drives the visual viewport through the sequences below, runs the animation frames by hand, and reads where the block's anchor is on the
// screen: the custom property that `top` is made of, minus how far the visual viewport is panned.
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
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";

const SCREEN = 844;
const KEYBOARD = 336;
const FINAL = SCREEN - KEYBOARD;
const FRAME = 16;
const arilCss = readFileSync(join(process.cwd(), "app", "components", "home", "HomeAril.module.css"), "utf8").replace(/\r\n/g, "\n");

// ---- A visual viewport the test moves, and animation frames it runs. ----

class FakeViewport extends EventTarget {
  height = SCREEN;
  offsetTop = 0;
}

let viewport: FakeViewport;
let queue: Map<number, FrameRequestCallback>;
let clock: number;
let nextId: number;

function stubBrowser(reducedMotion: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query, matches: query === "(max-width: 760px)" || (reducedMotion && query === "(prefers-reduced-motion: reduce)"), onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
  viewport = new FakeViewport();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  queue = new Map();
  clock = 1000;
  nextId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextId += 1; queue.set(nextId, callback); return nextId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { queue.delete(id); });
}

/** One animation frame of 60 Hz: the callbacks that were asked for, with the time of the frame. */
function frame() {
  clock += FRAME;
  const due = [...queue.entries()];
  queue.clear();
  for (const [, callback] of due) callback(clock);
}

let block: HTMLElement;
const anchor = () => Number.parseFloat(block.style.getPropertyValue("--viewport-bottom"));
/** Where the bottom of the block's anchor is on the screen: against the layout viewport, minus how far the visual viewport is panned over it. */
const onScreen = () => anchor() - viewport.offsetTop;

type Step = { height?: number; offsetTop?: number; innerHeight?: number };

/** Moves the visual viewport as one frame of a keyboard animation does: the values change, the browser says so, and the animation frame runs. Returns where the block is. */
function play(step: Step) {
  const resized = step.height !== undefined && step.height !== viewport.height;
  const panned = step.offsetTop !== undefined && step.offsetTop !== viewport.offsetTop;
  if (step.height !== undefined) viewport.height = step.height;
  if (step.offsetTop !== undefined) viewport.offsetTop = step.offsetTop;
  if (step.innerHeight !== undefined) Object.defineProperty(window, "innerHeight", { configurable: true, value: step.innerHeight });
  if (resized) viewport.dispatchEvent(new Event("resize"));
  if (panned) viewport.dispatchEvent(new Event("scroll"));
  // The block is where the events left it until the frame: a pan is followed in the same frame as the event, before anything is drawn.
  const afterEvents = onScreen();
  frame();
  return { afterEvents, afterFrame: onScreen() };
}

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const ramp = (frames: number, to: number, from = 0) => Array.from({ length: frames }, (_, index) => Math.round(from + (to - from) * easeOut((index + 1) / frames)));
const hold = (frames: number): Step[] => Array.from({ length: frames }, () => ({}));

beforeEach(async () => {
  stubBrowser(false);
  const chat = installHarness();
  setInventory([[REPO_A, "pomegr"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
});
afterEach(() => {
  removeHarness();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
});

/** Draws Home on a phone and taps the composer, so the block is in focus mode with the keyboard not yet open. */
async function focusModeOnAPhone() {
  render(<SessionCatalogProvider sessions={[]}><HomeDashboard /></SessionCatalogProvider>);
  await settle();
  await newUser().click(document.getElementById("home-aril-message")!);
  block = screen.getByRole("region", { name: "Ask Aril" });
  expect(block.className).toMatch(/_isFocus_/);
  return block;
}

/** The screen positions of the block over a sequence, one for each frame, and the final one once the frames have run out. */
function positions(steps: readonly Step[], settleFrames = 60) {
  const seen: number[] = [];
  for (const step of [...steps, ...hold(settleFrames)]) {
    const { afterEvents, afterFrame } = play(step);
    seen.push(afterEvents, afterFrame);
  }
  return seen;
}

/** A sequence is one move to the final place when the block never goes above it and never goes back down: every position is at or below the final one, and it only rises. */
function expectOneMoveTo(seen: readonly number[], final: number) {
  expect(Math.min(...seen)).toBeGreaterThanOrEqual(final - 0.5);
  for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeLessThanOrEqual(seen[index - 1] + 0.01);
  expect(seen.at(-1)).toBeCloseTo(final, 0);
}

describe("focus mode on a phone: the block follows the keyboard in one move", () => {
  it("starts at the foot of the screen, with the whole visual viewport", async () => {
    await focusModeOnAPhone();
    expect(onScreen()).toBe(SCREEN);
  });

  it("Android with resizes-visual: many resizes while the keyboard animates, and nothing else", async () => {
    await focusModeOnAPhone();
    const seen = positions(ramp(15, FINAL, SCREEN).map((height) => ({ height, innerHeight: SCREEN })));
    expectOneMoveTo(seen, FINAL);
  });

  it("Android with resizes-visual: one resize with the final height", async () => {
    await focusModeOnAPhone();
    expectOneMoveTo(positions([{ height: FINAL, innerHeight: SCREEN }]), FINAL);
  });

  it("Android with resizes-visual: the browser pans the visual viewport to show the focused field, after the resize and during it", async () => {
    await focusModeOnAPhone();
    const after = positions([...ramp(15, FINAL, SCREEN).map((height) => ({ height })), ...ramp(5, 120).map((offsetTop) => ({ offsetTop }))]);
    expectOneMoveTo(after, FINAL);
    play({ height: SCREEN, offsetTop: 0 });
    for (let index = 0; index < 60; index += 1) frame();
    const during = positions(ramp(15, FINAL, SCREEN).map((height, index) => ({ height, offsetTop: index < 6 ? 0 : ramp(12, 120)[index - 6] })));
    expectOneMoveTo(during, FINAL);
  });

  it("iOS: one resize with the final height, then the visual viewport pans over several frames", async () => {
    await focusModeOnAPhone();
    const seen = positions([{ height: FINAL, innerHeight: SCREEN }, ...ramp(10, 300).map((offsetTop) => ({ offsetTop }))]);
    expectOneMoveTo(seen, FINAL);
  });

  it("a pan alone does not move the block on the screen: it is followed in the frame of the event", async () => {
    await focusModeOnAPhone();
    positions([{ height: FINAL }]);
    const before = onScreen();
    for (const offsetTop of ramp(8, 300)) {
      const { afterEvents, afterFrame } = play({ offsetTop });
      expect(afterEvents).toBeCloseTo(before, 1);
      expect(afterFrame).toBeCloseTo(before, 1);
    }
  });

  it("Android with resizes-content: the layout viewport shrinks with the visual one, and `innerHeight` disagrees for a frame", async () => {
    await focusModeOnAPhone();
    const heights = ramp(15, FINAL, SCREEN);
    // The pair is read the way a browser reports it mid-animation: `innerHeight` a frame behind the height, or a frame ahead of it.
    const behind = positions(heights.map((height, index) => ({ height, innerHeight: heights[index - 1] ?? SCREEN })));
    expectOneMoveTo(behind, FINAL);
    play({ height: SCREEN, innerHeight: SCREEN });
    for (let index = 0; index < 60; index += 1) frame();
    const ahead = positions(heights.map((height, index) => ({ height, innerHeight: heights[index + 1] ?? FINAL })));
    expectOneMoveTo(ahead, FINAL);
  });

  it("never reads `innerHeight`: the same sequence gives the same positions whatever it says", async () => {
    await focusModeOnAPhone();
    const sequence = [...ramp(12, FINAL, SCREEN).map((height) => ({ height })), ...ramp(6, 200).map((offsetTop) => ({ offsetTop }))];
    const quiet = positions(sequence.map((step) => ({ ...step, innerHeight: SCREEN })));
    play({ height: SCREEN, offsetTop: 0, innerHeight: SCREEN });
    for (let index = 0; index < 60; index += 1) frame();
    const noisy = positions(sequence.map((step, index) => ({ ...step, innerHeight: index % 2 === 0 ? 0 : 5000 })));
    expect(noisy).toEqual(quiet);
  });

  it("follows the keyboard back down when it closes, in one move that never goes below the final place", async () => {
    await focusModeOnAPhone();
    positions([{ height: FINAL }]);
    const seen = positions(ramp(10, SCREEN, FINAL).map((height) => ({ height })));
    expect(Math.max(...seen)).toBeLessThanOrEqual(SCREEN + 0.5);
    for (let index = 1; index < seen.length; index += 1) expect(seen[index]).toBeGreaterThanOrEqual(seen[index - 1] - 0.01);
    expect(seen.at(-1)).toBeCloseTo(SCREEN, 0);
  });

  it("is at the final place in the frame of the event under reduced motion, with no ease", async () => {
    stubBrowser(true);
    await focusModeOnAPhone();
    const { afterEvents } = play({ height: FINAL });
    expect(afterEvents).toBe(FINAL);
  });

  it("stops the frames once the block has settled, and starts them again on the next event", async () => {
    await focusModeOnAPhone();
    positions([{ height: FINAL }], 120);
    expect(queue.size).toBe(0);
    play({ height: FINAL + 40 });
    expect(queue.size).toBe(1);
  });

  it("lets go of the visual viewport and of the property when focus mode ends", async () => {
    await focusModeOnAPhone();
    positions([{ height: FINAL }]);
    await newUser().click(screen.getByRole("button", { name: "Back to Home" }));
    expect(block.className).not.toMatch(/_isFocus_/);
    expect(block.style.getPropertyValue("--viewport-bottom")).toBe("");
    expect(queue.size).toBe(0);
    play({ height: SCREEN });
    expect(block.style.getPropertyValue("--viewport-bottom")).toBe("");
  });
});

describe("the block is placed against the visual viewport by the style sheet", () => {
  it("anchors `top` to the custom property, falls back to the foot of the layout viewport, and has neither a `bottom` nor a transition to chase the keyboard", () => {
    const rule = arilCss.match(/\.aril\.isFocus \{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/top: calc\(var\(--viewport-bottom, 100%\) - max\(var\(--space-3\), env\(safe-area-inset-bottom\)\)\);/);
    expect(rule).toMatch(/translate: 0 -100%;/);
    expect(rule).not.toMatch(/(^|[;\s])bottom:/);
    expect(rule).not.toMatch(/--keyboard-inset/);
    expect(rule).toMatch(/transition: none;/);
  });
});
