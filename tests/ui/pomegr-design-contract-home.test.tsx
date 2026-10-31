import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAUSE_WORDS } from "../../app/components/home/home-model";
import { HOME_SUGGESTIONS } from "../../app/components/agent-chat/agent-chat-presentation";
import { TASK_QUEUE_PAUSE_REASONS } from "../../shared/task-contract";

// Home: one centered column, Needs you, the running sessions, the composer with its suggestion chips and its focus mode, and the design contract that
// documents them. The contract is the root file and one page for each surface, read as one text.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");
const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const chatStyles = readFileSync(join(process.cwd(), "app", "styles", "agent-chat.css"), "utf8");
const tokens = readFileSync(join(process.cwd(), "app", "styles", "tokens.css"), "utf8");
const homeComponents = join(process.cwd(), "app", "components", "home");
const read = (name: string) => readFileSync(join(homeComponents, name), "utf8");
const chat = (name: string) => readFileSync(join(process.cwd(), "app", "components", "agent-chat", name), "utf8");
const pageStyles = readFileSync(join(process.cwd(), "app", "HomeDashboard.module.css"), "utf8");
// The What's new dialog keeps its documented backdrop; every other Home style uses tokens only.
const tokenOnly = ["HomeAril.module.css", "HomeCard.module.css", "HomeContinue.module.css", "HomeDayTiles.module.css", "HomeNeedsYou.module.css"].map(read).join("\n") + pageStyles;

describe("Home visual contract", () => {
  it("draws Home with tokens only: no literal color, off-scale radius, or off-ramp font size", () => {
    expect(tokenOnly).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(tokenOnly).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    // A state dot is round, as the provider status dot is; everything else is a control or a panel.
    for (const [, radius] of tokenOnly.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^(?:var\(--(?:control|panel)-radius\)|50%)$/);
    // The What's new card has no literal color either; only the dialog keeps its documented backdrop.
    const update = read("HomeUpdateCard.module.css");
    expect([...update.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(([color]) => color)).toEqual(["#0008"]);
    expect(designContract).toMatch(/The backdrop is `#0008`, the same scrim as the phone agent-filter sheet/);
  });

  it("lays Home out as one column of at most 820px, centered in the content area, with the composer as its last block and pinned to the bottom on a phone", () => {
    expect(pageStyles).toMatch(/\.home \{ display: flex; flex-direction: column; min-height: 100%;/);
    // The auto margins center the column while there is room and fall to nothing when it is taller than the window.
    expect(pageStyles).toMatch(/\.column \{ display: flex; flex-direction: column; flex: 0 1 auto; gap: var\(--space-6\); width: min\(820px, 100%\); min-width: 0; margin: auto; \}/);
    expect(pageStyles).toMatch(/\.column\.isPending \{ visibility: hidden; \}/);
    expect(pageStyles).toMatch(/\.composer \{ min-width: 0; margin-top: var\(--space-2\); \}/);
    expect(pageStyles).toMatch(/\.home h1 \{ min-height: 1\.25em; \}/);
    expect(pageStyles).not.toMatch(/\.status|providerStatus/);
    // Two cards side by side, one when nothing waits, and stacked on a phone.
    expect(pageStyles).toMatch(/\.cards \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: var\(--space-3\);/);
    expect(pageStyles).toMatch(/\.cards\.isSingle \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    const phone = pageStyles.slice(pageStyles.indexOf("@media (max-width: 760px)"));
    expect(phone).toMatch(/\.column \{ flex: 1 1 auto; margin: 0 auto; \}/);
    expect(phone).toMatch(/\.cards \{ grid-template-columns: minmax\(0, 1fr\); \}/);
    expect(phone).toMatch(/\.composer \{ position: sticky; bottom: 0;[^}]*margin-top: auto;[^}]*env\(safe-area-inset-bottom\)/);
    expect(phone).toMatch(/\.composer\.isLifted \{ position: static; background: none; \}/);
    // The column keeps one reading order: the header, the tiles, the cards (Needs you, then Continue), the What's new card, and the composer.
    const source = readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8");
    const order = ["<CommandPageHeader", "<HomeDayTiles", "<HomeNeedsYou", "<HomeContinue", "<HomeUpdateCard", "<HomeAril suggestions"].map((part) => source.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(source).not.toMatch(/Session coach|On the horizon|Understand your sessions|Open conversation|ProviderStatus|provider-status/);
  });

  it("fades the blocks in one after another when Home is first drawn, once, and never under reduced motion", () => {
    expect(pageStyles).toMatch(/\.column:not\(\.isPending\) \.enter \{ animation: homeEnter 420ms cubic-bezier\(\.2, \.8, \.2, 1\) backwards; animation-delay: calc\(var\(--enter, 0\) \* 60ms\); \}/);
    expect(pageStyles).toMatch(/@keyframes homeEnter \{ from \{ opacity: 0; transform: translateY\(var\(--space-2\)\); \} to \{ opacity: 1; transform: none; \} \}/);
    expect(pageStyles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.column:not\(\.isPending\) \.enter \{ animation: none; \}/);
    // Home waits for the boards, the logs, the sessions, the preferences, and the switch before it draws, and gives up waiting after 1.5 seconds.
    const source = readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8");
    expect(source).toContain("const REVEAL_LIMIT_MS = 1_500;");
    expect(source).toMatch(/const answered = !settling && ready && \(!aril \|\| arilSwitch !== null\);/);
    expect(source).toMatch(/if \(!revealed && \(answered \|\| overdue\)\) setRevealed\(true\);/);
  });

  it("draws the date line above the greeting in the owner's locale, and the mark of the tiles at the end of the header", () => {
    const source = readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8");
    expect(source).toContain('new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" })');
    expect(source).toMatch(/breadcrumb=\{<span className=\{styles\.date\}>\{date\}<\/span>\} title=\{greeting\}/);
    expect(source).toMatch(/actions=\{day !== null \? <HomeDayMark \/> : undefined\}/);
    expect(pageStyles).toMatch(/\.date \{ color: var\(--command-muted\); font: 500 var\(--text-caption\)\/1\.4 var\(--font-ui\); letter-spacing: \.06em; text-transform: uppercase; \}/);
    // The tiles come from the task logs, so they do not depend on the switch: no part of the tiles reads it.
    expect(source).toMatch(/const day = useMemo\(\(\) => \(aril && home\.readiness === "ready" && !logs\.reading \? dayCounts/);
  });

  it("draws the last 24 hours as four tiles, with a zero in quiet ink, Marked Done in green, and the short labels in one row on a phone", () => {
    const tiles = read("HomeDayTiles.module.css");
    expect(tiles).toMatch(/\.tiles \{ display: flex; gap: var\(--space-3\);/);
    expect(tiles).toMatch(/\.tile \{[^}]*border: 1px solid var\(--command-panel-2\); border-radius: var\(--panel-radius\); background: var\(--command-panel\); \}/);
    expect(tiles).toMatch(/\.number \{[^}]*font: 650 var\(--text-title\)\/1\.1 var\(--font-ui\);/);
    expect(tiles).toMatch(/\.number\.zero \{ color: var\(--command-muted\); \}/);
    expect(tiles).toMatch(/\.number\.done \{ color: var\(--command-green\); \}/);
    expect(tiles).toMatch(/\.short \{ display: none; \}/);
    expect(tiles).toMatch(/@media \(max-width: 760px\) \{[^@]*\.tiles \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^@]*\.number \{ font-size: var\(--text-heading\); \}[^@]*\.short \{ display: inline; \}/);
    expect(read("HomeDayTiles.tsx")).toContain("Last 24 hours");
    expect(read("HomeDayTiles.tsx")).toContain("Some logs could not be read.");
  });

  it("draws Needs you as a card with a count badge, a rounded item for each line, and a closing line, with a failure in amber and no task ID and no title", () => {
    const needs = read("HomeNeedsYou.module.css");
    const card = read("HomeCard.module.css");
    expect(card).toMatch(/\.card \{[^}]*min-height: 196px;[^}]*border: 1px solid var\(--command-panel-2\); border-radius: var\(--panel-radius\); background: var\(--command-panel\);/);
    // No rule runs between rows, and a row takes the raised fill on hover.
    expect(card).not.toMatch(/\.(?:list|item)[^{]*\{[^}]*border-(?:top|bottom|block)/);
    expect(card).toMatch(/\.item \{[^}]*min-height: 44px;[^}]*border-radius: var\(--panel-radius\);/);
    expect(card).toMatch(/\.item:hover \{ background: var\(--command-panel-2\); \}/);
    expect(card).toMatch(/\.closing \{ display: flex; align-items: center; gap: var\(--space-2\); margin-top: auto;/);
    expect(card).toMatch(/@media \(max-width: 760px\) \{\s*\.card \{ min-height: 0;/);
    expect(needs).toMatch(/\.count \{[^}]*background: var\(--color-amber-soft\); color: var\(--command-amber\);/);
    expect(needs).toMatch(/\.glyph \{[^}]*width: 32px; height: 32px; border-radius: var\(--panel-radius\); background: var\(--color-amber-soft\); color: var\(--command-amber\); \}/);
    expect(needs).toMatch(/\.urgent \{ color: var\(--command-amber\); \}/);
    expect(needs).toMatch(/\.detail \{ color: var\(--command-muted\); \}/);
    expect(needs).toMatch(/\.repository \{[^}]*color: var\(--command-muted\); font-size: var\(--text-caption\);/);
    expect(needs).toMatch(/@media \(max-width: 760px\) \{[^@]*\.needs \.closing \{ display: none; \}/);
    // Amber is the badge, the glyph tile, and the failure word of a line; the line type carries no task or title at all.
    expect(needs.match(/var\(--command-amber\)/g)).toHaveLength(3);
    expect(read("HomeNeedsYou.tsx")).not.toMatch(/taskId|\.title|<h3|<button/);
    expect(read("HomeNeedsYou.tsx")).toContain("Nothing else is waiting on you.");
    expect(read("home-model.ts")).toMatch(/export type NeedsLine = \{ key: string; kind: NeedsKind; action: string; detail: NeedsDetail \| null; repository: string; href: string \};/);
  });

  it("draws a running session as a dot that pulses while it works, a title of two lines at most, the state, and the place, with amber only for a session that waits", () => {
    const styles = read("HomeContinue.module.css");
    expect(styles).toMatch(/\.dot \{ flex: 0 0 auto; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; \}/);
    expect(styles).toMatch(/\.dotWorking \{ background: var\(--command-green\); animation: dotPulse 1\.8s infinite; \}/);
    expect(styles).toMatch(/@keyframes dotPulse \{\s*0% \{ box-shadow: 0 0 0 0 color-mix\(in srgb, var\(--command-green\) 40%, transparent\); \}\s*70% \{ box-shadow: 0 0 0 7px color-mix\(in srgb, var\(--command-green\) 0%, transparent\); \}/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.dotWorking \{ animation: none; \}/);
    expect(styles).toMatch(/\.dotWaiting \{ background: var\(--command-amber\); \}/);
    expect(styles).toMatch(/\.sessionTitle \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;/);
    expect(styles).toMatch(/\.state \{ color: var\(--command-green\); \}/);
    expect(styles).toMatch(/\.waiting \{ color: var\(--command-amber\); \}/);
    expect(styles).toMatch(/\.meta \{ color: var\(--command-muted\); \}/);
    // The closing line is the pin action; it replaces Add pins.
    expect(styles).toMatch(/\.pinDisclosure > summary \{[^}]*min-height: 44px;[^}]*border-radius: var\(--panel-radius\);/);
    expect(read("HomeContinue.tsx")).toContain("Pin a session to keep it here");
    expect(read("HomeContinue.tsx")).not.toContain("Add pins");
    expect(styles).toMatch(/\.pinned \{[^}]*color: var\(--command-muted\); font: 400 var\(--text-xs\)\/1\.4 var\(--font-ui\); \}/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{\s*\/\*[^*]*\*\/\s*\.continue \.headLink \.long \{ display: none; \}/);
    expect(styles).toMatch(/\.removePin \{[^}]*opacity: 0; \}/);
    expect(styles).toMatch(/\.pinList > li:hover \.removePin, \.pinList > li:focus-within \.removePin \{ opacity: 1; \}/);
    expect(read("HomeContinue.tsx")).toContain('session.waiting ? "Waiting for you" : "Working"');
  });

  it("draws the What's new card horizontal, with a thumbnail of a small fixed size on the left, the text beside it, and one compact row on a phone", () => {
    const styles = read("HomeUpdateCard.module.css");
    expect(styles).toMatch(/\.card \{\s*position: relative;\s*display: flex;\s*align-items: center;\s*gap: 16px;[^}]*border: 1px solid var\(--command-panel-2\);\s*border-radius: var\(--panel-radius\);\s*background: var\(--command-panel\);/);
    expect(styles).not.toMatch(/border-inline-start: 3px/);
    expect(styles).toMatch(/--thumb-width: 120px;\s*--thumb-height: 72px;\s*--thumb-scale: \.26;\s*--thumb-offset: 7px 0 0 7px;/);
    expect(styles).toMatch(/\.thumbnail \{ flex-shrink: 0; width: var\(--thumb-width\); height: var\(--thumb-height\); overflow: hidden; border: 1px solid var\(--command-line\); border-radius: var\(--control-radius\); background: var\(--command-panel-2\); \}/);
    expect(styles).toMatch(/\.thumbnail > div \{ width: 408px; margin: var\(--thumb-offset\); transform: scale\(var\(--thumb-scale\)\); transform-origin: top left; \}/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[^@]*\.card \{ --thumb-width: 64px; --thumb-height: 48px; --thumb-scale: \.14; --thumb-offset: 4px 0 0 3px;/);
    // The Secondary action is stretched over the whole row, the summary is left to the dialog, and the dismiss keeps its own target above it.
    expect(styles).toMatch(/\.content p \{ display: none; \}/);
    expect(styles).toMatch(/\.open \{ position: absolute; inset: 0; z-index: 0;/);
    expect(styles).toMatch(/\.chevron \{ display: block;/);
    expect(styles).toMatch(/\.dismiss \{ position: relative; inset: auto; z-index: 1; \}/);
    expect(styles).not.toMatch(/\.thumbnail \{ display: none; \}/);
    // The thumbnail comes first in the card, then the text, the Secondary action, and the dismiss; the card shows the summary.
    const card = read("HomeUpdateCard.tsx");
    const order = ["styles.thumbnail", "styles.content", "{summary}", "commandSecondaryAction", "commandIconAction"].map((part) => card.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8")).toContain('summary="Under a grant, Aril starts, reviews, and merges tasks within limits you set."');
  });

  it("moves in focus mode with the documented durations and curve, takes the overlay shadow once lifted, and stops moving under reduced motion", () => {
    const aril = read("HomeAril.module.css");
    expect(aril).toMatch(/\.aril \{ position: relative; z-index: 3; display: flex; flex-direction: column; gap: var\(--space-3\); min-width: 0; transition: transform 480ms cubic-bezier\(\.2, \.8, \.2, 1\); \}/);
    expect(aril).toMatch(/\.aril\.isFocus, \.aril\.isThread \{ transform: translateY\(var\(--focus-shift, 0px\)\); \}/);
    expect(aril).toMatch(/\.aril\.isFocus :global\(\.agentChatComposer\) \{ box-shadow: var\(--command-overlay-shadow\); \}/);
    expect(aril).toMatch(/\.hint \{ position: absolute; inset-inline: 0; top: 100%;[^}]*font: 400 var\(--text-caption\)\/1\.4 var\(--font-ui\);[^}]*transition: opacity 280ms ease; \}/);
    expect(aril).toMatch(/\.chipBlock \{ display: grid; grid-template-rows: 1fr; transition: grid-template-rows 300ms ease, opacity 220ms ease; \}/);
    expect(aril).toMatch(/\.chipInner \{ min-height: 0; overflow: hidden; \}/);
    expect(aril).toMatch(/\.isThread \.chipBlock \{ grid-template-rows: 0fr; opacity: 0; pointer-events: none; \}/);
    expect(aril).not.toMatch(/max-height/);
    expect(aril).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.aril, \.aril :global\(\.agentChatComposer\), \.chipBlock, \.hint \{ transition: none; \}/);
    expect(pageStyles).toMatch(/\.content \{[^}]*transition: opacity 280ms ease, transform 280ms ease; \}/);
    expect(pageStyles).toMatch(/\.content\.isHidden \{ opacity: 0; transform: translateY\(-10px\); pointer-events: none; \}/);
    expect(pageStyles).toMatch(/\.dim \{ position: fixed; z-index: 2; inset: var\(--command-header-height\) 0 0 var\(--command-rail-width\); \}/);
    expect(pageStyles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.content \{ transition: none; \}/);
    // The shadow belongs to the launcher and to the lifted composer; no other rule of the chat or of Home takes it, but the What's new dialog.
    for (const [file, css] of [["Home", tokenOnly], ["chat", chatStyles]] as const) {
      const shadowed = [...css.replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*box-shadow: var\(--command-overlay-shadow\)/g)].map(([, selector]) => selector.trim());
      expect(shadowed, file).toEqual(file === "Home" ? [".aril.isFocus :global(.agentChatComposer)"] : [".agentChatLauncher"]);
    }
    // On a phone, focus mode fills the screen, and the block sits above the keyboard.
    expect(pageStyles).toMatch(/@media \(max-width: 760px\) \{[^@]*\.dim \{ z-index: 84; inset: 0; background: var\(--command-ground\); \}/);
    expect(aril).toMatch(/\.aril\.isFocus \{ position: fixed; z-index: 85; inset-inline: var\(--space-3\); bottom: calc\(var\(--keyboard-inset, 0px\) \+ max\(var\(--space-3\), env\(safe-area-inset-bottom\)\)\); transform: none; \}/);
    expect(aril).toMatch(/\.hint \{ display: none; \}\s*\.aril\.isFocus \.back \{ display: inline-flex; align-self: flex-start; \}/);
  });

  it("fades the messages of a panel opened from Home in one after another, and settles its composer with the same curve", () => {
    expect(chatStyles).toMatch(/\.agentChatPanel\.isEntering \.agentChatLog > \* \{ opacity: 0; animation: agentChatMessageIn 420ms ease forwards; \}/);
    expect(chatStyles).toMatch(/:nth-last-child\(n\+6\) \{ animation-delay: 0ms; \}/);
    for (const [place, delay] of [[5, 80], [4, 160], [3, 240], [2, 320], [1, 400]]) expect(chatStyles).toContain(`:nth-last-child(${place}) { animation-delay: ${delay}ms; }`);
    expect(chatStyles).toMatch(/@keyframes agentChatMessageIn \{ from \{ opacity: 0; transform: translateY\(var\(--space-2\)\); \} to \{ opacity: 1; transform: none; \} \}/);
    expect(chatStyles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.agentChatPanel, \.agentChatScrim \{ animation: none; \}\s*\.agentChatPanel\.isEntering \.agentChatLog > \* \{ opacity: 1; animation: none; \}/);
    const presentation = chat("agent-chat-presentation.ts");
    expect(presentation).toContain("export const HOME_SETTLE_MS = 480;");
    expect(presentation).toContain('export const HOME_SETTLE_CURVE = "cubic-bezier(.2, .8, .2, 1)";');
    expect(presentation).toContain("export const HOME_ENTRY_MS = 2_200;");
    const dock = chat("AgentChatDock.tsx");
    expect(dock).toMatch(/if \(!form \|\| prefersReducedMotion\(\)\) return;/);
    expect(dock).toMatch(/form\.style\.transition = `transform \$\{HOME_SETTLE_MS\}ms \$\{HOME_SETTLE_CURVE\}`;/);
    expect(dock).toMatch(/setHomeMode\(true\);\s*setEntering\(true\);/);
    expect(dock).toMatch(/setOpen\(false\); setHomeMode\(null\);/);
  });

  it("draws the suggestion chips with the composer radius on the raised fill, 44px on a phone, and the composer without its panel margin on Home", () => {
    expect(styleEntry).toMatch(/@import "\.\/styles\/agent-chat\.css";/);
    expect(tokens).toMatch(/--composer-radius:\s*12px/);
    expect(chatStyles).toMatch(/\.agentChatHome \.agentChatComposer \{ margin: 0; \}/);
    expect(chatStyles).toMatch(/\.agentChatSuggestionChip\.commandQuietAction \{[^}]*min-height: var\(--control-compact\);[^}]*border-radius: var\(--composer-radius\); background: var\(--command-panel-2\); color: var\(--command-ink\);/);
    expect(chatStyles).not.toMatch(/\.agentChatSuggestionChip[^{]*\{[^}]*(?:border:|outline:|box-shadow)/);
    expect(chatStyles).toMatch(/\.agentChatSuggestionChip\.commandQuietAction:hover:not\(:disabled\) \{ background: color-mix\(in srgb, var\(--command-ink\) 10%, var\(--command-panel-2\)\); \}/);
    expect(chatStyles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{[^@]*\.agentChatSuggestionChip\.commandQuietAction,[^{]*\{ min-height: 44px; \}/);
    // The chip is the Quiet role with a local fill and radius, never a seventh role; the one other button of the block is the Quiet role too.
    const aril = read("HomeAril.tsx");
    for (const [tag] of aril.matchAll(/<button\b[^>]*>/g)) expect(tag).toMatch(/className=(?:"commandQuietAction agentChatSuggestionChip"|\{`commandQuietAction \$\{styles\.back\}`\})/);
    // The composer on Home is the chat composer, with the same field, the message ID that focus returns from, and no Stop.
    expect(aril).toMatch(/<AgentChatComposer ref=\{composer\} fieldId=\{HOME_COMPOSER_FIELD_ID\}/);
    expect(aril).toMatch(/running=\{false\} busy=\{false\} error=\{null\}/);
    expect(chat("AgentChatDock.tsx")).toMatch(/\{!open && !onHome && <AgentChatLauncher/);
  });

  it("documents the rule of Needs you, the running sessions, the last-24-hours tiles, the composer, and focus mode, with the same words as the code", () => {
    expect(designContract).toMatch(/^# Home design$/m);
    expect(designContract).toMatch(/\[Home design\]\(docs\/internal\/design\/home\.md\)/);
    expect(designContract).toMatch(/Home is one centered column, at most 820px wide/);
    expect(designContract).toMatch(/The session guides and the roadmap preview are not on Home/);
    expect(designContract).toMatch(/A fixed rule counts the tiles from the task log\. No model runs, and no model writes the words/);
    expect(designContract).toMatch(/A line is a current state of a board or a session, never an old log entry/);
    expect(designContract).toMatch(/A fixed rule picks and words the lines\. No model runs/);
    expect(designContract).toMatch(/A line names no task and shows no task title and no task ID/);
    expect(designContract).toMatch(/With nothing to do, Needs you is not drawn/);
    expect(designContract).toMatch(/Amber text marks a failure only\. No other word on a line is amber/);
    expect(designContract).toMatch(/The tiles are a deterministic count, not a judgment, and not a complete record/);
    expect(designContract).toMatch(/With no event in the window, the four tiles read zero\. They are not hidden/);
    expect(designContract).toMatch(/The tiles come from Pomegr's task logs and not from the chat, so they and the mark are drawn while Aril is Off too/);
    expect(designContract).toMatch(/The desktop draws Needs you and Continue side by side, each card at least 196px high\. The phone stacks them/);
    expect(designContract).toMatch(/No rule runs between the rows of a card\. Each row is a rounded item with a hover fill, and each card ends with a closing line/);
    expect(designContract).toMatch(/The column is centered vertically in the content area when it is shorter than the window\. When it is taller, it starts at the top and the page scrolls as usual/);
    expect(designContract).toMatch(/Home draws once, after everything that decides its shape has answered/);
    expect(designContract).toMatch(/Each block then fades in and rises 8px over 420ms with the curve `cubic-bezier\(\.2, \.8, \.2, 1\)`, 60ms after the block above it/);
    expect(designContract).toMatch(/On the phone the block is pinned to the bottom of the screen, above the safe area, with the page scrolling under it/);
    expect(designContract).toMatch(/The running sessions are the live sessions whose state is \*\*In progress\*\* or \*\*Needs input\*\*\. Pomegr already observes both/);
    expect(designContract).toMatch(/A session started for a task, or assigned to it, shows the title line of that task\. Any other session, a review session included, shows its own title/);
    expect(designContract).toMatch(/The task text is a board value, so it never enters `\/api\/state`\. Home draws only that one line/);
    expect(designContract).toMatch(/The rows wait for the boards of the shown sessions, so no title is drawn and then replaced by another/);
    expect(designContract).toMatch(/Home does not show the provider status and does not read it/);
    expect(designContract).toMatch(/The card is horizontal: the thumbnail on the left, the text beside it, and the actions at the end/);
    expect(designContract).toMatch(/The thumbnail has a small fixed size, so the card never grows with the artwork/);
    expect(designContract).toMatch(/On the phone, the card is one compact row: a smaller thumbnail, the eyebrow and the title on one line each, and a chevron/);
    expect(designContract).toMatch(/Home calls no new route and stores no board value/);
    expect(designContract).toMatch(/Focusing the message field of the composer, or picking a suggestion chip, starts focus mode/);
    expect(designContract).toMatch(/Escape returns to Home, and the draft stays/);
    expect(designContract).toMatch(/A click outside the block returns to Home while the field is empty\. It does nothing while the field holds text or an image/);
    expect(designContract).toMatch(/Returning moves focus to the Home page, never into the composer, which would start focus mode again/);
    expect(designContract).toMatch(/Reduced motion removes every fade and move: the parts and the composer change at once/);
    expect(designContract).toMatch(/Send hands the message to the dock\. The dock opens the \[maximized Aril view\]\(agent-chat\.md#panel-opened-from-home\) on that repository's thread and sends the message there/);
    expect(designContract).toMatch(/Closing the maximized view returns to Home[^\n]*\n[^\n]*Closing the view does not start focus mode/);
    expect(designContract).toMatch(/A suggestion chip fills the message field and sends nothing/);
    expect(designContract).toMatch(/The dock draws no launcher on Home, because the composer is the way in/);
    expect(designContract).toMatch(/A message that the desktop refuses goes back to the panel's field with the images, and the fixed alert line says why/);
    expect(designContract).toMatch(/A message waiting in the panel's field is kept\. A message from Home never replaces it/);
    expect(designContract).toMatch(/## Panel opened from Home[^]*The panel that Home opens is the existing expanded panel[^]*No second chat view exists/);
    expect(designContract).toMatch(/A panel that was docked is docked again after the close, and a panel that was expanded stays expanded/);
    expect(designContract).toMatch(/The suggestion chips above the composer on Home, `\.agentChatSuggestionChip`, use the composer radius, token `--composer-radius`/);
    expect(designContract).toMatch(/A suggestion chip composes the Quiet role with a local fill and radius\. It is not a seventh role/);
    expect(designContract).toMatch(/The lifted Home composer takes the overlay shadow/);
    expect(designContract).toMatch(/agent-chat-suggestion:[^]*rounded: "\{rounded\.composer\}"/);
    // The durations and the curve of the documents are the ones of the code.
    expect(designContract).toMatch(/They fade over 280ms, and they rise 10px as they go/);
    expect(designContract).toMatch(/over 480ms, with the curve `cubic-bezier\(\.2, \.8, \.2, 1\)`/);
    // Every fixed word of Needs you and of the running sessions, and every suggestion, is written in the contract.
    const words = [
      ...Object.values(PAUSE_WORDS), "CI failed", "Review failed", "Merge refused", "Working", "Waiting for you", "Enter to send · Esc to go back",
      "Review 1 finished task", "Review n finished tasks", "Check 1 stalled task", "Check n stalled tasks", "Unblock 1 task", "Unblock n tasks", "Restart the paused queue",
      "Answer a session that is waiting for you", "Answer n sessions that are waiting for you", "Task boards are unavailable. Pomegr will retry.", "Reading the task logs…",
      "Nothing else is waiting on you.", "Pin a session to keep it here", "Some logs could not be read.", "Last 24 hours",
    ];
    for (const phrase of words) expect(designContract).toContain(`“${phrase}”`);
    expect(designContract).toContain("**Back to Home**");
    for (const { text } of HOME_SUGGESTIONS) expect(designContract).toContain(`“${text}”`);
    expect(Object.keys(PAUSE_WORDS).sort()).toEqual([...TASK_QUEUE_PAUSE_REASONS].sort());
    for (const reason of TASK_QUEUE_PAUSE_REASONS) expect(designContract).toContain(`| \`${reason}\` |`);
  });

  it("renders every Home state at /design-system", () => {
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemHomeUpdateSample.tsx"), "utf8");
    for (const label of [
      "Last 24 hours, with counts", "Last 24 hours, nothing logged", "Last 24 hours, a log could not be read", "Last 24 hours, reading", "Needs you", "Continue, running sessions",
      "Composer on Home, with suggestions", "Composer on Home, focus mode", "With illustration", "Text only",
    ]) expect(sample).toContain(`label="${label}"`);
    expect(designContract).toMatch(/It renders Home's Needs you card with every line kind and a failure detail/);
  });
});
