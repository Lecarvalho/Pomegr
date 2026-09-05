import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "../../app/settings/SettingsPage";

const styleEntry = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8");
const styles = [...styleEntry.matchAll(/@import "\.\/(.+?\.css)";/g)]
  .map((match) => readFileSync(join(process.cwd(), "app", match[1]), "utf8")).join("\n");
const layoutSource = readFileSync(join(process.cwd(), "app", "layout.tsx"), "utf8");
const shellSource = readFileSync(join(process.cwd(), "app", "components", "command-center", "CommandCenterShell.tsx"), "utf8");
const brandSource = readFileSync(join(process.cwd(), "app", "components", "PomegrBrand.tsx"), "utf8");
const contextHistorySource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "ContextHistoryPanel.tsx"), "utf8");
const requestSnapshotsSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "RequestSnapshotsPanel.tsx"), "utf8");
const sessionProgressSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "SessionProgressPanel.tsx"), "utf8");
const animatedProgressSource = readFileSync(join(process.cwd(), "app", "components", "AnimatedProgress.tsx"), "utf8");

describe("Pomegr visual contract", () => {
  it("keeps session loading titles on the shared desktop and mobile header scale", () => {
    expect(styles).not.toMatch(/\.sessionLoadingHero|\.sessionLoadingProvider/);
    expect(styles).toMatch(/\.commandSessionView \.hero h1\s*\{[^}]*font:\s*600 var\(--text-title\)\/1\.25 var\(--font-ui\)/);
    expect(styles).toMatch(/@media \(max-width: 520px\)[\s\S]*?\.commandSessionView \.hero h1\s*\{\s*font-size:\s*24px/);
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

  it("uses restrained typography, a single inspectable context line, and shared readable typography and restrained control geometry", () => {
    expect(styles).not.toMatch(/Arial|Helvetica/);
    expect(layoutSource).toMatch(/<html[^>]*className=\{`\$\{inter.variable\} \$\{geistMono.variable\}`\}/);
    expect(styles).toMatch(/--control-radius:\s*4px/);
    expect(styles).toMatch(/--panel-radius:\s*6px/);
    expect(styles).toMatch(/html\[data-theme="dark"\] \.agentRow\.idleAgent \.agentIdentity span,[^{]+\{ color: var\(--muted\); \}/);
    expect(styles).toMatch(/\.contextHistoryLine\s*\{[^}]*stroke:\s*var\(--blue\);[^}]*stroke-width:\s*2\.25/);
    expect(styles).toMatch(/\.contextBoundary line\s*\{[^}]*stroke-dasharray:\s*3 4/);
    expect(styles).toMatch(/\.contextHistoryChart:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus-ring\)/);
    expect(contextHistorySource).toMatch(/role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?Use Left and Right arrow keys/);
    expect(contextHistorySource).not.toMatch(/role="listitem"[\s\S]*?tabIndex=\{0\}/);
    expect(contextHistorySource).not.toMatch(/ContextGrowthTimeline|cacheReadArea|context added|Cache evidence|cacheEvents/);
    expect(requestSnapshotsSource).toMatch(/role="group"[\s\S]*?tabIndex=\{0\}[\s\S]*?Use Left and Right arrow keys/);
    expect(requestSnapshotsSource).toMatch(/snapshotEventKey\(event\.agentId, event\.observedAt\)/);
    expect(requestSnapshotsSource).toMatch(/className="contextAreaChart requestSnapshotAreaChart"/);
    expect(requestSnapshotsSource).toMatch(/className=\{`contextSeriesLine/);
    expect(requestSnapshotsSource).toMatch(/className=\{`contextChartPoint/);
    expect(requestSnapshotsSource).toMatch(/role="switch"[\s\S]*?aria-checked=\{visibleSeries\[component\.key\]\}/);
    expect(requestSnapshotsSource).not.toMatch(/requestSnapshotBar|requestSnapshotStack|MINIMUM_BAR_STEP/);
    expect(styles).toMatch(/\.requestSnapshotViewport\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*auto/);
    expect(styles).toMatch(/\.contextSeriesLine\.cacheWriteLine\s*\{\s*stroke:\s*var\(--green\)/);
    expect(styles).toMatch(/\.contextSeriesLine\.cacheReadLine\s*\{\s*stroke:\s*var\(--brand\)/);
    expect(styles).toMatch(/\.contextSeriesLine\s*\{[^}]*stroke-linecap:\s*round;[^}]*stroke-linejoin:\s*round/);
    expect(styles).toMatch(/\.requestSnapshotPoints\s*\{[^}]*grid-template-columns:\s*repeat\(var\(--snapshot-count\), minmax\(0, 1fr\)\)/);
    expect(styles).not.toMatch(/\.requestSnapshotBar|\.requestSnapshotStack/);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.requestSnapshotReadout dl\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(styles).toMatch(/@media \(max-width: 420px\)[\s\S]*?\.requestSnapshotReadout\s*\{\s*margin-left:\s*0/);
    expect(styles).toMatch(/\.panelHeader h2[^}]*font-size:\s*var\(--text-sm\)/);
    expect(styles).toMatch(/\.ghostButton, \.desktopControls > summary\s*\{[^}]*font-size:\s*var\(--text-sm\)/);
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
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.agentTitleLine \.executionTaskAnchor\s*\{\s*flex:\s*0 0 100%/);
    expect(styles).toMatch(/\.agentChip, \.pullRequestBadge[^}]*font-size:\s*var\(--text-xs\)/);
    expect(styles).toMatch(/\.commandShell :where\(button:not\(\.agentChip\), input, select\)\s*\{\s*font:\s*inherit/);
    expect(styles).toMatch(/--popover:\s*var\(--color-raised\)/);
    expect(styles).toMatch(/html\[data-theme="dark"\][\s\S]*?--color-raised:\s*#23272d/);
    expect(styles).toMatch(/\.agentPopover\s*\{[^}]*background:\s*var\(--popover\)[^}]*box-shadow:\s*var\(--popover-shadow\)/);
    expect(styles).toMatch(/\.agentsPanel\.hasOpenPopover, \.agentsPanel:has\(\.cacheRefillPopover\)\s*\{\s*z-index:\s*10/);
    expect(styles).toMatch(/\.tooltipPopover\s*\{[^}]*padding:\s*9px 11px[^}]*border:\s*1px solid var\(--popover-line\)[^}]*background:\s*var\(--popover\)/);
  });

  it("preserves the current activity icon animation and reduced-motion opt-out", () => {
    expect(styles).toMatch(/\.currentActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/\.commandTableActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/@keyframes activityPulse\s*\{\s*50%\s*\{\s*transform:\s*scale\(\.55\);\s*opacity:\s*\.45/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.currentActivityMark::before,[\s\S]*?\.commandTableActivityMark::before,[\s\S]*?animation: none/);
    expect(layoutSource).not.toMatch(/font-rokkitt|localFont/);
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
});
