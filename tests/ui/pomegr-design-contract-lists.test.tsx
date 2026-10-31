import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Tasks home (the totals, Needs you, the board cards) and the Repositories list (the repository cards): their styles use tokens only, they
// reflow to one column on a phone with 44px targets and nothing wider than the window, they honor reduced motion, and the design contract documents them.
const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const designPages = join(root, "docs", "internal", "design");
const contract = [join(root, "DESIGN.md"), ...readdirSync(designPages).sort().map((name) => join(designPages, name))].map((path) => readFileSync(path, "utf8")).join("\n");
const overview = read("app", "components", "tasks", "TasksOverview.module.css");
const cards = read("app", "components", "repositories", "RepositoryCards.module.css");
const tasksCss = read("app", "styles", "tasks.css");
const workspaceCss = read("app", "styles", "workspace.css");
const phone = (css: string) => css.slice(css.indexOf("@media (max-width: 760px)"));

describe.each([["the Tasks overview", overview], ["the repository cards", cards]])("%s styles", (_name, css) => {
  it("use tokens only: no literal color, no off-scale radius, no off-ramp font size", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(css).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    // Controls and panels have their radius; a dot and a circle are round; the end of a bar is the control radius; a square swatch has none.
    for (const [, radius] of css.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^(?:var\(--(?:control|panel)-radius\)|50%|0|var\(--control-radius\) var\(--control-radius\) 0 0)$/);
  });

  it("keep every fixed width within a 390px window", () => {
    for (const [, width] of css.matchAll(/(?<![-\w])(?:min-)?width:\s*(\d+)px/g)) expect(Number(width)).toBeLessThanOrEqual(390);
  });

  it("stop their motion under reduced motion", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.enter, \.pulse \{ animation: none; \}/);
    expect(reduced).toMatch(/transition: none/);
    // Nothing moves in a way that carries meaning: every animation is the entrance or the pulse.
    expect([...css.matchAll(/(?<![-\w])animation:\s*(\w+)/g)].map(([, name]) => name).filter((name) => name !== "none").every((name) => /Enter$|Pulse$/.test(name))).toBe(true);
  });
});

describe("the Tasks overview layout", () => {
  it("fades its blocks in once, 60ms apart, and draws Needs you and the cards in two columns that fall to one on a phone", () => {
    expect(overview).toMatch(/\.enter \{ animation: overviewEnter 420ms cubic-bezier\(\.2, \.8, \.2, 1\) backwards; animation-delay: calc\(var\(--enter, 0\) \* 60ms\); \}/);
    expect(overview).toMatch(/\.overview \.needsList \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
    expect(overview).toMatch(/\.grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: var\(--space-3\); \}/);
    expect(overview).toMatch(/\.quietGrid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(phone(overview)).toMatch(/\.overview \.needsList, \.grid, \.quietGrid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  });

  it("shares Home's card for Needs you rather than copying it", () => {
    const source = read("app", "components", "tasks", "TasksOverviewNeeds.tsx");
    expect(source).toContain('import card from "../home/HomeCard.module.css"');
    expect(source).toContain('import needs from "../home/HomeNeedsYou.module.css"');
    expect(overview).not.toMatch(/\.glyph|\.item \{|\.closing \{/);
  });

  it("draws the flow bar at 10px on the raised fill, and the five stage colors from tokens", () => {
    expect(overview).toMatch(/\.flow \{ display: flex; gap: 2px; height: 10px; overflow: hidden; border-radius: var\(--control-radius\); background: var\(--command-panel-2\); \}/);
    expect(overview).toMatch(/\.segment \{[^}]*background: var\(--tone\); transition: width 520ms cubic-bezier\(\.2, \.8, \.2, 1\); \}/);
    for (const [tone, token] of [["Backlog", "--command-line-strong"], ["Ready", "--command-lavender"], ["Progress", "--command-brand-text"], ["Review", "--command-amber"], ["Done", "--command-green"]]) {
      expect(overview).toContain(`.tone${tone} { --tone: var(${token}); }`);
    }
    expect(overview).toMatch(/\.counts \{ display: grid; grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
    expect(overview).toMatch(/\.count\.isZero \{ color: color-mix\(in srgb, var\(--command-muted\) 75%, var\(--command-panel\)\); font-weight: 400; \}/);
  });

  it("reaches 44px targets on a phone and a touch screen, wraps the foot, and keeps the counts on one line", () => {
    const small = phone(overview);
    expect(small).toMatch(/\.open \{ min-height: 44px; \}/);
    expect(small).toMatch(/\.retry, \.newTask \{ min-height: 44px; \}/);
    expect(small).toMatch(/\.foot \{ flex-wrap: wrap;/);
    expect(small).toMatch(/\.now \{ flex-basis: 100%; \}\s*\.nowText \{ white-space: normal; \}/);
    expect(small).toMatch(/\.counts \{ gap: var\(--space-1\); \}/);
    expect(small).toMatch(/\.totalsBlock \{ align-items: flex-start; width: 100%; \}/);
    expect(small).toMatch(/\.needTitle \{[^}]*-webkit-line-clamp: 2;[^}]*white-space: normal;/);
    expect(overview).toMatch(/@media \(pointer: coarse\) \{\s*\.open, \.retry, \.newTask \{ min-height: 44px; \}/);
    // A stage name wraps rather than truncates.
    expect(overview).toMatch(/\.countCell dt \{[^}]*overflow-wrap: anywhere; \}/);
    expect(overview).not.toMatch(/\.countCell dt \{[^}]*text-overflow/);
  });

  it("keeps the page's clearance for the Aril launcher and has none of the old table", () => {
    expect(tasksCss).toMatch(/@media \(max-width: 760px\) \{\s*\/\*[^*]*\*\/\s*\.taskHome \{ padding-bottom: calc\(44px/);
    expect(tasksCss).not.toMatch(/taskHomeTable|taskHomeNeed|taskHomeBoardLink|taskHomeCount/);
    expect(read("app", "components", "tasks", "TasksHome.tsx")).not.toMatch(/<table|<thead|<tr\b/);
  });
});

describe("the repository cards layout", () => {
  it("draws two columns that fall to one on a phone, and a card that the name link covers", () => {
    expect(cards).toMatch(/\.grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: var\(--space-3\);/);
    expect(phone(cards)).toMatch(/\.grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(cards).toMatch(/\.nameLink::after \{ content: ""; position: absolute; inset: 0;/);
    expect(cards).toMatch(/\.fix \{ position: relative; z-index: 1;/);
    expect(cards).toMatch(/\.card:has\(\.nameLink:focus-visible\) \{ outline: 2px solid var\(--focus-ring\);/);
  });

  it("draws the bars 36px high with a 3px gap, from the raised fill, the control line, and green", () => {
    expect(cards).toMatch(/\.bars \{ display: flex; align-items: flex-end; gap: 3px; height: 36px; \}/);
    expect(cards).toMatch(/\.bar\.isEmpty \{ background: var\(--command-panel-2\); \}/);
    expect(cards).toMatch(/\.bar\.isLive \{ background: var\(--command-green\); \}/);
  });

  it("draws the setup badge on soft fills and the fix line in amber", () => {
    expect(cards).toMatch(/\.setupReady \{ background: var\(--color-green-soft\); color: var\(--command-green\); \}/);
    expect(cards).toMatch(/\.setupUnverified \{ background: var\(--command-panel-2\); color: var\(--command-muted\); \}/);
    expect(cards).toMatch(/\.setupOff \{ background: var\(--color-amber-soft\); color: var\(--command-amber\); \}/);
    expect(cards).toMatch(/\.fix \{[^}]*background: var\(--color-amber-soft\); color: var\(--command-amber\);/);
  });

  it("makes the fix link a 44px target and lets the fix line and the facts wrap on a phone", () => {
    const small = phone(cards);
    expect(small).toMatch(/\.fix \{ flex-wrap: wrap; \}/);
    expect(small).toMatch(/\.fixLink \{ display: inline-flex; align-items: center; min-height: 44px; \}/);
    expect(small).toMatch(/\.facts \{ flex-wrap: wrap;/);
    expect(cards).toMatch(/@media \(pointer: coarse\) \{\s*\.fixLink \{[^}]*min-height: 44px;/);
  });

  it("keeps the toolbar's search and filters at 44px on a phone, and the old list and its note are gone", () => {
    const small = phone(workspaceCss.slice(workspaceCss.indexOf("  .commandRepositoryToolbar .commandToolbarCount")));
    expect(workspaceCss).toMatch(/\.commandRepositoryFilters \{ min-width: 0; display: flex; gap: 4px; padding: 3px; border-radius: var\(--panel-radius\); background: var\(--command-panel\); \}/);
    expect(workspaceCss).toMatch(/\.commandRepositoryToolbar \.commandFilterChip \{ min-height: 30px;/);
    expect(workspaceCss).toMatch(/\.commandRepositoryToolbar \.commandFilterChip\[aria-pressed="true"\] \{[^}]*background: var\(--command-panel-2\);/);
    expect(workspaceCss).toMatch(/\.commandRepositoryToolbar \.commandFilterChip \{ flex: 1 0 auto; min-width: 44px; min-height: 44px;/);
    expect(workspaceCss).toMatch(/\.commandRepositoryToolbar \.commandSearch \{ min-height: 44px; \}/);
    expect(small).toBeTruthy();
    expect(workspaceCss).not.toMatch(/commandRepositoryRow|commandRepositoryHead|commandRepositoryFootnote|commandRepositoryList\b|commandRepositoryIdentity/);
    expect(read("app", "components", "repositories", "RepositoryInventoryView.tsx")).not.toMatch(/Rows reflect session associations|<table/);
  });
});

describe("the design contract", () => {
  it("documents the Tasks overview: the totals, Needs you on Home's card, the flow bar, the queue switch, the moving line, and the compact rows", () => {
    expect(contract).toMatch(/Open\*\* is every task that is not Done: the Backlog, Ready, In progress, and Review columns/);
    expect(contract).toMatch(/shares `HomeCard\.module\.css` and `HomeNeedsYou\.module\.css` with \[Home\]/);
    expect(contract).toMatch(/never under 1\.5%/);
    expect(contract).toMatch(/sends the action the Board's \[queue switch\]\(#queue-switch\) sends, `queue_settings` with `\{ on \}`/);
    expect(contract).toMatch(/It names no task: the Tasks home carries no title or ID of a task that is running\./);
    expect(contract).toMatch(/\*\*\+ New task\*\* is a Quiet action\. It opens the same new-task dialog the Board's first lane opens/);
    expect(contract).toMatch(/Nothing is wider than the window at 390px\./);
  });

  it("documents the repository cards: the tile, the providers, the 14 bars, the badge map, the fix lines, and that the note is gone", () => {
    expect(contract).toMatch(/The monitor sends the 14 counts with the repository/);
    expect(contract).toMatch(/Without a series from the monitor, no bars are drawn\./);
    expect(contract).toMatch(/\| \*\*Reporting off\*\* \| Amber soft, amber \| Plugin not installed, Plugin disabled, Reporting invalid, Reporting not configured \|/);
    expect(contract).toMatch(/The Needs attention filter is unchanged/);
    expect(contract).toMatch(/The page has no note under the cards\./);
  });

  it("names the one exception to lavender, and routes the new files to their owner pages", () => {
    expect(contract).toMatch(/the Ready segment of a board's flow bar on the Tasks home, and the Codex circle on a repository card/);
    const workflow = read("docs", "internal", "development", "agent-workflow.md");
    for (const file of ["TasksOverviewBoards.tsx", "tasks-overview-model.ts", "RepositoryCard.tsx", "repository-card-model.ts", "repository-daily-sessions.mjs", "pomegr-design-contract-lists"]) expect(workflow).toContain(file);
    expect(read("docs", "internal", "architecture", "observation-cache.md")).toMatch(/Each repository row carries `dailySessions`/);
  });
});
