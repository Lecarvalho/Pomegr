import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "../../app/settings/SettingsPage";
import { RepositoryRow } from "../../app/components/repositories/RepositoryRow";

const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const styles = [...styleEntry.matchAll(/@import "\.\/(.+?\.css)";/g)]
  .map((match) => readFileSync(join(process.cwd(), "app", match[1]), "utf8")).join("\n");
const layoutSource = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const shellSource = readFileSync(join(process.cwd(), "app", "components", "command-center", "CommandCenterShell.tsx"), "utf8");
const brandSource = readFileSync(join(process.cwd(), "app", "components", "PomegrBrand.tsx"), "utf8");
const sessionProgressSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "SessionProgressPanel.tsx"), "utf8");
const animatedProgressSource = readFileSync(join(process.cwd(), "app", "components", "AnimatedProgress.tsx"), "utf8");
const commandPageSource = readFileSync(join(process.cwd(), "app", "components", "command-center", "CommandPage.tsx"), "utf8");

describe("Pomegr visual contract", () => {
  it("reuses settings row geometry and standard chips for repository setup", () => {
    const { container } = render(<RepositoryRow title="Pomegr plugin" label="Enabled" tone="positive" detail="Project installation" actions={<button className="commandQuietAction">Recheck</button>} />);
    expect(container.firstChild).toHaveClass("commandSettingRow", "repositoryRow");
    expect(screen.getByText("Enabled")).toHaveClass("commandChip", "positive");
    expect(screen.getByRole("button", { name: "Recheck" })).toHaveClass("commandQuietAction");
    expect(styles).toMatch(/\.repositoryRow \.repositoryRowTitle strong\s*\{[^}]*font-size:\s*var\(--text-sm\)/);
  });
  it("keeps session loading titles on the shared desktop and mobile header scale", () => {
    expect(styles).not.toMatch(/\.sessionLoadingHero|\.sessionLoadingProvider/);
    expect(styles).toMatch(/\.commandSessionView \.hero h1\s*\{[^}]*font:\s*600 var\(--text-title\)\/1\.25 var\(--font-ui\)/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionView \.hero h1\s*\{\s*font-size:\s*22px/);
  });

  it("keeps the application identity provider-neutral with a shared logo and wordmark", () => {
    render(<SettingsPage initialSection="about" />);

    expect(screen.getByRole("heading", { name: "About Pomegr" })).toBeInTheDocument();
    expect(shellSource).toMatch(/<PomegrBrand href="\/" label="Pomegr home"/);
    expect(brandSource).not.toMatch(/<svg|brandMobileWordmark|brandText/);
    expect(brandSource).toMatch(/className=\{`pomegrMark pomegrMark-\$\{variant\}/);
    expect(brandSource).not.toMatch(/fruitPath|brandMarkDividers/);
    expect(existsSync(join(process.cwd(), "public", "pomegr-mark-painted.png"))).toBe(true);
    expect(existsSync(join(process.cwd(), "public", "pomegr-mark-brush-outline.png"))).toBe(true);
    expect(brandSource).toMatch(/className="brandWordmark">Pomegr/);
    expect(screen.getByText("Known issues", { selector: "summary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "openai/codex#35300 (opens in a new tab)", hidden: true })).toHaveAttribute("href", "https://github.com/openai/codex/issues/35300");
    expect(layoutSource).toMatch(/icons:\s*\{[\s\S]*?\/favicon\.png/);
  });

  it("uses restrained typography, shared readable typography and restrained control geometry", () => {
    expect(styles).not.toMatch(/Arial|Helvetica/);
    expect(styles).not.toMatch(/\.(contextHistory|requestSnapshot|contextArea|contextSeriesLine|contextChartPoint|contextBoundary)/);
    expect(styles).toMatch(/\.requestsActionsCompaction line\s*\{[^}]*stroke-dasharray:\s*3 4/);
    expect(styles).toMatch(/\.requestsActionsBar:focus-visible \.requestsActionsHit\s*\{[^}]*stroke:\s*var\(--focus-ring\)/);
    expect(layoutSource).toMatch(/<html[^>]*className=\{`\$\{inter.variable\} \$\{geistMono.variable\}`\}/);
    expect(styles).toMatch(/--control-radius:\s*4px/);
    expect(styles).toMatch(/--panel-radius:\s*6px/);
    expect(styles).toMatch(/--text-caption:\s*11px/);
    expect(styles).toMatch(/\.panelHeader h2[^}]*font-size:\s*var\(--text-sm\)/);
    expect(styles).toMatch(/\.commandNavItem\s*\{[^}]*display:\s*grid;[^}]*align-items:\s*center/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSidebar\.isOpen\s*\{[^}]*transform:\s*translateX\(0\)/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandHeader\s*\{[^}]*grid-template-columns:\s*44px max-content minmax\(0, 1fr\)[^}]*gap:\s*0/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandHeader \.brand\s*\{[^}]*grid-column:\s*2/);
    expect(styles).toMatch(/\.pomegrMark-divided\s*\{\s*--pomegr-mark-image:\s*url\("\/pomegr-mark-painted\.png"\)/);
    expect(styles).toMatch(/\.pomegrMark-outline\s*\{\s*--pomegr-mark-image:\s*url\("\/pomegr-mark-brush-outline\.png"\)/);
    expect(styles).toMatch(/\.pomegrMark\s*\{[^}]*background:\s*var\(--command-brand-text\)[^}]*mask-image:\s*var\(--pomegr-mark-image\)[^}]*mask-mode:\s*luminance/);
    expect(styles).toMatch(/\.commandHeader \.brandMark\s*\{[^}]*width:\s*var\(--command-brand-mark-size\)/);
    expect(styles).toMatch(/\.commandHeader \.brandWordmark\s*\{[^}]*color:\s*var\(--command-muted\)[^}]*font:\s*400 15px var\(--font-ui\)/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandHeader > \.commandSearch\s*\{[^}]*display:\s*flex;[^}]*transform:\s*translateX\(44px\)/);
    expect(styles).toMatch(/\.commandHeader\.isSearchOpen > \.commandSearch\s*\{[^}]*transform:\s*none;[^}]*transform \.22s cubic-bezier\(\.16, 1, \.3, 1\)/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.commandHeader > \.commandSearch\s*\{[^}]*transform:\s*none/);
    expect(styles).toMatch(/\.commandSearch:focus-within\s*\{\s*border-color:\s*var\(--command-faint\);\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px/);
    expect(styles).toMatch(/\.commandSearch input:focus-visible\s*\{\s*outline:\s*none/);
    expect(styles).toMatch(/\.commandSessionColActivity\s*\{\s*width:\s*280px/);
    expect(styles).toMatch(/\.commandTableActivityLabel\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandTableActivityColumn\s*\{\s*display:\s*none/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandTableActivityCompact\s*\{[^}]*display:\s*flex/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable\s*\{[^}]*min-width:\s*0;[^}]*display:\s*block;[^}]*table-layout:\s*auto/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable tbody tr\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\) 44px/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    expect(styles).toMatch(/\.commandSessionView \.hero h1\s*\{[^}]*var\(--font-ui\)/);
    expect(styles).toMatch(/\.pullRequestTitle em, \.branchComparison\s*\{[^}]*font-size:\s*var\(--text-xs\)/);
    expect(styles).toMatch(/\.commandShell :where\(button:not\(\.agentChip\), input, select\)\s*\{\s*font:\s*inherit/);
    expect(styles).toMatch(/--popover:\s*var\(--color-raised\)/);
    expect(styles).toMatch(/html\[data-theme="dark"\][\s\S]*?--color-raised:\s*#23272d/);
    expect(styles).toMatch(/\.agentPopover\s*\{[^}]*background:\s*var\(--popover\)[^}]*box-shadow:\s*var\(--popover-shadow\)/);
    expect(styles).toMatch(/\.agentsPanel:has\(\.cacheRefillPopover\)\s*\{\s*z-index:\s*10/);
    expect(styles).toMatch(/\.tooltipPopover\s*\{[^}]*padding:\s*9px 11px[^}]*border:\s*1px solid var\(--popover-line\)[^}]*background:\s*var\(--popover\)/);
  });

  it("preserves the current activity icon animation and reduced-motion opt-out", () => {
    expect(styles).toMatch(/\.currentActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/\.commandTableActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/@keyframes activityPulse\s*\{\s*50%\s*\{\s*transform:\s*scale\(\.55\);\s*opacity:\s*\.45/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.currentActivityMark::before,[\s\S]*?\.commandTableActivityMark::before,[\s\S]*?animation: none/);
    expect(layoutSource).not.toMatch(/font-rokkitt|localFont/);
  });

  it("defines the six shared button roles with one radius, one focus ring, and one disabled state", () => {
    expect(styles).toMatch(/\.commandPrimaryAction\s*\{[^}]*min-height:\s*var\(--control-height\)[^}]*background:\s*var\(--command-brand\)[^}]*color:\s*#fff[^}]*font-size:\s*var\(--text-sm\)/);
    expect(styles).toMatch(/\.commandSecondaryAction\s*\{[^}]*min-height:\s*var\(--control-compact\)[^}]*border:\s*1px solid var\(--command-line\)[^}]*background:\s*transparent[^}]*font-size:\s*var\(--text-xs\)/);
    expect(styles).toMatch(/\.commandSecondaryAction:hover:not\(:disabled\), \.commandSecondaryAction\[aria-pressed="true"\][^{]*\{[^}]*border-color:\s*var\(--command-line-strong\);[^}]*background:\s*var\(--command-panel-2\)/);
    expect(styles).toMatch(/\.commandSegmented\s*\{[^}]*overflow:\s*hidden;[^}]*border:\s*1px solid var\(--command-line\);[^}]*border-radius:\s*var\(--control-radius\)/);
    expect(styles).toMatch(/\.commandSegmented > button\s*\{[^}]*min-height:\s*30px;[^}]*border:\s*0;/);
    expect(styles).toMatch(/\.commandSegmented > button \+ button\s*\{\s*border-left:\s*1px solid var\(--command-line\)/);
    expect(styles).toMatch(/\.commandSegmented > button\[aria-pressed="true"\]\s*\{\s*background:\s*var\(--command-panel-2\);\s*color:\s*var\(--command-ink\)/);
    expect(styles).toMatch(/\.commandQuietAction\s*\{[^}]*min-height:\s*28px;[^}]*padding:\s*0 6px;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*color:\s*var\(--command-muted\)/);
    expect(styles).toMatch(/\.commandQuietAction:hover:not\(:disabled\)[^{]*\{[^}]*color-mix\(in srgb, var\(--command-ink\) 6%, transparent\)/);
    expect(styles).toMatch(/\.commandTextLink\s*\{[^}]*border:\s*0;[^}]*color:\s*var\(--command-brand-text\)[^}]*font-weight:\s*400/);
    expect(styles).toMatch(/\.commandTextLink:hover:not\(:disabled\)\s*\{\s*text-decoration:\s*underline;\s*text-underline-offset:\s*3px/);
    expect(styles).toMatch(/\.commandIconAction\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*border:\s*0/);
    expect(styles).toMatch(/\.commandQuietAction > svg\s*\{[^}]*width:\s*14px;[^}]*fill:\s*none;[^}]*stroke:\s*currentColor/);
    expect(styles).toMatch(/\.commandIconAction > svg\s*\{[^}]*width:\s*16px;[^}]*fill:\s*none;[^}]*stroke:\s*currentColor/);
    expect(styles).toMatch(/\.commandPrimaryAction:focus-visible, \.commandSecondaryAction:focus-visible, \.commandQuietAction:focus-visible, \.commandTextLink:focus-visible, \.commandIconAction:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus-ring\);\s*outline-offset:\s*2px/);
    expect(styles).toMatch(/\.commandPrimaryAction:disabled, \.commandSecondaryAction:disabled, \.commandQuietAction:disabled, \.commandTextLink:disabled, \.commandIconAction:disabled, \.commandSegmented > button:disabled\s*\{[^}]*opacity:\s*\.48/);
    expect(styles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\)\s*\{\s*\.commandPrimaryAction, \.commandSecondaryAction, \.commandQuietAction, \.commandSegmented > button\s*\{\s*min-height:\s*44px/);
    expect(styles).not.toMatch(/\.requestsActionsButton|\.commandPrimaryButton|\.commandSecondaryButton|\.repositoryQuietButton/);
  });

  it("keeps session progress semantic, flat, and motion-safe", () => {
    expect(animatedProgressSource).toMatch(/<progress[^>]*aria-label=\{label\}[^>]*aria-valuetext=\{valueText\}/);
    expect(animatedProgressSource).toMatch(/transform: `scaleX\(\$\{scale\}\)`/);
    expect(sessionProgressSource).toMatch(/Recorded agent estimate/);
    expect(sessionProgressSource).toMatch(/May be stale — later primary-agent activity was observed/);
    expect(styles).toMatch(/\.sessionProgressPanel\s*\{[^}]*overflow:\s*hidden/);
    expect(styles).toMatch(/\.animatedProgressSemantic\s*\{[^}]*appearance:\s*none/);
    expect(styles).toMatch(/\.animatedProgressFill\s*\{[^}]*transform-origin:\s*left center/);
    expect(styles).not.toMatch(/(?:animation|transition)-duration:\s*\.01ms/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.attentionGlyph[\s\S]*?\.uiSkeleton \{ animation: none; \}/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.limitTrack i[\s\S]*?\.commandNotificationEntry \{ transition: none; \}/);
  });

  it("shares one official chip contract between .commandChip and .agentChip, with tones that recolor text only", () => {
    expect(styles).toMatch(/\.commandChip\s*\{[^}]*min-height:\s*20px;[^}]*padding:\s*2px 7px;[^}]*border:\s*1px solid var\(--command-line\);[^}]*border-radius:\s*var\(--control-radius\);[^}]*font:\s*500 var\(--text-caption\)\/1\.3 var\(--font-ui\);[^}]*letter-spacing:\s*0;[^}]*text-transform:\s*none;/);
    expect(styles).toMatch(/\.commandChip > i\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/);
    expect(styles).toMatch(/\.commandChip\.info\s*\{\s*color:\s*var\(--command-blue\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.positive\s*\{\s*color:\s*var\(--command-green\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.warning\s*\{\s*color:\s*var\(--command-amber\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.negative\s*\{\s*color:\s*var\(--command-error\);\s*\}/);
    expect(styles).not.toMatch(/\.commandChip\.(?:info|positive|warning|negative)\s*\{[^}]*background/);
    expect(styles).toMatch(/\.agentChip\s*\{[^}]*min-height:\s*20px;[^}]*padding:\s*2px 7px;[^}]*border:\s*1px solid var\(--line\);[^}]*border-radius:\s*var\(--control-radius\);[^}]*font:\s*500 var\(--text-caption\)\/1\.3 var\(--font-ui\);[^}]*letter-spacing:\s*0;[^}]*text-transform:\s*none;/);
    expect(styles).toMatch(/\.agentSignal, \.executionTaskSignal, \.sessionSignal \{ color: var\(--muted\); \}/);
    expect(styles).not.toMatch(/\.agentSignal\.(?:info|positive|warning|negative)[^{]*\{[^}]*background/);
    expect(styles).not.toMatch(/\.executionTaskSignal\.(?:info|positive|warning|negative)[^{]*\{[^}]*background/);
    expect(styles).not.toMatch(/\.sessionSignal\.(?:info|positive|warning|negative)[^{]*\{[^}]*background/);
  });

  it("uses the shared chip contract for coming-soon panels with a readable title gap", () => {
    expect(commandPageSource).toMatch(/<span className="commandChip">Coming soon<\/span>/);
    expect(commandPageSource).not.toMatch(/commandBadge/);
    expect(styles).toMatch(/\.commandSettingsPane \.commandComingSoon h2\s*\{\s*margin-top:\s*8px/);
  });
});
