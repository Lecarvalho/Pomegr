import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskBoard } from "../../shared/task-contract";
import { BOARD_RUNNING } from "../../app/components/design-system/DesignSystemTaskSampleData";
import { SettingsPage } from "../../app/settings/SettingsPage";

// Settings › Aril on a phone (ArilSettingsPhone.dc.html). jsdom does no layout, so the width of the page is guarded in two ways: the paired-device view is
// rendered with its real markup, and the stylesheets that lay it out are read for the rules that keep every element inside a 390px screen. The page was
// broken because a bare `1fr` track grew to the width of the section tabs (628px) and the whole page scrolled sideways; the real widths were measured in a
// browser at 390px before and after (docs/internal/design/settings.md, Settings on a phone).

const { access, current, inventory } = vi.hoisted(() => ({
  access: { mode: "lan" },
  current: { board: null as unknown as TaskBoard },
  inventory: { repositories: [] as { id: string; displayName: string }[] },
}));
vi.mock("../../app/tasks-store", () => ({ useTasks: () => ({ board: current.board, refresh: async () => {} }) }));
vi.mock("../../app/hooks/ClientAccessContext", () => ({ useClientAccess: () => access, clientAccessMode: () => access.mode }));
vi.mock("../../app/repository-inventory-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/repository-inventory-client")>();
  return { ...actual, useRepositoryInventory: () => ({ snapshot: { revision: 1, readiness: "ready", repositories: inventory.repositories }, loading: false, connected: true, refresh: async () => {} }) };
});

const NAMES = ["pomegr", "clapline", "CinePrompt-AI", "Larik-with-a-rather-long-name"];
const asked: string[] = [];

beforeEach(() => {
  current.board = { ...BOARD_RUNNING, aril: { settings: {}, memory: { text: "- Keep messages short.", previous: null, updatedAt: Date.now(), updatedBy: "aril" }, grant: null } } as unknown as TaskBoard;
  inventory.repositories = NAMES.map((displayName, index) => ({ id: `repo-${"abcd"[index].repeat(24)}`, displayName }));
  asked.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const { operation } = JSON.parse(String(init.body)) as { operation: string };
    asked.push(operation);
    const answer = operation === "aril_switch" ? { ok: true, on: true, pairedOn: false }
      : operation === "owner_memory" ? { ok: true, memory: { text: "- Reply in the language I wrote in.", previous: null, updatedAt: Date.now(), updatedBy: "aril" } } : { ok: false, error: "desktop_only" };
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  }));
  (window as Window & { pomegrDesktop?: unknown }).pomegrDesktop = undefined;
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const styles = (name: string) => readFileSync(join(process.cwd(), "app", "styles", name), "utf8").replace(/\r\n/g, "\n");
/** The body of every `@media (max-width: 760px)` block of a stylesheet, found by matching braces. */
function phoneRules(css: string): string {
  const blocks: string[] = [];
  for (let from = css.indexOf("@media (max-width: 760px)"); from >= 0; from = css.indexOf("@media (max-width: 760px)", from + 1)) {
    const open = css.indexOf("{", from);
    let depth = 0;
    let index = open;
    for (; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      else if (css[index] === "}" && (depth -= 1) === 0) break;
    }
    blocks.push(css.slice(open + 1, index));
  }
  return blocks.join("\n");
}
const rule = (css: string, selector: string) => css.split("\n").find((line) => line.trim().startsWith(`${selector} {`)) ?? "";

describe("Settings › Aril on a phone, in the paired-device view", () => {
  it("draws the section tabs in their own strip, the cards in one column, and the key note, and asks the desktop for no space and no key", async () => {
    render(<SettingsPage initialSection="aril" />);
    await waitFor(() => expect(asked).toContain("aril_switch"));
    const tabs = screen.getByRole("tablist", { name: "Settings sections" });
    expect(tabs).toHaveClass("commandSettingsNav");
    const panel = screen.getByRole("tabpanel", { name: "Aril" });
    // The page is one column of cards: the top card, the memory with its own strip of tabs, and the key note; the conversation space is the desktop's.
    const headings = within(panel).getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Aril", "Memory", "Effort routing"]);
    const memoryTabs = await within(panel).findByRole("tablist", { name: "Memory" });
    expect(memoryTabs).toHaveClass("arilTabs");
    expect(within(memoryTabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["You", ...NAMES]);
    expect(within(panel).getByText("The key is changed in the desktop app.")).toBeInTheDocument();
    expect(within(panel).queryByText(/in all\./u)).toBeNull();
    expect(asked).not.toContain("thread_space");
    // The switch stays in the top card, after the text, and the paired-device row of the desktop app is not drawn on a phone.
    const hero = panel.querySelector(".arilHero") as HTMLElement;
    expect(hero.querySelector(".arilHeroMain")?.lastElementChild).toBe(within(hero).getByRole("switch", { name: "Let Aril act" }));
    expect(hero.querySelector(".arilHeroRow")).toBeNull();
  });

  it("keeps every track and every strip of the page inside a 390px screen, and every control at 44px", () => {
    const shell = phoneRules(styles("shell.css"));
    const aril = phoneRules(styles("settings-aril.css"));
    // No track is a bare 1fr: it would grow to the width of its content. The Settings layout and every grid of the phone use minmax(0, …).
    const ofSettings = (css: string) => css.split("\n").filter((line) => /\.(?:commandSettings|commandSettingRow|providerSetting|storageSettings|aril)/.test(line)).join("\n");
    for (const css of [ofSettings(shell), aril]) for (const [, tracks] of css.matchAll(/grid-template-columns:\s*([^;}]+)/g)) expect(tracks.replace(/minmax\([^)]*\)/g, ""), tracks).not.toMatch(/\b1fr\b/);
    expect(rule(shell, ".commandSettingsLayout")).toContain("grid-template-columns: minmax(0, 1fr);");
    // The tabs of Settings scroll in their own strip, and the tabs of the memory scroll in theirs.
    expect(rule(shell, ".commandSettingsNav")).toMatch(/min-width: 0; overflow-x: auto;/);
    expect(rule(shell, ".commandSettingsNav button")).toMatch(/flex: 0 0 auto; min-height: 44px;/);
    expect(rule(shell, ".commandSettingsPane")).toMatch(/min-width: 0;/);
    expect(styles("settings-aril.css")).toMatch(/\.arilTabs \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/);
    expect(rule(aril, ".arilTabs")).toMatch(/flex: 1 1 100%; min-width: 0;/);
    // Cards, the switch card, and the paired row can shrink, so their text wraps instead of widening the page.
    expect(rule(aril, ".arilSettings, .arilHero, .arilCard, .arilBelow")).toContain("min-width: 0;");
    expect(rule(aril, ".arilHeroMain")).toContain("align-items: flex-start;");
    expect(rule(aril, ".arilHeroRow > :first-child")).toContain("min-width: 0;");
    // A conversation stacks: the name with Flush oldest, a full-width bar, then the size.
    expect(rule(aril, ".arilSpaceRow")).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(rule(aril, ".arilSpaceBar")).toContain("grid-column: 1 / -1;");
    expect(rule(aril, ".arilSpaceSize")).toContain("grid-column: 1 / -1;");
    // Every control reaches 44px.
    for (const [css, selector] of [
      [shell, ".commandSettingsNav button"], [aril, ".arilTab"], [aril, ".arilSpaceAction"], [aril, ".arilCardAside .commandSelectTrigger"],
      [aril, ".arilSpaceAsk .commandSecondaryAction, .arilSpaceAsk .commandQuietAction"], [aril, ".arilGrantLine .commandSecondaryAction"],
    ] as const) expect(rule(css, selector), selector).toContain("min-height: 44px;");
    expect(rule(aril, ".arilEffortRow .commandSecondaryAction, .arilEffortRow .commandQuietAction, .arilEffortKey .commandSecondaryAction, .arilEffortKey .commandQuietAction, .arilEffortKey input")).toContain("min-height: 44px;");
    // The small switch is 20px high, so its hit area reaches 12px above and below it; the large one is 24px high, with 10px.
    expect(styles("command-switch.css")).toMatch(/\.commandSwitch\.isSmall::after \{ inset: -12px -6px; \}/);
  });
});
