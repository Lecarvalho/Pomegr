import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Aril chat: the docked panel, the composer, the time of a message, and the design contract that documents them. The contract is the root file and one page for each surface, read as one text.
const designPagesPath = join(process.cwd(), "docs", "internal", "design");
const designContract = [join(process.cwd(), "DESIGN.md"), ...readdirSync(designPagesPath).sort().map((name) => join(designPagesPath, name))]
  .map((path) => readFileSync(path, "utf8")).join("\n");
const designSystemStyles = readFileSync(join(process.cwd(), "app", "styles", "design-system.css"), "utf8");
const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const styles = [...styleEntry.matchAll(/@import "\.\/(.+?\.css)";/g)]
  .map((match) => readFileSync(join(process.cwd(), "app", match[1]), "utf8")).join("\n");

describe("Aril chat visual contract", () => {
  it("draws the Aril chat with tokens only and the shared roles, mounts it once, and documents it", () => {
    const chatStyles = readFileSync(join(process.cwd(), "app", "styles", "agent-chat.css"), "utf8");
    const chatComponents = join(process.cwd(), "app", "components", "agent-chat");
    const read = (name: string) => readFileSync(join(chatComponents, name), "utf8");
    // The stylesheet is registered with the others and uses tokens only: no literal color, off-ramp font size, or off-scale radius.
    expect(styleEntry).toMatch(/@import "\.\/styles\/agent-chat\.css";/);
    expect(chatStyles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(chatStyles).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    for (const [, radius] of chatStyles.matchAll(/border-radius:\s*([^;}]+)/g)) expect(radius.trim()).toMatch(/^(?:var\(--(?:control|panel|composer)-radius\)|50%|0)$/);
    // The composer radius is a token, and so is the ink on the brand fill: DESIGN.md records both as Agent chat exceptions.
    expect(styles).toMatch(/--composer-radius:\s*12px/);
    expect(styles).toMatch(/--color-on-brand:\s*#ffffff/);
    expect(styles).toMatch(/--command-on-brand:\s*var\(--color-on-brand\)/);
    expect(chatStyles.match(/border-radius: var\(--composer-radius\)/g)).toHaveLength(1);
    // The launcher: shell chrome fixed to the corner, the panel fill, the strong line, the control radius, and the overlay shadow, above the header and below the inspector sheet.
    expect(chatStyles).toMatch(/\.agentChatLauncher \{[^}]*position: fixed; z-index: 85;[^}]*min-height: var\(--control-height\);[^}]*border: 1px solid var\(--command-line-strong\); border-radius: var\(--control-radius\); background: var\(--command-panel\); box-shadow: var\(--command-overlay-shadow\)/);
    expect(chatStyles).toMatch(/\.agentChatLauncherDot \{[^}]*background: var\(--command-brand\)/);
    // The panel: docked to the right edge from the bottom of the shell header, 520px wide and never wider than the content area, a one-pixel left line, no radius and no shadow, under the header (z-index 75).
    // At 760px and narrower it is a sheet above the header, with 44px targets there and on coarse pointers, and a fade that reduced motion removes.
    expect(styles).toMatch(/:root \{ --command-header-height: 60px; --command-rail-width: 220px; \}/);
    expect(styles).toMatch(/@media \(max-width: 1080px\) \{ :root \{ --command-header-height: 56px; --command-rail-width: 54px; \} \}/);
    expect(styles).toMatch(/grid-template-columns: var\(--command-rail-width\) minmax\(0, 1fr\);\s*grid-template-rows: var\(--command-header-height\) minmax\(0, 1fr\);/);
    expect(chatStyles).toMatch(/:root \{ --aril-panel-width: min\(520px, calc\(100vw - var\(--command-rail-width\)\)\); --aril-column-width: 760px; \}/);
    expect(chatStyles).toMatch(/\.agentChatPanel \{ position: fixed; z-index: 75; top: var\(--command-header-height\); right: 0; bottom: 0; width: var\(--aril-panel-width\);[^}]*border-left: 1px solid var\(--command-line\); background: var\(--command-panel\); animation: agentChatIn \.14s ease-out/);
    const dockedRule = /\.agentChatPanel \{([^}]*)\}/.exec(chatStyles)![1];
    expect(dockedRule).not.toMatch(/box-shadow|border-radius|border: 1px/);
    expect(chatStyles).toMatch(/\.agentChatPanel\[hidden\] \{ display: none; \}/);
    // The panel lays over the page and does not move it: no margin for the content area and no mark on the document root. A scrim dims the page behind it.
    expect(chatStyles).not.toMatch(/data-aril-panel|\.commandMain|margin-right/);
    expect(chatStyles).toMatch(/\.agentChatScrim \{ position: fixed; z-index: 74; inset: var\(--command-header-height\) 0 0; display: block; width: 100%; padding: 0; border: 0; background: var\(--command-scrim\); cursor: default; animation: agentChatIn \.14s ease-out; \}/);
    expect(/\.agentChatScrim[^{]*\{([^}]*)\}/.exec(chatStyles)![1]).not.toMatch(/blur|backdrop-filter|box-shadow/);
    expect(styles).toMatch(/--color-scrim:\s*#0000001a/);
    expect(styles).toMatch(/html\[data-theme="dark"\][\s\S]*?--color-scrim:\s*#0000002e/);
    expect(styles).toMatch(/--command-scrim:\s*var\(--color-scrim\)/);
    expect(chatStyles).toMatch(/@media \(min-width: 761px\) \{/);
    expect(chatStyles).toMatch(/\.agentChatPanel\.isExpanded:not\(\.isStatic\) \{ left: var\(--command-rail-width\); width: auto; \}/);
    expect(chatStyles).toMatch(/\.agentChatPanel\.isExpanded \.agentChatLog, \.agentChatPanel\.isExpanded \.agentChatHistory \{ padding-inline: max\(var\(--space-4\), calc\(\(100% - var\(--aril-column-width\)\) \/ 2\)\); \}/);
    expect(chatStyles).toMatch(/\.agentChatPanel\.isExpanded \.agentChatComposer \{ align-self: center; width: min\(var\(--aril-column-width\), calc\(100% - 2 \* var\(--space-4\)\)\); margin-inline: 0; \}/);
    expect(chatStyles).toMatch(/@media \(max-width: 760px\) \{\s*\.agentChatPanel \{ inset: 0; z-index: 85; width: auto; height: auto;[^}]*border: 0; \}\s*\.agentChatExpand, \.agentChatScrim \{ display: none; \}/);
    expect(chatStyles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{\s*(?:\.agentChat(?:Attach|ImagePicture)[^\n]*\n\s*)*\.agentChatLauncher, \.agentChatField[^{]*\{ min-height: 44px; \}/);
    expect(chatStyles).toMatch(/\.agentChatAttach, \.agentChatImageRemove, \.agentChatSend\.commandIconAction \{ width: 44px; height: 44px; \}/);
    expect(chatStyles).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.agentChatPanel, \.agentChatScrim \{ animation: none; \}/);
    // Only the launcher takes the overlay shadow.
    const shadowed = [...chatStyles.replace(/\/\*[^]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*box-shadow: var\(--command-overlay-shadow\)/g)].map(([, selector]) => selector.trim());
    expect(shadowed.filter((selector) => !/^\.agentChatLauncher\b/.test(selector))).toEqual([]);
    // Messages: the owner's is a raised bubble at the right with its time below; Aril's has no fill. The time is muted data-face text. The field has no frame and keeps the shared focus ring.
    expect(chatStyles).toMatch(/\.agentChatMessage\.isOwner \{[^}]*align-self: flex-end; align-items: flex-end; max-width: 85%;/);
    expect(chatStyles).toMatch(/\.agentChatBubble \{[^}]*border-radius: var\(--control-radius\); background: var\(--command-panel-2\)/);
    expect(chatStyles).not.toMatch(/\.agentChatMessage\.isAgent[^{]*\{[^}]*background/);
    expect(chatStyles).toMatch(/\.agentChatMessageTime, \.agentChatMessageCaption \{ color: var\(--command-muted\); font: 400 var\(--text-xs\)\/1\.4 var\(--font-data\); \}/);
    expect(chatStyles).toMatch(/\.agentChatQuietLine \{[^}]*color: var\(--command-muted\); font: 400 var\(--text-xs\)\/1\.5 var\(--font-ui\); \}/);
    expect(chatStyles).toMatch(/\.agentChatField \{[^}]*border: 0; border-radius: var\(--control-radius\); background: transparent;[^}]*font: 400 var\(--text-sm\)\/1\.4 var\(--font-ui\)/);
    // The message field shows no ring (the caret marks focus), and it is the only rule in the chat that removes one; every button and select keeps the shared ring.
    expect(chatStyles).toMatch(/\.agentChatField:focus-visible \{ outline: 0; \}/);
    expect(chatStyles.match(/outline:\s*(?:0|none)/g)).toHaveLength(1);
    expect(chatStyles).not.toMatch(/\.agentChatComposer[^{]*:focus(?:-visible)?[^{]*\{[^}]*outline:\s*(?:0|none)/);
    expect(styles).toMatch(/\.commandSelectTrigger:focus-visible \{ outline: 2px solid var\(--focus-ring\); outline-offset: 2px; \}/);
    // The composer: no border, the raised fill, the composer radius, inset from the panel. Its select triggers have no frame, and Send and Stop are one round brand action.
    expect(chatStyles).toMatch(/\.agentChatComposer \{[^}]*margin: 0 var\(--space-4\) var\(--space-4\);[^}]*border: 0; border-radius: var\(--composer-radius\); background: var\(--command-panel-2\); \}/);
    expect(chatStyles).toMatch(/\.agentChatComposer \.commandSelectTrigger \{[^}]*border-color: transparent; background: transparent;/);
    expect(chatStyles).toMatch(/\.agentChatComposer \.commandSelectTrigger:hover:not\(:disabled\), \.agentChatComposer \.commandSelectTrigger\[aria-expanded="true"\] \{ border-color: transparent; background: color-mix\(in srgb, var\(--command-ink\) 6%, transparent\);/);
    expect(chatStyles).toMatch(/\.agentChatSend\.commandIconAction \{[^}]*width: 32px; height: 32px;[^}]*border-radius: 50%; background: var\(--command-brand\); color: var\(--command-on-brand\); \}/);
    expect(chatStyles).toMatch(/\.agentChatImageRemove \{[^}]*border: 0; background: var\(--command-panel\); \}/);
    const composerRules = [...chatStyles.matchAll(/^(\.agentChat(?:Composer|Field|Send|Run|Repository|Attach)[^{]*)\{([^}]*)\}/gm)];
    expect(composerRules.length).toBeGreaterThan(8);
    for (const [, selector, body] of composerRules) expect(body, selector).not.toMatch(/border: 1px|border-color: var/);
    expect(chatStyles).toMatch(/\.agentChatCounter \{[^}]*var\(--font-data\)/);
    expect(chatStyles).toMatch(/\.agentChatCounter\.isOver \{ color: var\(--command-error\); \}/);
    // The proposal card: a one-pixel line, the panel radius, 12px padding; a task ID in the data font; an error is text, never a fill.
    expect(chatStyles).toMatch(/\.agentChatProposal \{[^}]*gap: var\(--space-2\); padding: var\(--space-3\); border: 1px solid var\(--command-line\); border-radius: var\(--panel-radius\)/);
    expect(chatStyles).toMatch(/\.agentChatTaskId \{[^}]*var\(--font-data\)/);
    expect(chatStyles).toMatch(/\.agentChatOpWarning \{ color: var\(--command-error\);/);
    expect(chatStyles).toMatch(/\.agentChatOpResult\.is-error \{ color: var\(--command-error\); \}/);
    expect(chatStyles).not.toMatch(/\.agentChatOp[A-Za-z.-]*[^{]*\{[^}]*(?:background|border)/);
    // Answer text: the data font at 12px for code, and a heading line that is not a heading element.
    expect(chatStyles).toMatch(/\.agentChatCode \{[^}]*font: 400 var\(--text-xs\)\/1\.5 var\(--font-data\)/);
    expect(chatStyles).toMatch(/\.agentChatMdHeading \{ font: 650 var\(--text-sm\)\/1\.4 var\(--font-ui\); \}/);

    // Every button is one of the six roles, but for the launcher (shell chrome) and the conversation row, as documented. No native select, and no markup from a string.
    const sources = ["AgentChatComposer.tsx", "AgentChatDock.tsx", "AgentChatFrame.tsx", "AgentChatHistory.tsx", "AgentChatImages.tsx", "AgentChatMessages.tsx", "AgentChatPanel.tsx", "AgentChatProposalCard.tsx"].map(read).join("\n") + readFileSync(join(process.cwd(), "app", "components", "markdown", "SafeMarkdown.tsx"), "utf8");
    expect(sources).not.toMatch(/<select|dangerouslySetInnerHTML|innerHTML/);
    const tags = [...sources.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
    expect(tags.length).toBeGreaterThanOrEqual(12);
    for (const tag of tags) expect(tag).toMatch(/className=\{?[`"](?:commandPrimaryAction|commandSecondaryAction|commandQuietAction|commandIconAction|agentChatLauncher|agentChatScrim|agentChatHistoryOpen)/);
    // The card has one Primary: Apply changes, or Start session for a session start where it can be applied.
    expect(read("AgentChatProposalCard.tsx")).toContain("const primary = proposalPrimary(proposal, startHere);");
    expect(read("agent-chat-presentation.ts")).toContain('if (startProposalTask(proposal) !== null) return startHere ? "Start session" : null;');
    expect(read("agent-chat-presentation.ts")).toContain('return queueOn === null ? "Apply changes" : queueOn ? "Turn queue on" : "Turn queue off";');
    expect(read("AgentChatProposalCard.tsx")).toMatch(/\{primary && <button type="button" className="commandPrimaryAction"[^]*?>\{primary\}<\/button>\}/);
    expect(read("AgentChatProposalCard.tsx")).toMatch(/className="commandQuietAction"[^]*?>Dismiss<\/button>/);
    expect(read("AgentChatProposalCard.tsx").match(/commandPrimaryAction/g)).toHaveLength(1);
    expect(read("AgentChatComposer.tsx")).toMatch(/type="button" className="commandIconAction agentChatSend" aria-label="Stop" title="Stop"[^]*?<CommandIcon name="stop" \/><\/button>/);
    expect(read("AgentChatComposer.tsx")).toMatch(/type="submit" className="commandIconAction agentChatSend" aria-label="Send" title="Send"[^]*?<CommandIcon name="send" \/><\/button>/);
    expect(read("AgentChatComposer.tsx")).toMatch(/<CommandSelect className="agentChatRepository" aria-label="Repository"/);
    expect(read("AgentChatComposer.tsx")).toContain('placeholder="Ask Aril…"');
    expect(read("AgentChatFrame.tsx")).toMatch(/className="commandIconAction" aria-label="Close Aril" title="Close Aril"/);
    expect(read("AgentChatFrame.tsx")).toMatch(/className="commandIconAction agentChatExpand" aria-label=\{expanded \? "Dock" : "Expand"\} title=\{expanded \? "Dock" : "Expand"\} aria-pressed=\{expanded\}/);
    expect(read("AgentChatFrame.tsx")).not.toMatch(/Minimize|Task-board agent/);
    expect(read("AgentChatDock.tsx")).toMatch(/\{open && <AgentChatScrim onClick=\{close\} \/>\}/);
    expect(read("AgentChatDock.tsx")).not.toMatch(/arilPanel|data-aril-panel/);
    expect(read("AgentChatFrame.tsx")).toMatch(/className=\{`agentChatScrim\$\{isStatic \? " isStatic" : ""\}`\} tabIndex=\{-1\} aria-hidden="true" onClick=\{onClick\}/);
    expect(read("AgentChatComposer.tsx")).toMatch(/<CommandSelect className="agentChatModel" aria-label="Model" groupInValue=\{false\}/);
    expect(read("AgentChatComposer.tsx")).toMatch(/<CommandSelect className="agentChatEffort" aria-label="Effort" options=\{CHAT_EFFORT_OPTIONS\}/);
    expect(read("AgentChatComposer.tsx")).not.toMatch(/Run on|Default (?:model|effort)/i);
    expect(read("agent-chat-run.ts")).not.toMatch(/label: "Default|label: "default/);

    // AppShell mounts the dock once, after the shell, and the design-system reference draws every part from static data.
    expect(readFileSync(join(process.cwd(), "app", "components", "AppShell.tsx"), "utf8")).toMatch(/<\/CommandCenterShell>\s*<AgentChatDock \/>/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemAgentChatSample.tsx"), "utf8");
    for (const label of ["Launcher", "Launcher, answering", "Launcher, new answer", "Panel, empty", "Panel, proposal", "Panel, images", "Panel, expanded", "Panel, over the dimmed page", "Panel, activity lines", "Proposal, images, pending", "Composer, images", "Composer, repository", "Composer, model and effort", "Composer, no known model", "Composer, uploading image", "Composer, image error", "Panel, answer being written", "Panel, conversations", "Panel, no repository", "Proposal, pending", "Proposal, applied", "Proposal, partly applied", "Proposal, every result word", "Composer, error", "Composer, over the limit", "Answer text"]) {
      expect(sample).toContain(`label="${label}"`);
    }
    expect(designSystemStyles).toMatch(/\.designSystemChatGrid \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 420px\), 1fr\)\); \}/);

    // The Agent chat design page documents the launcher, the panel, the proposal card, the composer, and the conversation list, and DESIGN.md routes to it.
    expect(designContract).toMatch(/^# Agent chat design$/m);
    expect(designContract).toMatch(/\[Agent chat design\]\(docs\/internal\/design\/agent-chat\.md\)/);
    expect(designContract).toMatch(/`\.agentChatLauncher` is shell chrome like the header icon buttons \(`\.commandIconButton`\), not a seventh role/);
    expect(designContract).toMatch(/The z-index of the launcher is 85: above the sidebar and the header, below the agent inspector sheet \(90\) and the select list \(120\)/);
    expect(designContract).toMatch(/The z-index of the docked panel is 75, below the header \(80\), so the notification tray and the profile menu open over it/);
    expect(designContract).toMatch(/Wider than 760px, the panel is docked: `position: fixed` to the right edge, from the bottom of the shell header to the bottom of the window/);
    expect(designContract).toMatch(/The panel is 520px wide, and never wider than the content area/);
    expect(designContract).toMatch(/The panel has the panel fill, a one-pixel `--command-line` left line, no radius, and no shadow/);
    expect(designContract).toMatch(/The panel lays over the page and does not move it/);
    expect(designContract).toMatch(/`AgentChatDock` draws the scrim \(`\.agentChatScrim`\) over the page below the header, behind the panel/);
    expect(designContract).toMatch(/A click on the scrim closes the panel exactly like \*\*Close Aril\*\*/);
    expect(designContract).toMatch(/The scrim has the `--command-scrim` fill \(black at 10% in light mode and 18% in dark mode\) and no blur/);
    expect(designContract).toMatch(/The scrim is not drawn at 760px and narrower/);
    expect(designContract).not.toMatch(/data-aril-panel|makes room for it|so the panel never covers the page/);
    expect(designContract).toMatch(/The message field in the composer shows no focus ring when it is focused, and its caret marks focus/);
    expect(designContract).toMatch(/Every interactive control shows the visible focus ring, but for the Aril message field/);
    expect(designContract).toMatch(/The message field shows no focus ring when it is focused: the caret marks focus/);
    expect(designContract).toMatch(/Every button and select in the composer keeps the shared focus ring for keyboard users/);
    expect(designContract).toMatch(/### Model and effort[^]*\*\*Model\*\* is a `CommandSelect` named \*\*Model\*\*, and its closed control reads the model alone/);
    expect(designContract).toMatch(/The list never offers a default model, and no control in the composer reads “default”/);
    expect(designContract).toMatch(/The initial model is the model of the open conversation, else the newest known Claude model, else the newest known Codex model/);
    expect(designContract).toMatch(/The initial effort is the effort of the open conversation, else \*\*Medium\*\*/);
    expect(designContract).toMatch(/`groupInValue=\{false\}` reads the label alone on the closed control, and the list keeps its group headings/);
    expect(designContract).toMatch(/Expanded, the log, the conversation list, and the composer sit in a centered column of at most 760px/);
    expect(designContract).toMatch(/## Composer[^]*`\.agentChatComposer` is a form with no border, the raised fill \(`--command-panel-2`\), and the 12px `--composer-radius`/);
    expect(designContract).toMatch(/\*\*Send\*\* is a round 32px action composed from the Icon role, with the brand fill, `--command-on-brand` ink, and an up-arrow \(`send`\) glyph, named “Send”/);
    expect(designContract).toMatch(/A time reads `HH:MM` \(24-hour, local\) for a message of today/);
    expect(designContract).toMatch(/A time reads `Mon D, HH:MM` for a message of an earlier day/);
    expect(designContract).toMatch(/A grant follow-up is drawn as a quiet line and not as a message/);
    expect(designContract).toMatch(/#### Agent chat exceptions[^]*The composer uses the 12px composer radius, token `--composer-radius`[^]*Send and Stop are one round 32px action, `\.agentChatSend`/);
    expect(designContract).toMatch(/composer: "12px"/);
    expect(designContract).toMatch(/At 760px and narrower, the panel is a full-screen sheet \(`inset: 0`, z-index 85, no border, padded by the safe area\)/);
    expect(designContract).toMatch(/The only thing the chat writes to browser storage is the last repository ID \(`pomegr\.agentChat\.repository`\), never a message/);
    expect(designContract).toMatch(/Escape first belongs to a layer inside the panel/);
    expect(designContract).toMatch(/`SafeMarkdown` builds React elements from the answer and sets no HTML/);
    expect(designContract).toMatch(/Only a pending proposal has a footer: the Primary \*\*Apply changes\*\* and the Quiet \*\*Dismiss\*\*/);
    expect(designContract).toMatch(/The Primary of a session start reads \*\*Start session\*\*\./);
    expect(designContract).toMatch(/On a paired device a session start has no Primary, only \*\*Dismiss\*\*\./);
    expect(designContract).toMatch(/The Primary of a queue change reads \*\*Turn queue on\*\* or \*\*Turn queue off\*\*, on a paired device too\./);
    expect(designContract).toMatch(/“Cannot be undone” in the error color \(text only, never a fill\)/);
    expect(designContract).toMatch(/Each pending card has its own Primary/);
    expect(designContract).toMatch(/A message that was refused stays in the field/);
    expect(designContract).toMatch(/an inline question, a Secondary \*\*Delete\*\* and a Quiet \*\*Keep\*\*[^.]*and no native dialog/);
  });
});
