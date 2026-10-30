import type { StorageSnapshot } from "../../../shared/storage-contract";
import { StorageUsageBar } from "../../settings/StorageSettings";
import { CommandBreadcrumbSeparator, CommandPageHeader } from "../command-center/CommandPage";
import { Sample, Section } from "./DesignSystemKit";

export function ShellSection() {
  return <Section id="shell" title="Page header, tabs, and sidebar limits" lede="Every route starts with CommandPageHeader: an optional breadcrumb trail, title, optional meta line, and a right-aligned actions slot. Its tab slot supplies the shared one-rule tab bar. Sidebar limits are shell chrome from the account usage store, never session evidence.">
    <div className="designSystemShellSample">
      <CommandPageHeader breadcrumb={<><a href="#shell">Repositories</a><CommandBreadcrumbSeparator /><span aria-current="page">pomegr</span></>} title="Repository activity" meta="Observed sessions and recorded setup." actions={<button type="button" className="commandSecondaryAction">View sessions</button>} tabs={<><button type="button" role="tab" aria-selected="true">Overview</button><button type="button" role="tab" aria-selected="false">Files</button><button type="button" role="tab" aria-selected="false">Context</button></>} />
    </div>
    <div className="designSystemSidebarLimits" aria-label="Sidebar limits sample"><header><span>Usage limits</span><a href="/usage-limits">View</a></header><a href="/usage-limits" className="commandSidebarLimit normal"><span>Claude Code</span><strong>42% · 3h left</strong><i aria-hidden="true"><b style={{ width: "42%" }} /></i></a><a href="/usage-limits" className="commandSidebarLimit warning"><span>Codex</span><strong>78% · 2d left</strong><i aria-hidden="true"><b style={{ width: "78%" }} /></i></a></div>
  </Section>;
}

const STORAGE_SAMPLE_BASE: StorageSnapshot = {
  revision: 1, readiness: "ready", databaseBytes: 380 * 1024 * 1024, thresholdBytes: 500 * 1024 * 1024, percent: 76,
  oldestRetainedDay: "2026-06-14", lastPrunedAt: null, retentionDays: 90, cleanupStatus: "normal",
};
const STORAGE_SAMPLE_ORDINARY: StorageSnapshot = STORAGE_SAMPLE_BASE;
const STORAGE_SAMPLE_OVER: StorageSnapshot = { ...STORAGE_SAMPLE_BASE, databaseBytes: 550 * 1024 * 1024, percent: 110, cleanupStatus: "cleanup_pending" };
const STORAGE_SAMPLE_UNAVAILABLE: StorageSnapshot = { ...STORAGE_SAMPLE_BASE, readiness: "unavailable", databaseBytes: null, percent: null, cleanupStatus: null };

export function StorageUsageSection() {
  return <Section id="storage-usage" title="Storage usage" lede="StorageUsageBar (.storageUsageBar): an informational role=meter with a clamped 0-100% fill, real percentage text even over 100%, and an honest unavailable state that never reads 0%.">
    <div className="designSystemGrid">
      <Sample label="Ordinary"><StorageUsageBar snapshot={STORAGE_SAMPLE_ORDINARY} /></Sample>
      <Sample label="Over threshold"><StorageUsageBar snapshot={STORAGE_SAMPLE_OVER} /></Sample>
      <Sample label="Unavailable"><StorageUsageBar snapshot={STORAGE_SAMPLE_UNAVAILABLE} /></Sample>
    </div>
  </Section>;
}

const TYPE_SCALE = [
  { name: "Title", tokens: "--text-title · 28px · 600 · --font-ui", style: { font: "600 var(--text-title)/1.25 var(--font-ui)", letterSpacing: "-.025em" } },
  { name: "Section heading", tokens: "--text-heading · 18px · 600 · --font-ui", style: { font: "600 var(--text-heading)/1.35 var(--font-ui)" } },
  { name: "Body", tokens: "--text-base · 16px · 400 · --font-ui", style: { font: "400 var(--text-base)/1.5 var(--font-ui)" } },
  { name: "Control", tokens: "--text-sm · 15px · 500 · --font-ui", style: { font: "500 var(--text-sm)/1.4 var(--font-ui)" } },
  { name: "Metadata", tokens: "--text-xs · 14px · 400 · --font-ui · --command-muted", style: { font: "400 var(--text-xs)/1.4 var(--font-ui)", color: "var(--command-muted)" } },
  { name: "Caption", tokens: "--text-caption · 12px · 500 · --font-ui · --command-faint · uppercase", style: { font: "500 var(--text-caption)/1.4 var(--font-ui)", color: "var(--command-faint)", letterSpacing: ".06em", textTransform: "uppercase" } },
  { name: "Data", tokens: "--text-xs · 14px · 400 · --font-data · tabular-nums", style: { font: "400 var(--text-xs)/1.4 var(--font-data)", fontVariantNumeric: "tabular-nums" } },
] as const;

const COLOR_TOKENS = [
  "--color-canvas", "--color-panel", "--color-raised", "--color-text", "--color-muted", "--color-line", "--color-control",
  "--color-brand-fill", "--color-brand-text", "--color-brand-soft", "--color-green", "--color-green-soft", "--color-amber", "--color-amber-soft",
  "--color-context", "--color-error", "--color-error-soft", "--focus-ring",
];

const ALIAS_TOKENS = [
  "--command-ground", "--command-panel", "--command-panel-2", "--command-panel-3", "--command-line", "--command-line-strong",
  "--command-ink", "--command-muted", "--command-faint", "--command-brand", "--command-brand-text", "--command-green", "--command-amber", "--command-lavender",
  "--ink", "--muted", "--paper", "--panel", "--panel-2", "--line", "--line-strong", "--brand", "--green", "--amber", "--blue", "--red",
];

const SPACING_TOKENS = ["--space-1", "--space-2", "--space-3", "--space-4", "--space-6", "--space-8"];
const SHAPE_TOKENS = ["--control-radius", "--panel-radius", "--control-height", "--control-compact", "--command-brand-mark-size", "--divider-content-gap", "--shadow-overlay"];

export function TypographySection() {
  return <Section id="typography" title="Typography and tokens" lede="Segoe UI with bundled Inter fallback carries the interface (--font-ui); bundled Cascadia Mono carries data (--font-data). Reading text starts at 14px. Fonts load from same-origin assets. Dark primary ink is #cbcfd5 and muted ink is #8f96a0 to reduce glare.">
    <div className="designSystemType">
      {TYPE_SCALE.map((entry) => <div key={entry.name}>
        <span style={entry.style}>{entry.name} · Follow actual context levels</span>
        <code>{entry.tokens}</code>
      </div>)}
    </div>
    <h3 className="designSystemLede">Palette tokens</h3>
    <ul className="designSystemSwatches">
      {COLOR_TOKENS.map((token) => <li key={token} className="designSystemSwatch"><i style={{ background: `var(${token})` }} aria-hidden="true" /><code>{token}</code></li>)}
    </ul>
    <h3 className="designSystemLede">Component aliases</h3>
    <ul className="designSystemTokenList">{ALIAS_TOKENS.map((token) => <li key={token}><code>{token}</code></li>)}</ul>
    <h3 className="designSystemLede">Spacing</h3>
    <ul className="designSystemSpacing">
      {SPACING_TOKENS.map((token) => <li key={token}><code>{token}</code><i style={{ width: `var(${token})` }} aria-hidden="true" /></li>)}
    </ul>
    <h3 className="designSystemLede">Shape and elevation</h3>
    <ul className="designSystemTokenList">{SHAPE_TOKENS.map((token) => <li key={token}><code>{token}</code></li>)}</ul>
  </Section>;
}
