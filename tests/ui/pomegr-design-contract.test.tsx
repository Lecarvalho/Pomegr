import { render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsPage } from "../../app/settings/SettingsPage";
import { FileHistoryPanel } from "../../app/components/repositories/FileHistoryPanel";
import { FileTree } from "../../app/components/repositories/FileTree";
import { RepositoryRow } from "../../app/components/repositories/RepositoryRow";
import { StorageUsageBar } from "../../app/settings/StorageSettings";
import type { StorageSnapshot } from "../../shared/storage-contract";

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
const designSystemStyles = readFileSync(join(process.cwd(), "app", "styles", "design-system.css"), "utf8");
const repositoriesComponentsPath = join(process.cwd(), "app", "components", "repositories");
const fileTreeSource = readFileSync(join(repositoriesComponentsPath, "FileTree.tsx"), "utf8");
const fileTreeModelSource = readFileSync(join(repositoriesComponentsPath, "file-tree-model.ts"), "utf8");
const fileHistoryPanelSource = readFileSync(join(repositoriesComponentsPath, "FileHistoryPanel.tsx"), "utf8");
const sessionFilePanelSource = readFileSync(join(process.cwd(), "app", "components", "dashboard", "SessionFilePanel.tsx"), "utf8");
/** Innermost rules only: the selector is whatever precedes a brace-free declaration block. */
const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("Pomegr visual contract", () => {
  it("keeps consecutive-event counts in a separate non-shrinking data column", () => {
    const styles = readFileSync(join(process.cwd(), "app", "styles", "session.css"), "utf8");
    expect(styles).toMatch(/\.sessionEventRow\.isGrouped\s*\{\s*grid-template-columns: 40px 16px minmax\(0, 1fr\) auto 12px/);
    expect(styles).toMatch(/\.sessionEventCount\s*\{[^}]*var\(--text-caption\)[^}]*var\(--font-data\)[^}]*white-space: nowrap/);
  });
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
    expect(styles).toMatch(/\.sessionStartedMeta\s*\{[^}]*font:\s*400 var\(--text-xs\)\/1\.4 var\(--font-ui\)/);
    expect(styles).toMatch(/\.sessionStartedMeta time\s*\{[^}]*font-family:\s*var\(--font-data\);[^}]*font-variant-numeric:\s*tabular-nums/);
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

  it("keeps the storage usage meter informational, clamped, and honest about unavailable evidence", () => {
    expect(designContract).toMatch(/always present in desktop, browser, and paired LAN/);
    expect(designContract).toMatch(/`role="meter"`/);
    expect(designContract).toMatch(/informational\s*only, never focusable and never a slider/);
    expect(designContract).toMatch(/never renders `0%` for\s*missing evidence/);
    expect(designContract).toMatch(/\*\*Storage usage\s*unavailable\*\*/);
    expect(designContract).toMatch(/\*\*Cleanup pending\*\*/);
    expect(designContract).toMatch(/\*\*Preserved history exceeds the cleanup threshold\.\*\*/);

    expect(styles).toMatch(/\.storageUsageTrack\s*\{[^}]*background:\s*var\(--command-panel-2\)/);
    expect(styles).toMatch(/\.storageUsageTrack > b\s*\{[^}]*background:\s*var\(--command-muted\)/);
    expect(styles).toMatch(/\.storageSettingsPanel\s*\{[^}]*border-radius:\s*var\(--panel-radius\)/);
    expect(styles).toMatch(/\.storageSettingsPanel \.commandSettingRow\s*\{[^}]*padding:\s*14px 16px/);
    expect(styles).not.toMatch(/\.storageUsage[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);

    const ordinary: StorageSnapshot = { revision: 1, readiness: "ready", databaseBytes: 380 * 1024 * 1024, thresholdBytes: 500 * 1024 * 1024, percent: 76, oldestRetainedDay: null, lastPrunedAt: null, retentionDays: 90, cleanupStatus: "normal" };
    const { rerender, container } = render(<StorageUsageBar snapshot={ordinary} />);
    expect(screen.getByText("380 MB / 500 MB · 76%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "76");

    const over = { ...ordinary, databaseBytes: 550 * 1024 * 1024, percent: 110, cleanupStatus: "cleanup_pending" as const };
    rerender(<StorageUsageBar snapshot={over} />);
    expect(screen.getByText("550 MB / 500 MB · 110%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("status")).toHaveTextContent("Cleanup pending");

    rerender(<StorageUsageBar snapshot={null} />);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    expect(container.querySelector(".storageUsageText")?.textContent).toBe("Storage usage unavailable");
  });

  it("keeps FileTree, FileHistoryPanel, and SessionFilePanel fetch-free, documented, and on the single-letter status", () => {
    // Pure presentation: neither component reads the repository-files store or fetches directly.
    for (const source of [fileTreeSource, fileTreeModelSource, fileHistoryPanelSource, sessionFilePanelSource]) {
      expect(source).not.toMatch(/repository-files-store|useSyncExternalStore|fetch\(/);
    }

    expect(designContract).toMatch(/### File tree and file history panel/);
    expect(designContract).toMatch(/`\.fileTreeStatusLetter`/);
    expect(designContract).toMatch(/amber \*\*M\*\* \(Modified\)/);
    expect(designContract).toMatch(/indent 14\/30\/46\/62px per depth/);
    expect(designContract).toMatch(/ancestors of the current\s+selection and top-level folders with 12 or fewer files/);
    expect(designContract).toMatch(/\*\*Changed elsewhere\*\*/);
    expect(designContract).toMatch(/\*\*Status from the working tree · select a\s+file for its history\*\*/);
    expect(designContract).toMatch(/\*\*Folders roll up distinct sessions\*\*/);
    expect(designContract).toMatch(/\*\*How to read this\*\*/);
    expect(designContract).toMatch(/SessionFilePanel \(`app\/components\/dashboard\/SessionFilePanel\.tsx`\)/);
    expect(designContract).toMatch(/selecting a file never waits\s+on a fetch/);
    expect(designContract).toMatch(/\*\*N changes without\s+session attribution \(moves seen in Git\)\*\*/);

    expect(styles).toMatch(/\.fileTreeStatusLetter\s*\{[^}]*margin-left:\s*auto;[^}]*font:\s*600 var\(--text-caption\)/);
    expect(styles).toMatch(/\.fileTreeRow\s*\{[^}]*padding-left:\s*calc\(14px \+ var\(--tree-depth\) \* 16px\)/);
    expect(styles).toMatch(/\.fileTreeRow\.isSelected\s*\{\s*background:\s*var\(--command-panel-2\);\s*color:\s*var\(--command-ink\);\s*\}/);
    expect(styles).toMatch(/\.fileTreeFolderRow\[aria-expanded="true"\] \.fileTreeChevron\s*\{\s*transform:\s*rotate\(90deg\);\s*\}/);
    expect(styles).toMatch(/\.fileTreeFileRow\.isMuted \.fileTreeFileName\s*\{\s*color:\s*var\(--command-muted\);\s*\}/);
    expect(styles).not.toMatch(/\.(?:fileTree|fileHistory)[^{]*\{[^}]*#[0-9a-fA-F]{3,8}/);

    // Session scope renders the single-letter status; repository scope shows counts and mutes.
    const { rerender } = render(<FileTree scope="session" rootLabel="Pomegr" files={[{ path: "a.ts", fileId: "f1", status: "M" }]} selectedPath={null} onSelect={() => {}} emptyText="No files." />);
    expect(screen.getByRole("img", { name: "Modified" })).toHaveClass("fileTreeStatusLetter", "warning");
    rerender(<FileTree scope="repository" rootLabel="Pomegr" files={[{ path: "a.ts", fileId: "f1", sessionCount: 2 }]} selectedPath={null} onSelect={() => {}} emptyText="No files." />);
    expect(screen.getByText("2")).toBeInTheDocument();

    render(<FileHistoryPanel repositoryLabel="Pomegr" path={null} workingTreeStatus={null} history={null} />);
    expect(screen.getByText("Select a file to see its recorded sessions.")).toBeInTheDocument();
  });

  it("marks a Git-observed touched row with a quiet, non-chip glyph and documents it", () => {
    expect(designContract).toMatch(/quiet 14px git glyph/);
    expect(designContract).toMatch(/muted text color, never amber/);
    expect(designContract).toMatch(/Committed by this session - not a recorded\s+tool edit/);
    expect(designContract).toMatch(/Rows\s+with\s+the\s+Git\s+glyph\s+come\s+from\s+commits\s+made\s+while\s+this\s+session\s+ran\s+a\s+Git\s+command\./);
    expect(designContract).toMatch(/Matched\s+by\s+time,\s+so\s+they\s+have\s+no\s+agent\s+or\s+request/);
    expect(designContract).not.toMatch(/Seen in Git during this session|working-tree\s+changes\s+during\s+the\s+session\s+window/);

    expect(styles).toMatch(/\.fileTreeGitObservedGlyph\s*\{[^}]*color:\s*var\(--command-muted\)/);
    expect(styles).not.toMatch(/\.fileTreeGitObservedGlyph[^}]*(amber|#[0-9a-fA-F]{3,8})/);

    render(<FileTree scope="session" rootLabel="Pomegr" files={[{ path: "a.ts", fileId: null, status: null, gitObserved: "committed" }]} selectedPath={null} onSelect={() => {}} emptyText="No files." />);
    const glyph = screen.getByRole("img", { name: "Committed by this session - not a recorded tool edit" });
    expect(glyph).toHaveAttribute("title", "Committed by this session - not a recorded tool edit");
    // No status chip renders alongside the glyph when the working tree reports no status.
    expect(document.querySelector(".fileTreeStatusLetter")).toBeNull();
    // The footer's quiet popover trigger appears only when a Git-observed row is visible.
    expect(screen.getByText("How to read this")).toBeInTheDocument();
  });

  it("draws a task column as a lane, marks the drop target with the strong line, and keeps + New task to the first lane", () => {
    // G26-G30: the raised fill with a one-pixel rule and the panel radius; the header carries its own rule; cards stay on the panel fill.
    expect(styles).toMatch(/\.taskColumn \{[^}]*padding: var\(--space-2\)[^}]*border: 1px solid var\(--command-line\)[^}]*border-radius: var\(--panel-radius\)[^}]*background: var\(--command-panel-2\)/);
    expect(styles).toMatch(/\.taskColumnHeader \{[^}]*padding: var\(--space-1\) var\(--space-1\) var\(--space-2\)[^}]*border-bottom: 1px solid var\(--command-line\)/);
    expect(styles).toMatch(/\.taskCard \{[^}]*background: var\(--command-panel\)/);
    // The raised fill is the lane itself, so the lane under a dragged card is marked by the strong line on its border instead.
    expect(styles).toMatch(/\.taskColumn\.isDropTarget \{[^}]*border-color: var\(--command-line-strong\)/);
    expect(styles).not.toMatch(/\.taskColumn\.isDropTarget \{[^}]*background/);
    // The skeleton keeps the lane shape.
    expect(styles).toMatch(/\.taskBoardSkeletonColumn \{[^}]*border: 1px solid var\(--command-line\)[^}]*border-radius: var\(--panel-radius\)[^}]*background: var\(--command-panel-2\)/);
    // G53-G58: hidden with opacity (never display or visibility), revealed by lane hover and focus, always on a coarse pointer at 44px, no motion.
    expect(styles).toMatch(/\.taskColumnAdd\.commandQuietAction \{[^}]*min-height: var\(--control-compact\)[^}]*opacity: 0/);
    expect(styles).not.toMatch(/\.taskColumnAdd[^{]*\{[^}]*(?:display: none|visibility: hidden|transition|animation)/);
    expect(styles).toMatch(/\.taskColumn:hover \.taskColumnAdd, \.taskColumn:focus-within \.taskColumnAdd \{ opacity: 1; \}/);
    expect(styles).toMatch(/@media \(max-width: 760px\), \(pointer: coarse\) \{ \.taskColumnAdd\.commandQuietAction \{ min-height: 44px; \} \}/);
    expect(styles).toMatch(/@media \(pointer: coarse\) \{ \.taskColumnAdd\.commandQuietAction \{ opacity: 1; \} \}/);
    // The Tasks page header has no primary action, the add action is the Quiet role, and a lane header holds no control.
    const pane = readFileSync(join(process.cwd(), "app", "components", "tasks", "TaskBoardPane.tsx"), "utf8");
    expect(pane).not.toMatch(/commandPrimaryAction/);
    expect(readFileSync(join(process.cwd(), "app", "components", "tasks", "NewTaskAction.tsx"), "utf8")).toMatch(/className="commandQuietAction taskColumnAdd"/);
    expect(readFileSync(join(process.cwd(), "app", "components", "tasks", "TaskColumnHeader.tsx"), "utf8")).not.toMatch(/<button/);
    // DESIGN.md and the design-system sample document the same rules.
    expect(designContract).toMatch(/A column is a \*\*lane\*\* \(`\.taskColumn`\)[^.]*raised fill[^.]*one-pixel `--command-line` border/);
    expect(designContract).toMatch(/The lane under a dragged card cannot take the raised fill, so it takes the strong line \(`--command-line-strong`\) on its border/);
    expect(designContract).toMatch(/the \*\*first lane only\*\* ends with the Quiet \*\*\+ New task\*\*/);
    expect(designContract).toMatch(/invisible \(opacity 0, never `display: none`/);
    expect(designContract).toMatch(/The header has no primary action: \*\*New task\*\* lives in the first lane\./);
    expect(designContract).toMatch(/Tasks is a root item of the primary rail, directly after Sessions/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemTaskBoardSample.tsx"), "utf8");
    expect(sample).toMatch(/Lane, \+ New task revealed/);
    expect(sample).toMatch(/Lane, drop target/);
    expect(designSystemStyles).toMatch(/\.designSystemRevealAdd \.taskColumnAdd \{ opacity: 1; \}/);
  });

  it("draws the task modal frame as a modal dialog scrim with tokens only and documents its fields", () => {
    const tasksStyles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    const tasksComponents = join(process.cwd(), "app", "components", "tasks");
    const frame = readFileSync(join(tasksComponents, "TaskModalFrame.tsx"), "utf8");
    const fields = readFileSync(join(tasksComponents, "TaskFields.tsx"), "utf8");
    const featureFields = readFileSync(join(tasksComponents, "FeatureFields.tsx"), "utf8");
    // G115-G123: the scrim mixes the text token (no literal color), the panel is at most 640px with the panel radius and overlay shadow, and nothing moves.
    expect(tasksStyles).toMatch(/\.taskModalScrim \{[^}]*background: color-mix\(in srgb, var\(--color-text\) 40%, transparent\)/);
    expect(tasksStyles).toMatch(/\.taskModal \{[^}]*max-width: 640px[^}]*border: 1px solid var\(--command-line\)[^}]*border-radius: var\(--panel-radius\)[^}]*background: var\(--command-panel\)[^}]*box-shadow: var\(--command-overlay-shadow\)/);
    expect(tasksStyles).toMatch(/\.taskModalHeader \{[^}]*padding: var\(--space-2\) var\(--space-3\) var\(--space-2\) var\(--space-6\)[^}]*border-bottom: 1px solid var\(--command-line\)/);
    expect(tasksStyles).toMatch(/\.taskModalBody \{[^}]*gap: var\(--space-4\)[^}]*padding: var\(--space-6\)/);
    expect(tasksStyles).toMatch(/\.taskModalFooter \{[^}]*padding: var\(--space-3\) var\(--space-6\)[^}]*border-top: 1px solid var\(--command-line\)/);
    expect(tasksStyles).not.toMatch(/\.taskModal[A-Za-z]*[^{]*\{[^}]*(?:transition|animation|#[0-9a-fA-F]{3,8}|rgba?\()/);
    // G153-G158: footer actions keep their roles and are 36px with a fine pointer at 761px and wider, 44px otherwise.
    expect(tasksStyles).toMatch(/\.taskModalFooter :is\(\.commandPrimaryAction, \.commandSecondaryAction, \.commandQuietAction\) \{ min-height: 44px; width: auto/);
    expect(tasksStyles).toMatch(/@media \(min-width: 761px\) and \(pointer: fine\) \{\s*\.taskModalFooter :is\(\.commandPrimaryAction, \.commandSecondaryAction, \.commandQuietAction\) \{ min-height: var\(--control-height\); \}/);
    // G138-G152: Run on and Effort sit in a two-column row, the checks wrap, and the own condition is a 36px input.
    expect(tasksStyles).toMatch(/\.taskRunRow \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    expect(tasksStyles).toMatch(/\.taskChecks \{[^}]*flex-wrap: wrap[^}]*gap: var\(--space-1\) var\(--space-4\)/);
    expect(tasksStyles).toMatch(/\.taskDoneWhen \.taskOwnInput \{ min-height: var\(--control-height\)/);
    expect(tasksStyles).toMatch(/\.taskTextCounter \{[^}]*align-self: flex-end[^}]*font: 400 var\(--text-xs\)\/1\.4 var\(--font-data\)/);
    // D2: a native modal dialog with its name, no scrim-click close, and Escape unless a control inside handled the key.
    expect(frame).toMatch(/<dialog[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby=\{titleId\}/);
    expect(frame).toMatch(/showModal\(\)/);
    expect(frame).toMatch(/event\.key !== "Escape" \|\| event\.defaultPrevented/);
    expect(frame).toMatch(/className="commandIconAction" aria-label="Close"/);
    expect(frame).not.toMatch(/onClick=\{\(event\) => \{ if \(event\.target === dialog/);
    // D3: the copy of the fields, and Feature and Run on stay CommandSelect.
    expect(fields).toMatch(/placeholder="What should the session do\?"/);
    expect(fields).toMatch(/aria-label="Own condition"[^>]*placeholder="Own condition, judged by the agent \(optional\)"/);
    expect(fields).not.toMatch(/Use your own condition/);
    expect(featureFields).toMatch(/<label htmlFor=\{stepId\}>Step<\/label>/);
    expect(fields + featureFields).not.toMatch(/<select/);
    // DESIGN.md and the design-system sample document the frame and the fields.
    expect(designContract).toMatch(/\*\*Task modal frame\.\*\* `TaskModalFrame`[^]*native modal `<dialog>`[^]*`--color-text` mixed to 40%/);
    expect(designContract).toMatch(/a click on the scrim does nothing/);
    expect(designContract).toMatch(/\*\*Task fields\.\*\*[^]*“PR open”, “Tree clean”, “Commit on branch”, “PR merged”, and “CI passed”/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemTaskFieldsSample.tsx"), "utf8");
    expect(sample).toMatch(/Task modal, new/);
    expect(sample).toMatch(/TaskModalChrome/);
    expect(sample).not.toMatch(/<TaskModalFrame/);
    expect(designSystemStyles).toMatch(/\.designSystemTaskModalStage \{[^}]*background: color-mix\(in srgb, var\(--color-text\) 40%, transparent\)/);
  });

  it("builds the New task and Task modals as two modes of one component with a primary Create and Save, and no drawers", () => {
    const tasksStyles = readFileSync(join(process.cwd(), "app", "styles", "tasks.css"), "utf8");
    const dir = join(process.cwd(), "app", "components", "tasks");
    const modalNew = readFileSync(join(dir, "TaskModalNew.tsx"), "utf8");
    const modalEdit = readFileSync(join(dir, "TaskModalEdit.tsx"), "utf8");
    const modal = readFileSync(join(dir, "TaskModal.tsx"), "utf8");
    // D1: one modal with a mode switch over one form per mode, both inside the shared frame; the two panels are gone.
    expect(modal).toMatch(/mode: "new"[^]*mode: "edit"/);
    expect(modalNew + modalEdit).toMatch(/<TaskModalFrame/);
    expect(existsSync(join(dir, "NewTaskPanel.tsx"))).toBe(false);
    expect(existsSync(join(dir, "TaskPanel.tsx"))).toBe(false);
    expect(tasksStyles).not.toMatch(/\.(?:newTaskPanel|taskPanel)[A-Za-z]*/);
    // D4: mode new ends with a Quiet Cancel and the one primary Create task; no "create and add another".
    expect(modalNew).toMatch(/className="commandQuietAction" onClick=\{onClose\}>Cancel<\/button>[^]*className="commandPrimaryAction"[^\n]*>Create task<\/button>/);
    expect(modalNew).not.toMatch(/add another|Goes to Backlog/);
    // D5: mode edit has Save as its one primary; the resolutions, queue and start actions are Secondary.
    expect(modalEdit.match(/commandPrimaryAction/g)).toHaveLength(1);
    expect(modalEdit).toMatch(/className="commandPrimaryAction"[^\n]*>Save<\/button>/);
    expect(modalEdit).toMatch(/className="commandQuietAction"[^\n]*>Delete task<\/button>/);
    expect(modalEdit).toMatch(/className="commandSecondaryAction"[^\n]*>Mark done and resume queue<\/button>/);
    expect(modalEdit).toMatch(/className="taskModalResolve"/);
    expect(tasksStyles).toMatch(/\.taskModalResolve \{[^}]*flex: 1 0 100%/);
    // DESIGN.md and the design-system sample document both modes.
    expect(designContract).toMatch(/\*\*New task modal\.\*\*[^]*\*\*Cancel\*\*[^]*\*\*Create task\*\*/);
    expect(designContract).toMatch(/\*\*Task modal, mode edit\.\*\*[^]*nothing is sent until \*\*Save\*\*[^]*Save your changes first\./);
    expect(designContract).not.toMatch(/\*\*(?:New task|Task) panel\.\*\*/);
    const sample = readFileSync(join(process.cwd(), "app", "components", "design-system", "DesignSystemTaskFieldsSample.tsx"), "utf8");
    expect(sample).toMatch(/Task modal, edit"/);
    expect(sample).toMatch(/Task modal, edit, needs review/);
  });

  it("documents the promoted roster, inspector, command table, and settings rail samples with tokens only", () => {
    expect(designContract).toMatch(/shipped `AgentActivityPanel` from static agents/);
    expect(designContract).toMatch(/standalone inline `AgentInspector`/);
    expect(designContract).toMatch(/`CommandTable` adds opt-in states: a sortable header/);
    expect(designContract).toMatch(/`\.commandSettingsNav`, `role="tab"`, rendered with its pane at `\/design-system`/);
    expect(designContract).toMatch(/the agent roster and inspector, the command table, the settings tab rail/);

    // The static reference adds layout only: tokens for color, radius, and size, never literals.
    expect(designSystemStyles).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    expect(designSystemStyles).not.toMatch(/font(?:-size)?:[^;}]*\b\d+px/);
    expect(designSystemStyles).toMatch(/\.designSystemInspectorFrame\s*\{[^}]*border-radius:\s*var\(--panel-radius\)/);
    expect(styles).toMatch(/\.commandTableSort\s*\{[^}]*min-height:\s*40px/);
    expect(styles).toMatch(/\.commandTable th\[aria-sort\]\s*\{\s*color:\s*var\(--command-ink\)/);
    expect(styles).toMatch(/\.commandSettingsNav button:hover, \.commandSettingsNav button\.active\s*\{\s*background:\s*var\(--command-panel-2\)/);
    expect(styles).toMatch(/\.rosterRow\.rosterSelected\s*\{[^}]*box-shadow:\s*inset 2px 0 0 var\(--command-brand-text\)/);
  });
});
