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
const requestsActionsPath = join(process.cwd(), "app", "components", "dashboard", "requests-actions");
const laneChartSource = readFileSync(join(requestsActionsPath, "RequestLaneChart.tsx"), "utf8");
const laneModelSource = readFileSync(join(requestsActionsPath, "lane-model.ts"), "utf8");
const minimapSource = readFileSync(join(requestsActionsPath, "RequestMinimap.tsx"), "utf8");
const requestsPanelSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "RequestsActionsPanel.tsx"), "utf8");
const activityStyles = readFileSync(join(process.cwd(), "app", "styles", "activity-feed.css"), "utf8");
const evidenceStyles = readFileSync(join(process.cwd(), "app", "styles", "evidence.css"), "utf8");
const signalsTabStyles = readFileSync(join(process.cwd(), "app", "components", "dashboard", "SignalsTab.module.css"), "utf8");
const designContract = readFileSync(join(process.cwd(), "DESIGN.md"), "utf8");
/** Innermost rules only: the selector is whatever precedes a brace-free declaration block. */
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

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
    expect(styles).toMatch(/\.commandPageHeader h1\s*\{[^}]*font:\s*600 var\(--text-title\)\/1\.25 var\(--font-ui\)/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionView > \.commandPageHeader h1\s*\{\s*font-size:\s*22px/);
  });

  it("keeps the phone request identity on a stable row above the minimap", () => {
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.requestRoleNamed\s*\{[^}]*flex:\s*0 0 100%;[^}]*width:\s*100%/);
  });

  it("keeps the phone Signals title below sticky application chrome", () => {
    expect(signalsTabStyles).toMatch(/@media \(max-width: 640px\)[\s\S]*?\.tab\s*\{[^}]*--signals-phone-sticky-offset:\s*56px;[^}]*margin-top:\s*calc\(-1 \* var\(--signals-phone-sticky-offset\)\);[^}]*padding-top:\s*var\(--signals-phone-sticky-offset\);[^}]*scroll-margin-top:\s*var\(--signals-phone-sticky-offset\)/);
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
    expect(styles).toMatch(/\.requestsActionsLargest\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap/);
    expect(styles).toMatch(/\.requestsActionsLargestName\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
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
    expect(styles).toMatch(/\.commandPaletteTrigger\.commandQuietAction\s*\{[^}]*width:\s*280px;[^}]*height:\s*var\(--control-height\)/);
    expect(styles).toMatch(/@media \(max-width: 1080px\)[\s\S]*?\.commandPaletteTrigger\s*\{\s*width:\s*200px/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandHeader > \.commandPaletteTrigger\s*\{[^}]*width:\s*44px/);
    expect(styles).toMatch(/\.commandPalette\s*\{[^}]*box-shadow:\s*var\(--command-overlay-shadow\)/);
    expect(styles).toMatch(/\.commandSearch:focus-within\s*\{[^}]*border-color:\s*var\(--command-ink\);[^}]*outline:\s*0/);
    expect(styles).toMatch(/\.commandSearch input:focus-visible\s*\{[^}]*outline:\s*0/);
    expect(styles).toMatch(/\.commandPalette > header:focus-within\s*\{[^}]*border-bottom-color:\s*var\(--command-line-strong\)/);
    expect(styles).toMatch(/\.commandPalette > header input:focus-visible\s*\{[^}]*outline:\s*0/);
    expect(shellSource).not.toMatch(/hasBreadcrumb|sessionBreadcrumb/);
    expect(commandPageSource).toMatch(/export function CommandPageHeader/);
    expect(styles).toMatch(/\.commandPageTabs\s*\{[^}]*border-bottom:\s*1px solid var\(--command-line\)/);
    expect(styles).toMatch(/\.commandSidebarLimits\s*\{[^}]*margin-bottom:\s*12px/);
    expect(shellSource).toMatch(/className="commandQuietAction commandPaletteTrigger"/);
    expect(shellSource).toMatch(/commandQuietAction commandPaletteOption/);
    expect(styles).toMatch(/\.commandSidebarLimit\.normal strong\s*\{\s*color:\s*var\(--command-blue\);/);
    expect(styles).toMatch(/\.commandSidebarLimit\.warning strong\s*\{\s*color:\s*var\(--command-amber\);/);
    expect(styles).toMatch(/\.commandSidebarLimit\.critical strong\s*\{\s*color:\s*var\(--command-error\);/);
    expect(styles).toMatch(/\.commandSidebarLimit\.normal > i > b\s*\{\s*background:\s*var\(--command-blue\);/);
    expect(styles).toMatch(/\.commandSidebarLimit\.warning > i > b\s*\{\s*background:\s*var\(--command-amber\);/);
    expect(styles).toMatch(/\.commandSidebarLimit\.critical > i > b\s*\{\s*background:\s*var\(--command-error\);/);
    expect(styles).toMatch(/\.commandSessionColActivity\s*\{\s*width:\s*280px/);
    expect(styles).toMatch(/\.commandTableActivityLabel\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandTableActivityColumn\s*\{\s*display:\s*none/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandTableActivityCompact\s*\{[^}]*display:\s*flex/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable\s*\{[^}]*min-width:\s*0;[^}]*display:\s*block;[^}]*table-layout:\s*auto/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable tbody tr\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\) 44px/);
    expect(styles).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.commandSessionTable td\[data-label\]::before\s*\{[^}]*content:\s*attr\(data-label\)/);
    expect(styles).toMatch(/\.pullRequestTitle em, \.branchComparison\s*\{[^}]*font-size:\s*var\(--text-xs\)/);
    expect(styles).toMatch(/\.commandShell :where\(button:not\(\.agentChip, \.commandChip\), input, select\)\s*\{\s*font:\s*inherit/);
    expect(styles).toMatch(/--popover:\s*var\(--color-raised\)/);
    expect(styles).toMatch(/html\[data-theme="dark"\][\s\S]*?--color-raised:\s*#23272d/);
    expect(styles).toMatch(/\.agentPopover\s*\{[^}]*background:\s*var\(--popover\)[^}]*box-shadow:\s*var\(--popover-shadow\)/);
    expect(styles).toMatch(/\.agentsPanel:has\(\.cacheRefillPopover\)\s*\{\s*z-index:\s*10/);
    expect(styles).toMatch(/\.tooltipPopover\s*\{[^}]*padding:\s*9px 11px[^}]*border:\s*1px solid var\(--popover-line\)[^}]*background:\s*var\(--popover\)/);
  });

  it("keeps request lanes labeled and collapsible, the minimap neutral, and role tint in the single-chart track only", () => {
    expect(styles).toMatch(/\.requestsActionsPlot\s*\{\s*--lane-label-width:\s*220px;/);
    expect(styles).toMatch(/\.requestLane, \.requestLaneAxisRow, \.requestLaneGroupHeader\s*\{[^}]*grid-template-columns:\s*var\(--lane-label-width\) minmax\(0, 1fr\)/);
    expect(styles).toMatch(/\.requestLaneName\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;\s*white-space:\s*nowrap/);
    expect(styles).toMatch(/\.requestLaneMeta\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;\s*white-space:\s*nowrap/);
    expect(styles).toMatch(/\.requestLaneLabel\.commandQuietAction\[aria-pressed="true"\]\s*\{\s*background:\s*color-mix\(in srgb, var\(--command-ink\) 6%, transparent\)/);
    expect(styles).toMatch(/\.requestLane\.isGroupMember > \.requestLaneLabel\s*\{\s*padding-left:\s*calc\(var\(--lane-label-bleed\) \+ var\(--space-4\)\)/);
    expect(styles).toMatch(/\.requestLaneChevron\s*\{[^}]*width:\s*12px;\s*height:\s*12px/);
    expect(styles).toMatch(/\.requestLaneMaximum\s*\{[^}]*font:\s*var\(--text-caption\) var\(--font-data\)/);
    expect(laneChartSource).toMatch(/export const MAXIMUM_GUTTER = 72;/);
    expect(laneChartSource).toMatch(/const PRIMARY = \{ band: 22, plot: 96 \};\s*const SECONDARY = \{ band: 18, plot: 34 \};/);
    expect(laneChartSource).toMatch(/className="commandQuietAction requestLaneLabel"/);
    expect(laneModelSource).toMatch(/export const LANE_COLLAPSE_THRESHOLD = 8;/);
    expect(requestsPanelSource).toMatch(/\{!phone && <div className="commandSegmented" role="group" aria-label="Chart layout">/);

    const tinted = [...styles.matchAll(/([^{}]+)\{[^}]*var\(--(?:session-role|role-)[^}]*\}/g)].map((match) => match[1].trim());
    expect(tinted.filter((selector) => /requestLane|requestsActionsMini/.test(selector))).toEqual([]);
    expect(styles).toMatch(/\.requestRoleSegment\s*\{\s*fill:\s*var\(--session-role, var\(--command-line-strong\)\)/);
    expect(styles).toMatch(/\.sessionRoleLegend\.requestRoleLegend > span\s*\{\s*text-transform:\s*none/);
    for (const source of [laneChartSource, laneModelSource, minimapSource]) expect(source).not.toMatch(/roleFamily|role-family/);

    expect(styles).toMatch(/\.requestsActionsMiniBar\s*\{\s*fill:\s*var\(--command-line-strong\)/);
    expect(styles).toMatch(/\.requestsActionsMiniWindow\s*\{\s*fill:\s*color-mix\(in srgb, var\(--command-muted\) 12%, transparent\);\s*stroke:\s*var\(--command-muted\)/);
    expect(styles).not.toMatch(/\.requestsActionsMini[^{]*\{[^}]*(?:--command-brand|--brand|--session-role|--role-)/);
    expect(minimapSource).toMatch(/aria-describedby=\{interactive \? hintId : undefined\}/);
  });

  // Guards for the two documented phone Activities exceptions. They hold before parts 8-9 write the
  // CSS, so those parts add the styles under these selectors instead of editing this test.
  it("scopes the phone Activities brand left rule and 32px call line to their documented selectors", () => {
    expect(designContract).toMatch(/`\.activityLayout\.isPhone \.activityTableFrame\.isSelectedRequest`/);
    expect(designContract).toMatch(/`\.activityCallLine`\) is 32px high/);

    const brandLeftRule = rules.filter(({ body }) => /border-(?:left|inline-start):[^;]*var\(--(?:command-|color-)?brand/.test(body));
    expect(brandLeftRule.map(({ selector }) => selector).filter((selector) => !/\.activityLayout\.isPhone\b/.test(selector) || !/\.isSelectedRequest\b/.test(selector))).toEqual([]);

    const denseActivityRow = rules.filter(({ selector, body }) => /\bactivity/i.test(selector) && /(?:min-)?height:\s*32px/.test(body));
    expect(denseActivityRow.map(({ selector }) => selector).filter((selector) => !/\.activityCallLine\b/.test(selector))).toEqual([]);

    expect(styles).toMatch(/\.activityLayout\.isPhone \.activityBreakdown\s*\{[^}]*border-top:\s*1px solid var\(--line\)/);
    expect(activityStyles).toMatch(/\.activityLayout:not\(\.isPhone\) \.activityFeed\s*\{[^}]*grid-template-columns:\s*max-content max-content fit-content\(300px\) minmax\(0, 1fr\) minmax\(72px, max-content\)/);
    expect(activityStyles).toMatch(/\.activityRequestRow\.activityRow\s*\{[^}]*grid-template-columns:\s*subgrid/);
    expect(activityStyles).toMatch(/\.activityDesktopCallRow\.activityRow\s*\{[^}]*grid-template-columns:\s*subgrid/);
    expect(activityStyles).toMatch(/\.activityDesktopCallRow\.activityRow > time\s*\{[^}]*grid-column:\s*2[^}]*white-space:\s*nowrap/);
    expect(activityStyles).toMatch(/\.activityActionLabel\s*\{[^}]*font-weight:\s*400/);
    expect(evidenceStyles).not.toMatch(/\.activity(?:Panel|Layout|CallLine|RequestRow|DesktopCallRow)\b/);
  });

  // The kind header and its rows share one column template, so `count`, `share` and `median` label
  // their own columns. A floor on the label or bar column pushes that column past the rail edge on
  // a narrow or text-scaled phone, where the label ellipsis should absorb the loss instead.
  it("keeps the kind rail header and rows on one shrinkable column template", () => {
    const templates = [...styles.matchAll(/--activity-kind-columns:\s*([^;]+);/gu)].map(([, value]) => value.trim());
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const template of templates) expect(template).toMatch(/^16px minmax\(0, 1fr\) minmax\(0, \d+px\)/u);
    expect(styles).toMatch(/\.activityBreakdown header\s*\{[^}]*grid-template-columns:\s*var\(--activity-kind-columns\)/u);
    expect(styles).toMatch(/\.activityBreakdown \.activityKindRow\s*\{[^}]*grid-template-columns:\s*var\(--activity-kind-columns\)/u);
  });

  it("preserves the current activity icon animation and reduced-motion opt-out", () => {
    expect(styles).toMatch(/\.currentActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/\.commandTableActivityMark::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/\.sessionCurrentActivityMark\.isCurrent::before\s*\{[^}]*animation:\s*activityPulse 1\.8s ease-in-out infinite/);
    expect(styles).toMatch(/@keyframes activityPulse\s*\{\s*50%\s*\{\s*transform:\s*scale\(\.55\);\s*opacity:\s*\.45/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.currentActivityMark::before,[\s\S]*?\.commandTableActivityMark::before,[\s\S]*?animation: none/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.sessionCurrentActivityMark\.isCurrent::before\s*\{\s*animation:\s*none;\s*opacity:\s*\.7/);
    expect(styles).toMatch(/\.currentActivityShimmer\s*\{[^}]*position:\s*relative;[^}]*color:\s*var\(--command-muted\)/);
    expect(styles).toMatch(/\.currentActivityShimmer::before\s*\{[^}]*content:\s*attr\(data-text\);[^}]*linear-gradient\(90deg, transparent 0%, transparent 40%, var\(--command-ink\) 50%, transparent 60%, transparent 100%\);[^}]*background-size:\s*400% 100%;[^}]*background-repeat:\s*no-repeat;[^}]*-webkit-background-clip:\s*text;[^}]*background-clip:\s*text;[^}]*animation:\s*currentActivityTextShimmer 2000ms linear infinite/);
    expect(styles).toMatch(/@keyframes currentActivityTextShimmer\s*\{\s*from\s*\{\s*background-position:\s*100% 0;\s*\}\s*to\s*\{\s*background-position:\s*0 0/);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.currentActivityShimmer::before\s*\{\s*animation:\s*none/);
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
    expect(styles).toMatch(/\.commandQuietAction\.panelHeadingLink\s*\{[^}]*padding:\s*0;[^}]*color:\s*var\(--command-ink\);[^}]*font:\s*inherit/);
    expect(styles).toMatch(/\.commandQuietAction\.panelHeadingLink > svg\s*\{\s*color:\s*var\(--command-faint\)/);
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
    expect(styles).toMatch(/\.commandChip\s*\{[^}]*min-height:\s*20px;[^}]*padding:\s*2px 7px;[^}]*border:\s*1px solid var\(--command-line\);[^}]*border-radius:\s*var\(--control-radius\);[^}]*background:\s*transparent;[^}]*font:\s*500 var\(--text-caption\)\/1\.3 var\(--font-ui\);[^}]*letter-spacing:\s*0;[^}]*text-transform:\s*none;/);
    expect(styles).toMatch(/\.commandChip > i\s*\{[^}]*width:\s*6px;[^}]*height:\s*6px;/);
    expect(styles).toMatch(/\.commandChip\.info\s*\{\s*color:\s*var\(--command-blue\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.positive\s*\{\s*color:\s*var\(--command-green\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.warning\s*\{\s*color:\s*var\(--command-amber\);\s*\}/);
    expect(styles).toMatch(/\.commandChip\.negative\s*\{\s*color:\s*var\(--command-error\);\s*\}/);
    expect(styles).not.toMatch(/\.commandChip\.(?:info|positive|warning|negative)\s*\{[^}]*background/);
    expect(styles).toMatch(/\.agentChip\s*\{[^}]*min-height:\s*20px;[^}]*padding:\s*2px 7px;[^}]*border:\s*1px solid var\(--line\);[^}]*border-radius:\s*var\(--control-radius\);[^}]*background:\s*transparent;[^}]*font:\s*500 var\(--text-caption\)\/1\.3 var\(--font-ui\);[^}]*letter-spacing:\s*0;[^}]*text-transform:\s*none;/);
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
