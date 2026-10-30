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
const tokenOnly = ["HomeAril.module.css", "HomeArilLine.module.css", "HomeContinue.module.css", "HomeNeedsYou.module.css"].map(read).join("\n") + pageStyles;

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

  it("lays Home out as one centered column of at most 720px with the composer at the foot of the content area", () => {
    expect(pageStyles).toMatch(/\.home \{ display: flex; flex-direction: column; min-height: 100%;/);
    expect(pageStyles).toMatch(/\.column \{[^}]*flex-direction: column; flex: 1 1 auto; gap: var\(--space-8\); width: min\(720px, 100%\);[^}]*margin: 0 auto; \}/);
    expect(pageStyles).toMatch(/\.composer \{ margin-top: auto;/);
    expect(pageStyles).toMatch(/\.home h1 \{ min-height: 1\.25em; \}/);
    expect(pageStyles).not.toMatch(/\.status|providerStatus/);
    // The column keeps one reading order: the header, Needs you, Continue, the What's new card, and the composer.
    const source = readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8");
    const order = ["<CommandPageHeader", "<HomeNeedsYou", "<HomeContinue", "<HomeUpdateCard", "<HomeAril suggestions"].map((part) => source.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(source).not.toMatch(/Session coach|On the horizon|Understand your sessions|Open conversation|ProviderStatus|provider-status/);
  });

  it("draws a Needs you line as the action, a failure in amber, and the repository, with no task ID and no title", () => {
    const needs = read("HomeNeedsYou.module.css");
    expect(needs).toMatch(/\.action \{ flex: 1 1 12rem; min-width: 0; \}/);
    expect(needs).toMatch(/\.urgent \{ color: var\(--command-amber\); \}/);
    expect(needs).toMatch(/\.detail \{ color: var\(--command-muted\); \}/);
    expect(needs).toMatch(/\.repository \{[^}]*color: var\(--command-muted\);[^}]*text-align: end;/);
    expect(needs).toMatch(/@media \(max-width: 760px\) \{[^}]*\.action \{ flex-basis: 100%; \}/);
    // The only amber in Home's list rules is that one, and the line type carries no task or title at all.
    expect(needs.match(/var\(--command-amber\)/g)).toHaveLength(1);
    expect(read("HomeNeedsYou.tsx")).not.toMatch(/taskId|\.title|<h3|<button/);
    expect(read("home-model.ts")).toMatch(/export type NeedsLine = \{ key: string; action: string; detail: NeedsDetail \| null; repository: string; href: string \};/);
  });

  it("draws a running session as a state dot, the title, the state, and the place, with amber only for a session that waits", () => {
    const styles = read("HomeContinue.module.css");
    expect(styles).toMatch(/\.dot \{ flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; \}/);
    expect(styles).toMatch(/\.dotWorking \{ background: var\(--command-green\); opacity: \.8; \}/);
    expect(styles).toMatch(/\.dotWaiting \{ background: var\(--command-amber\); \}/);
    expect(styles).toMatch(/\.waiting \{ color: var\(--command-amber\); \}/);
    expect(styles).toMatch(/\.state, \.meta \{ color: var\(--command-muted\); \}/);
    expect(styles).toMatch(/\.pinned \{[^}]*color: var\(--command-muted\); font: 400 var\(--text-xs\)\/1\.4 var\(--font-ui\); \}/);
    expect(styles).toMatch(/\.removePin \{[^}]*opacity: 0; \}/);
    expect(styles).toMatch(/\.pinList > li:hover \.removePin, \.pinList > li:focus-within \.removePin \{ opacity: 1; \}/);
    expect(read("HomeContinue.tsx")).toContain('session.waiting ? "Waiting for you" : "Working"');
  });

  it("draws the What's new card horizontal, with a thumbnail of a small fixed size on the left, the text beside it, and a smaller thumbnail on a phone", () => {
    const styles = read("HomeUpdateCard.module.css");
    expect(styles).toMatch(/\.card \{\s*position: relative;\s*display: flex;\s*align-items: center;\s*gap: 16px;[^}]*border-inline-start: 3px solid var\(--command-brand\);\s*border-block: 1px solid var\(--command-line\);\s*background: var\(--command-panel\);/);
    expect(styles).toMatch(/--thumb-width: 132px;\s*--thumb-height: 84px;\s*--thumb-scale: \.28;\s*--thumb-offset: 10px 0 0 9px;/);
    expect(styles).toMatch(/\.thumbnail \{ flex-shrink: 0; width: var\(--thumb-width\); height: var\(--thumb-height\); overflow: hidden; border: 1px solid var\(--command-line\); border-radius: var\(--control-radius\); background: var\(--command-panel-2\); \}/);
    expect(styles).toMatch(/\.thumbnail > div \{ width: 408px; margin: var\(--thumb-offset\); transform: scale\(var\(--thumb-scale\)\); transform-origin: top left; \}/);
    expect(styles).toMatch(/@media \(max-width: 760px\) \{[^@]*\.card \{ --thumb-width: 88px; --thumb-height: 56px; --thumb-scale: \.18; --thumb-offset: 6px 0 0 7px; flex-wrap: wrap;/);
    expect(styles).toMatch(/\.content \{ flex: 1 1 0; \}\s*\.open \{ flex-basis: 100%; \}/);
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

  it("documents the rule of Needs you, the running sessions, the Aril line, the composer, and focus mode, with the same words as the code", () => {
    expect(designContract).toMatch(/^# Home design$/m);
    expect(designContract).toMatch(/\[Home design\]\(docs\/internal\/design\/home\.md\)/);
    expect(designContract).toMatch(/Home is one centered column, at most 720px wide/);
    expect(designContract).toMatch(/The session guides and the roadmap preview are not on Home/);
    expect(designContract).toMatch(/A fixed rule writes the line from the task log\. No model runs, and no model writes the words/);
    expect(designContract).toMatch(/A line is a current state of a board or a session, never an old log entry/);
    expect(designContract).toMatch(/A fixed rule picks and words the lines\. No model runs/);
    expect(designContract).toMatch(/A line names no task and shows no task title and no task ID/);
    expect(designContract).toMatch(/With nothing to do, Needs you is not drawn/);
    expect(designContract).toMatch(/Amber text marks a failure only\. No other word on a line is amber/);
    expect(designContract).toMatch(/The line is a deterministic count, not a judgment, and not a complete record/);
    expect(designContract).toMatch(/The running sessions are the live sessions whose state is \*\*In progress\*\* or \*\*Needs input\*\*\. Pomegr already observes both/);
    expect(designContract).toMatch(/A session started for a task, or assigned to it, shows the title line of that task\. Any other session, a review session included, shows its own title/);
    expect(designContract).toMatch(/The task text is a board value, so it never enters `\/api\/state`\. Home draws only that one line/);
    expect(designContract).toMatch(/The rows wait for the boards of the shown sessions, so no title is drawn and then replaced by another/);
    expect(designContract).toMatch(/Home does not show the provider status and does not read it/);
    expect(designContract).toMatch(/The card is horizontal: the thumbnail on the left, the text beside it, and the actions at the end/);
    expect(designContract).toMatch(/The thumbnail has a small fixed size, so the card never grows with the artwork/);
    expect(designContract).toMatch(/On the phone, the card stays horizontal and the thumbnail is smaller/);
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
      "Aril line, with counts", "Aril line, nothing logged", "Aril line, a log could not be read", "Aril line, reading", "Needs you", "Continue, running sessions",
      "Composer on Home, with suggestions", "Composer on Home, focus mode", "With illustration", "Text only",
    ]) expect(sample).toContain(`label="${label}"`);
    expect(designContract).toMatch(/It renders Home's Needs you list with every line kind and a failure detail/);
  });
});
