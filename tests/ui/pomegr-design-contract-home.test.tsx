import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ATTENTION_WORDS, PAUSE_WORDS } from "../../app/components/home/home-model";
import { HOME_SUGGESTIONS } from "../../app/components/agent-chat/agent-chat-presentation";
import { TASK_HOME_ATTENTION_STATES, TASK_QUEUE_PAUSE_REASONS } from "../../shared/task-contract";

// Home: one centered column, the composer and its suggestion chips, and the design contract that documents them. The contract is the root file
// and one page for each surface, read as one text.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");
const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const chatStyles = readFileSync(join(process.cwd(), "app", "styles", "agent-chat.css"), "utf8");
const tokens = readFileSync(join(process.cwd(), "app", "styles", "tokens.css"), "utf8");
const homeComponents = join(process.cwd(), "app", "components", "home");
const read = (name: string) => readFileSync(join(homeComponents, name), "utf8");
// The What's new dialog keeps its documented backdrop; every other Home style uses tokens only.
const tokenOnly = ["HomeAril.module.css", "HomeArilLine.module.css", "HomeContinue.module.css", "HomeNeedsYou.module.css"].map(read).join("\n")
  + readFileSync(join(process.cwd(), "app", "HomeDashboard.module.css"), "utf8");

describe("Home visual contract", () => {
  it("draws Home with tokens only: no literal color, off-scale radius, or off-ramp font size", () => {
    expect(tokenOnly).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(tokenOnly).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    for (const [, radius] of tokenOnly.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^var\(--(?:control|panel)-radius\)$/);
    // The What's new line has no literal color either; only the dialog keeps its documented backdrop.
    const update = read("HomeUpdateCard.module.css");
    expect([...update.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(([color]) => color)).toEqual(["#0008"]);
    expect(designContract).toMatch(/The backdrop is `#0008`, the same scrim as the phone agent-filter sheet/);
  });

  it("lays Home out as one centered column of at most 720px with the composer at the foot of the content area", () => {
    const page = readFileSync(join(process.cwd(), "app", "HomeDashboard.module.css"), "utf8");
    expect(page).toMatch(/\.home \{ display: flex; flex-direction: column; min-height: 100%;/);
    expect(page).toMatch(/\.column \{[^}]*flex-direction: column; flex: 1 1 auto; gap: var\(--space-8\); width: min\(720px, 100%\);[^}]*margin: 0 auto; \}/);
    expect(page).toMatch(/\.composer \{ margin-top: auto;/);
    expect(page).toMatch(/\.home h1 \{ min-height: 1\.25em; \}/);
    expect(page).toMatch(/\.status \{[^}]*flex-wrap: wrap;[^}]*border-top: 1px solid var\(--command-line\);/);
    const needs = read("HomeNeedsYou.module.css");
    expect(needs).toMatch(/\.urgent \{ color: var\(--command-amber\); \}/);
    expect(needs).toMatch(/@media \(max-width: 760px\) \{[^}]*\.title \{ order: 3; flex-basis: 100%; \}/);
    // The column keeps one reading order: the header, Needs you, Continue, the status line, and the composer.
    const source = readFileSync(join(process.cwd(), "app", "HomeDashboard.tsx"), "utf8");
    const order = ["<CommandPageHeader", "<HomeNeedsYou", "<HomeContinue", "styles.status", "<HomeAril suggestions"].map((part) => source.indexOf(part));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(source).not.toMatch(/Session coach|On the horizon|Understand your sessions/);
  });

  it("draws the suggestion chips with the composer radius on the raised fill, 44px on a phone, and the composer without its panel margin on Home", () => {
    expect(styleEntry).toMatch(/@import "\.\/styles\/agent-chat\.css";/);
    expect(tokens).toMatch(/--composer-radius:\s*12px/);
    expect(chatStyles).toMatch(/\.agentChatHome \.agentChatComposer \{ margin: 0; \}/);
    expect(chatStyles).toMatch(/\.agentChatSuggestionChip\.commandQuietAction \{[^}]*min-height: var\(--control-compact\);[^}]*border-radius: var\(--composer-radius\); background: var\(--command-panel-2\); color: var\(--command-ink\);/);
    expect(chatStyles).not.toMatch(/\.agentChatSuggestionChip[^{]*\{[^}]*(?:border:|outline:|box-shadow)/);
    expect(chatStyles).toMatch(/\.agentChatSuggestionChip\.commandQuietAction:hover:not\(:disabled\) \{ background: color-mix\(in srgb, var\(--command-ink\) 10%, var\(--command-panel-2\)\); \}/);
    expect(chatStyles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{[^@]*\.agentChatSuggestionChip\.commandQuietAction,[^{]*\{ min-height: 44px; \}/);
    // The chip is the Quiet role with a local fill and radius, never a seventh role; the quiet action beside it is the Quiet role too.
    const aril = read("HomeAril.tsx");
    for (const [tag] of aril.matchAll(/<button\b[^>]*>/g)) expect(tag).toMatch(/className=(?:"commandQuietAction agentChatSuggestionChip"|\{`commandQuietAction \$\{styles\.open\}`\})/);
    expect(read("HomeNeedsYou.tsx")).toMatch(/className=\{`commandQuietAction \$\{styles\.more\}`\}/);
    // The composer on Home is the chat composer, with the same field, the message ID that focus returns to, and no Stop.
    expect(aril).toMatch(/<AgentChatComposer ref=\{composer\} fieldId=\{HOME_COMPOSER_FIELD_ID\}/);
    expect(aril).toMatch(/running=\{false\} busy=\{false\} error=\{null\}/);
    expect(readFileSync(join(process.cwd(), "app", "components", "agent-chat", "AgentChatDock.tsx"), "utf8")).toMatch(/\{!open && !onHome && <AgentChatLauncher/);
  });

  it("documents the rule of Needs you, the Aril line, the composer, and the chips, with the same words as the code", () => {
    expect(designContract).toMatch(/^# Home design$/m);
    expect(designContract).toMatch(/\[Home design\]\(docs\/internal\/design\/home\.md\)/);
    expect(designContract).toMatch(/Home is one centered column, at most 720px wide/);
    expect(designContract).toMatch(/The session guides and the roadmap preview are not on Home/);
    expect(designContract).toMatch(/A fixed rule writes the line from the task log\. No model runs, and no model writes the words/);
    expect(designContract).toMatch(/An item is a current state of a board, never an old log entry/);
    expect(designContract).toMatch(/A fixed rule picks the items\. No model picks them/);
    expect(designContract).toMatch(/The line is a deterministic count, not a judgment, and not a complete record/);
    expect(designContract).toMatch(/Home calls no new route and stores no board value/);
    expect(designContract).toMatch(/Send hands the message to the dock\. The dock opens the panel on that repository's thread and sends the message there/);
    expect(designContract).toMatch(/A suggestion chip fills the message field and sends nothing/);
    expect(designContract).toMatch(/The dock draws no launcher on Home, because the composer is the way in/);
    expect(designContract).toMatch(/A message that the desktop refuses goes back to the panel's field with the images, and the fixed alert line says why/);
    expect(designContract).toMatch(/A message waiting in the panel's field is kept\. A message from Home never replaces it/);
    expect(designContract).toMatch(/The suggestion chips above the composer on Home, `\.agentChatSuggestionChip`, use the composer radius, token `--composer-radius`/);
    expect(designContract).toMatch(/A suggestion chip composes the Quiet role with a local fill and radius\. It is not a seventh role/);
    expect(designContract).toMatch(/agent-chat-suggestion:[^]*rounded: "\{rounded\.composer\}"/);
    // Every fixed word of Needs you and every suggestion is written in the contract.
    for (const words of [...Object.values(ATTENTION_WORDS), ...Object.values(PAUSE_WORDS), "Queue paused", "CI failed", "CI passed", "Review failed", "Review passed", "Merge refused", "Merged"]) expect(designContract).toContain(`“${words}”`);
    for (const { text } of HOME_SUGGESTIONS) expect(designContract).toContain(`“${text}”`);
    expect(Object.keys(ATTENTION_WORDS).sort()).toEqual([...TASK_HOME_ATTENTION_STATES].sort());
    expect(Object.keys(PAUSE_WORDS).sort()).toEqual([...TASK_QUEUE_PAUSE_REASONS].sort());
    for (const reason of TASK_QUEUE_PAUSE_REASONS) expect(designContract).toContain(`| \`${reason}\` |`);
  });

  it("renders every Home state at /design-system", () => {
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemHomeUpdateSample.tsx"), "utf8");
    for (const label of ["Aril line, with counts", "Aril line, nothing logged", "Aril line, a log could not be read", "Aril line, reading", "Needs you", "Composer on Home, with suggestions", "With illustration", "Text only"]) expect(sample).toContain(`label="${label}"`);
    expect(designContract).toMatch(/It renders Home's Needs you list with every item kind, a failed detail, and a passed detail/);
  });
});
