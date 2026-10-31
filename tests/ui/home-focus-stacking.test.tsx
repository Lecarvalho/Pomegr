import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChat, REPO_A, REPO_B, installHarness, newUser, removeHarness, setInventory, settle } from "./agent-chat-fixture";
import { desktopBridge, resetHome } from "./home-fixture";

// Home's focus mode on a phone: the block of the chips and the composer is fixed to the bottom of the screen, over a layer (`.dim`) that covers the page. jsdom does
// no layout, so the bug that blanked the screen (T-219, found on a paired phone) is guarded by its structural cause, which a browser measurement confirmed:
// a fixed block can never rise above a layer that is outside the stacking context it lives in. The composer's wrapper was a flex item with `z-index: 3`, which
// is a stacking context even while static, so the block (z-index 85) stayed under the layer (z-index 84) and the whole screen was the layer's fill. While the
// entrance animation ran, the wrapper's transform did the same and moved the block off the screen as well.
// The test resolves the declared styles of every ancestor of the block, from the real stylesheets and the real markup, and asserts that none of them makes a stacking
// context or a containing block in focus mode. Two controls strip each half of the fix and must be caught, so the audit is known to see the bug.
// The same change of positioning made the block jump when focus mode ended (T-219, found on the same phone): the block went from fixed to sticky in one frame, and
// the entrance of its wrapper started over, so it vanished for the entrance's delay and faded back in. A browser measurement at 390x844 showed the block at opacity 0
// from 93ms to 343ms after the tap. The second half of this file guards both causes: the block is measured before and after the change and glides between the
// two places with a transform, and the wrapper's entrance never plays twice.
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
import { GLIDE_EASE, GLIDE_MS } from "../../app/components/home/useComposerGlide";
import { SessionCatalogProvider } from "../../app/hooks/SessionCatalogContext";
import { HOME_PREFERENCES_STORAGE_KEY, HOME_UPDATE_ID } from "../../app/hooks/useHomePreferences";

const SCREEN = 390;
const read = (...path: string[]) => readFileSync(join(process.cwd(), ...path), "utf8").replace(/\r\n/g, "\n");
const pageCss = read("app", "HomeDashboard.module.css");
const arilCss = read("app", "components", "home", "HomeAril.module.css");
const shellCss = read("app", "styles", "shell.css");

// ---- A small cascade over the real stylesheets, enough for the selectors of Home and the shell. ----

type Rule = { selector: string; specificity: number; order: number; declarations: Map<string, string> };
type Sheet = { css: string; modules: boolean };

/** Whether an at-rule's condition holds for a phone: widths are measured against a 390px screen, and a user who prefers reduced motion is not the case under test. */
function mediaHolds(condition: string): boolean {
  const max = condition.match(/^\(max-width:\s*(\d+)px\)$/);
  const min = condition.match(/^\(min-width:\s*(\d+)px\)$/);
  if (max) return SCREEN <= Number(max[1]);
  if (min) return SCREEN >= Number(min[1]);
  return false;
}

const topLevelCommas = (selectors: string) => {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < selectors.length; index += 1) {
    if (selectors[index] === "(") depth += 1;
    else if (selectors[index] === ")") depth -= 1;
    else if (selectors[index] === "," && depth === 0) { parts.push(selectors.slice(from, index)); from = index + 1; }
  }
  parts.push(selectors.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
};

function specificityOf(selector: string): number {
  const plain = selector.replace(/:global\(([^)]*)\)/g, "$1");
  const ids = (plain.match(/#[\w-]+/g) ?? []).length;
  const classes = (plain.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!not\(|is\(|where\(|has\(|global\()[\w-]+/g) ?? []).length;
  const bare = plain.replace(/\.[\w-]+|#[\w-]+|\[[^\]]+\]|::?[\w-]+(\([^)]*\))?/g, " ");
  const elements = (bare.match(/[A-Za-z][\w-]*/g) ?? []).length;
  return ids * 10_000 + classes * 100 + elements;
}

function parseRules(sheet: Sheet, rules: Rule[] = []): Rule[] {
  const css = sheet.css.replace(/\/\*[^]*?\*\//g, "");
  const walk = (text: string, active: boolean) => {
    for (let index = 0; index < text.length;) {
      const open = text.indexOf("{", index);
      if (open < 0) break;
      let depth = 1;
      let close = open + 1;
      for (; close < text.length && depth > 0; close += 1) depth += text[close] === "{" ? 1 : text[close] === "}" ? -1 : 0;
      const head = text.slice(index, open).trim();
      const body = text.slice(open + 1, close - 1);
      if (head.startsWith("@media")) walk(body, active && mediaHolds(head.slice("@media".length).trim()));
      else if (!head.startsWith("@") && active) {
        const declarations = new Map<string, string>();
        for (const declaration of body.split(";")) {
          const colon = declaration.indexOf(":");
          if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).replace(/\s*!important\s*$/, "").trim());
        }
        for (const selector of topLevelCommas(head)) rules.push({ selector: toDom(selector, sheet.modules), specificity: specificityOf(selector), order: rules.length, declarations });
      }
      index = close;
    }
  };
  walk(css, true);
  return rules;
}

/** A CSS-module selector for the DOM: `.name` is `_name_<hash>_<line>` in the markup, and `:global(...)` is left as it is written. */
function toDom(selector: string, modules: boolean): string {
  if (!modules) return selector;
  const globals: string[] = [];
  const kept = selector.replace(/:global\(([^)]*)\)/g, (_, inner: string) => `@@${globals.push(inner) - 1}@@`);
  return kept.replace(/\.([A-Za-z_][\w-]*)/g, '[class*="_$1_"]').replace(/@@(\d+)@@/g, (_, index: string) => globals[Number(index)]);
}

/** The value the cascade gives a property of an element: the declaration of the matching rule with the highest specificity, and the last of those. */
function declared(rules: readonly Rule[], element: Element, property: string): string | undefined {
  let winner: Rule | undefined;
  for (const rule of rules) {
    let matches = false;
    try { matches = element.matches(rule.selector); } catch { matches = false; }
    if (!matches || !rule.declarations.has(property)) continue;
    if (!winner || rule.specificity >= winner.specificity) winner = rule;
  }
  return winner?.declarations.get(property);
}

const none = (value: string) => value !== "none";
/** What makes an element a stacking context, or a containing block for a fixed descendant, and the value that does it. */
const CREATES: ReadonlyArray<readonly [string, (value: string) => boolean]> = [
  // A flex item takes its z-index even while it is static, so any z-index counts.
  ["z-index", (value) => value !== "auto"],
  ["position", (value) => value === "fixed" || value === "sticky"],
  ["opacity", (value) => Number(value) < 1],
  ["transform", none], ["translate", none], ["scale", none], ["rotate", none], ["filter", none], ["perspective", none], ["backdrop-filter", none], ["clip-path", none], ["mask", none],
  ["contain", none], ["container-type", (value) => value !== "normal"], ["isolation", (value) => value === "isolate"], ["mix-blend-mode", (value) => value !== "normal"],
  ["will-change", (value) => /transform|opacity|filter|perspective|z-index|translate|scale|rotate/.test(value)],
  // An animation holds its keyframes' properties for as long as it runs, and the entrance transforms the block's wrapper for 660ms.
  ["animation", none],
];

function audit(rules: readonly Rule[], ancestors: readonly Element[]): string[] {
  return ancestors.flatMap((element) => CREATES.flatMap(([property, creates]) => {
    const value = declared(rules, element, property);
    return value !== undefined && creates(value) ? [`${element.tagName.toLowerCase()}.${element.className.toString().replace(/\s+/g, ".")} { ${property}: ${value} }`] : [];
  }));
}

// ---- Home, in focus mode, inside the shell's markup. ----

let chat: FakeChat;
let shell: HTMLElement;
beforeEach(() => {
  chat = installHarness();
  setInventory([[REPO_A, "pomegr"], [REPO_B, "clapline"]]);
  window.localStorage.setItem(HOME_PREFERENCES_STORAGE_KEY, JSON.stringify({ version: 1, pins: [], lastViewedSessionId: null, seenUpdateId: HOME_UPDATE_ID }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new Event("close")); };
  resetHome();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  desktopBridge(chat);
});
afterEach(() => {
  shell?.remove();
  removeHarness();
  vi.restoreAllMocks();
});

/** Draws Home in the shell's markup (`.commandShell > .commandMain`) and answers the composer block and its wrapper. */
async function renderHome() {
  shell = document.createElement("div");
  shell.className = "commandShell";
  const main = document.createElement("main");
  main.className = "commandMain";
  shell.append(main);
  document.body.append(shell);
  render(<SessionCatalogProvider sessions={[]}><HomeDashboard /></SessionCatalogProvider>, { container: main });
  await settle();
  const block = document.querySelector<HTMLElement>('section[aria-label="Ask Aril"]')!;
  return { block, wrapper: block.parentElement! };
}

/** Focuses the composer, and answers the lifted block, the layer, and every ancestor of the block up to the document. */
async function focusModeOnAPhone() {
  const { block } = await renderHome();
  await newUser().click(document.getElementById("home-aril-message")!);
  expect(block.className).toMatch(/_isFocus_/);
  const layer = document.querySelector<HTMLElement>('[class*="_dim_"]')!;
  expect(layer).not.toBeNull();
  const ancestors: Element[] = [];
  for (let element = block.parentElement; element && element !== document.body; element = element.parentElement) ancestors.push(element);
  return { block, layer, ancestors };
}

const rulesOf = (sheets: readonly Sheet[]) => sheets.reduce<Rule[]>((all, sheet) => parseRules(sheet, all), []);
const SHIPPED = [{ css: shellCss, modules: false }, { css: pageCss, modules: true }, { css: arilCss, modules: true }] as const;
const zIndexOf = (rules: readonly Rule[], element: Element) => Number(declared(rules, element, "z-index"));

describe("focus mode on a phone: the fixed block is not trapped under the layer", () => {
  it("has no ancestor that makes a stacking context or a containing block, so the block rises above the layer and stays on the screen", async () => {
    const { block, layer, ancestors } = await focusModeOnAPhone();
    const rules = rulesOf(SHIPPED);
    // The ancestors are the composer's wrapper, the column, the page section, the content area, and the shell: the path the measurement listed.
    expect(ancestors.map((element) => element.tagName.toLowerCase())).toEqual(["div", "div", "section", "main", "div"]);
    expect(audit(rules, ancestors)).toEqual([]);
    // The block is fixed, with no transform of its own, and above the layer that covers the page.
    expect(declared(rules, block, "position")).toBe("fixed");
    expect(declared(rules, block, "transform")).toBe("none");
    expect(declared(rules, layer, "position")).toBe("fixed");
    expect(zIndexOf(rules, block)).toBeGreaterThan(zIndexOf(rules, layer));
    // The layer is a child of the page section, in the same stacking context as the block's wrapper: the layer is not itself inside a stacking context that outranks the block.
    expect(layer.parentElement).toBe(ancestors[2]);
    expect(audit(rules, [layer.parentElement!])).toEqual([]);
  });

  it("keeps the wrapper in the sticky place, with its z-index, while the page is only read, and leaves it in focus mode", async () => {
    const { ancestors } = await focusModeOnAPhone();
    const wrapper = ancestors[0];
    const rules = rulesOf(SHIPPED);
    // In focus mode the wrapper is static with no z-index and no entrance; outside it the same wrapper sticks to the bottom of the screen above the content (z-index 3).
    expect(declared(rules, wrapper, "position")).toBe("static");
    expect(declared(rules, wrapper, "z-index")).toBe("auto");
    expect(declared(rules, wrapper, "animation")).toBe("none");
    wrapper.className = wrapper.className.split(/\s+/).filter((name) => !/_isLifted_/.test(name)).join(" ");
    expect(declared(rules, wrapper, "position")).toBe("sticky");
    expect(declared(rules, wrapper, "z-index")).toBe("3");
    expect(audit(rules, [wrapper])).not.toEqual([]);
  });

  it("is caught by the audit when the wrapper keeps its z-index, as it did when the screen went blank", async () => {
    const { ancestors } = await focusModeOnAPhone();
    const old = ".column .composer.isLifted { position: static; z-index: auto; animation: none; background: none; }";
    expect(pageCss).toContain(old);
    const bug = pageCss.replace(old, ".composer.isLifted { position: static; background: none; }");
    const found = audit(rulesOf([{ css: shellCss, modules: false }, { css: bug, modules: true }, { css: arilCss, modules: true }]), ancestors);
    expect(found.join("\n")).toMatch(/_composer_[^\n]* \{ z-index: 3 \}/);
  });

  it("is caught by the audit when the wrapper keeps its entrance animation, which transforms it and moves the fixed block off the screen for 660ms", async () => {
    const { ancestors } = await focusModeOnAPhone();
    const old = ".column .composer.isLifted { position: static; z-index: auto; animation: none; background: none; }";
    // The entrance is also cut by the mark that it has played, which focus mode sets at the same time, so both take their rule out.
    const played = ".column .composer.isEntered { animation: none; }";
    expect(pageCss).toContain(played);
    const bug = pageCss.replace(old, ".column .composer.isLifted { position: static; z-index: auto; background: none; }").replace(played, "");
    expect(bug).not.toBe(pageCss);
    const found = audit(rulesOf([{ css: shellCss, modules: false }, { css: bug, modules: true }, { css: arilCss, modules: true }]), ancestors);
    expect(found.join("\n")).toMatch(/_composer_[^\n]* \{ animation: homeEnter 420ms/);
    // The entrance keyframes do transform the wrapper, which is why a running animation counts.
    expect(pageCss).toMatch(/@keyframes homeEnter \{ from \{ opacity: 0; transform: translateY\(var\(--space-2\)\); \}/);
  });

  it("is caught by the audit when any other ancestor takes a transform, a filter, or containment", async () => {
    const { ancestors } = await focusModeOnAPhone();
    for (const addition of ["transform: translateZ(0)", "filter: none; contain: paint", "will-change: transform"]) {
      const found = audit(rulesOf([{ css: shellCss, modules: false }, { css: `${pageCss}\n.column { ${addition}; }`, modules: true }, { css: arilCss, modules: true }]), ancestors);
      expect(found, addition).not.toEqual([]);
    }
  });
});

// ---- Entering and leaving focus mode: the block glides between its two places, and its wrapper's entrance does not start over. ----

// jsdom does no layout and has no Web Animations, so the places are stubbed: the composer is at the sticky place until the block takes the focus class, and at
// the focus place after it. The glide must start from the place the composer left, so a measure taken after the change (offset 0) would not start one.
const REST_TOP = 630;
const FOCUS_TOP = 600;
const GLIDE = (from: number, to: number) => [[{ transform: `translate(0px, ${from - to}px)` }, { transform: "none" }], { duration: GLIDE_MS, easing: GLIDE_EASE }] as const;

function stubMedia({ phone, reducedMotion }: { phone: boolean; reducedMotion: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query, matches: (phone && query === "(max-width: 760px)") || (reducedMotion && query === "(prefers-reduced-motion: reduce)"), onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }));
}

describe("focus mode on a phone: the block glides between the sticky place and the focus place", () => {
  let animate: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    stubMedia({ phone: true, reducedMotion: false });
    const measure = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if (!this.classList.contains("agentChatComposer")) return measure.call(this);
      const lifted = /_isFocus_/.test(this.closest('section[aria-label="Ask Aril"]')?.className ?? "");
      const top = lifted ? FOCUS_TOP : REST_TOP;
      return { x: 12, y: top, left: 12, top, right: 378, bottom: top + 100, width: 366, height: 100, toJSON: () => ({}) } as DOMRect;
    });
    animate = vi.fn(() => ({ cancel: vi.fn() }));
    Object.defineProperty(Element.prototype, "animate", { value: animate, configurable: true, writable: true });
  });
  afterEach(() => {
    delete (Element.prototype as { animate?: unknown }).animate;
    vi.unstubAllGlobals();
  });

  it("glides to the focus place when focus mode starts", async () => {
    await focusModeOnAPhone();
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith(...GLIDE(REST_TOP, FOCUS_TOP));
  });

  it.each([
    ["a tap outside", async () => { await newUser().click(document.querySelector<HTMLElement>('[class*="_dim_"]')!); }],
    ["Back to Home", async () => { await newUser().click(screen.getByRole("button", { name: "Back to Home" })); }],
    ["Escape", async () => { await newUser().keyboard("{Escape}"); }],
  ])("glides back from the place it left when focus mode ends with %s, so it does not jump for a frame", async (_, leave) => {
    const { block } = await focusModeOnAPhone();
    animate.mockClear();
    await leave();
    expect(block.className).not.toMatch(/_isFocus_/);
    expect(animate).toHaveBeenCalledTimes(1);
    expect(animate).toHaveBeenLastCalledWith(...GLIDE(FOCUS_TOP, REST_TOP));
  });

  it("does not glide under reduced motion: the block is at its new place at once", async () => {
    stubMedia({ phone: true, reducedMotion: true });
    const { block } = await focusModeOnAPhone();
    await newUser().click(document.querySelector<HTMLElement>('[class*="_dim_"]')!);
    expect(block.className).not.toMatch(/_isFocus_/);
    expect(animate).not.toHaveBeenCalled();
  });

  it("leaves the desktop to its own transition", async () => {
    stubMedia({ phone: false, reducedMotion: false });
    await focusModeOnAPhone();
    await newUser().click(document.querySelector<HTMLElement>('[class*="_dim_"]')!);
    expect(animate).not.toHaveBeenCalled();
  });

  it("moves with the time and the curve of the desktop's shift", () => {
    expect(arilCss).toContain(`transition: transform ${GLIDE_MS}ms ${GLIDE_EASE};`);
  });

  it("never plays the wrapper's entrance a second time when focus mode ends, which made the block vanish and fade back in", async () => {
    const { layer, ancestors } = await focusModeOnAPhone();
    const wrapper = ancestors[0];
    await newUser().click(layer);
    // Back in the sticky place, with the entrance already played (focus mode cut it short).
    expect(wrapper.className).not.toMatch(/_isLifted_/);
    expect(wrapper.className).toMatch(/_isEntered_/);
    const rules = rulesOf(SHIPPED);
    expect(declared(rules, wrapper, "position")).toBe("sticky");
    expect(declared(rules, wrapper, "animation")).toBe("none");
    // Control: without the mark, the entrance applies again, starts over when the lifted class goes, and the wrapper is invisible for its delay.
    wrapper.className = wrapper.className.split(/\s+/).filter((name) => !/_isEntered_/.test(name)).join(" ");
    expect(declared(rules, wrapper, "animation")).toMatch(/^homeEnter 420ms/);
  });

  it("marks the entrance as played when the wrapper's own animation ends, and not when an animation inside it does", async () => {
    const { block, wrapper } = await renderHome();
    // React listens for the prefixed name where the window has no AnimationEvent, as jsdom has none, so both are sent.
    const animationEnd = (element: Element) => { for (const type of ["animationend", "webkitAnimationEnd"]) fireEvent(element, new Event(type, { bubbles: true })); };
    animationEnd(block);
    expect(wrapper.className).not.toMatch(/_isEntered_/);
    animationEnd(wrapper);
    expect(wrapper.className).toMatch(/_isEntered_/);
  });
});
