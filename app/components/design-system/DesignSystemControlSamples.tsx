"use client";

import { useState, type ReactNode } from "react";
import { AgentChip } from "../AgentChip";
import { PanelHeadingLink } from "../PanelHeadingLink";
import { PanelHeader } from "../PanelHeader";
import { ProviderBadge } from "../ProviderBadge";
import { CommandEmpty, CommandFilter, CommandSearch, CommandSelect, CommandStatus, CommandToolbar } from "../command-center/CommandPage";
import { CommandSplitAction } from "../command-center/CommandSplitAction";
import { Sample, Section } from "./DesignSystemKit";

function DownloadIcon({ size = 14 }: { size?: number }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" />
  </svg>;
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5a1 1 0 0 1 1-1h10" />
  </svg>;
}

type SampleState = { active?: boolean; disabled?: boolean };

type ButtonRole = {
  id: string;
  name: string;
  selector: string;
  contract: string;
  hover: string;
  activeLabel: string | null;
  render: (state: SampleState) => ReactNode;
};

const BUTTON_ROLES: ButtonRole[] = [
  {
    id: "primary",
    name: "Primary",
    selector: ".commandPrimaryAction",
    contract: "36px (--control-height), brand fill --command-brand with a matching 1px border, white text, 13px/500, padding 0 12px. One per view, for real commitments only: install, reconnect, confirm.",
    hover: "Hover: no tone shift; the fill already carries the commitment.",
    activeLabel: null,
    render: ({ disabled }) => <button type="button" className="commandPrimaryAction" disabled={disabled}>Install plugin</button>,
  },
  {
    id: "secondary",
    name: "Secondary",
    selector: ".commandSecondaryAction",
    contract: "32px (--control-compact), 1px border --command-line, transparent background, ink text 12px/500, padding 0 10px. Used for Prev/Next, Copy, toolbar actions, and independent toggles.",
    hover: "Hover, [aria-pressed=\"true\"], and [aria-expanded=\"true\"] all move to --command-panel-2 with the stronger --command-line-strong border.",
    activeLabel: "Pressed / selected",
    render: ({ active, disabled }) => <>
      <button type="button" className="commandSecondaryAction" aria-pressed={active ? "true" : undefined} disabled={disabled}>Copy</button>
      <button type="button" className="commandSecondaryAction" aria-pressed={active ? "true" : undefined} disabled={disabled}>Hide finished</button>
    </>,
  },
  {
    id: "segmented",
    name: "Segmented",
    selector: ".commandSegmented > button",
    contract: "One frame with a 1px --command-line border, 4px radius, and clipped corners. Segments are 30px, borderless, muted 12px/500, padding 0 10px, divided by 1px rules; the [aria-pressed=\"true\"] segment takes --command-panel-2 and ink. Focus ring is inset (offset -2px) so the frame never clips it.",
    hover: "Hovering a segment lifts its text to ink without changing the fill. Mutually exclusive views only: Fresh tokens / Full breakdown, List / Grid, Ancestors / Whole session.",
    activeLabel: "Second segment selected",
    render: ({ active, disabled }) => <div className="commandSegmented" role="group" aria-label="Request breakdown">
      <button type="button" aria-pressed={active ? "false" : "true"} disabled={disabled}>Fresh tokens</button>
      <button type="button" aria-pressed={active ? "true" : "false"} disabled={disabled}>Full breakdown</button>
    </div>,
  },
  {
    id: "quiet",
    name: "Quiet",
    selector: ".commandQuietAction",
    contract: "No border, no fill, muted 12px/500, min-height 28px, padding 0 6px, gap 6px, optional 14px direct-child icon. Used for optional actions such as Download report and sort cycling. Panel headings compose it as .panelHeadingLink.",
    hover: "Hover and [aria-expanded=\"true\"] tint the background with 6% ink (color-mix) and lift the text to ink; :active uses 10%.",
    activeLabel: "Expanded",
    render: ({ active, disabled }) => <>
      <button type="button" className="commandQuietAction" aria-expanded={active ? "true" : undefined} disabled={disabled}><DownloadIcon />Download report</button>
      <button type="button" className="commandQuietAction" aria-expanded={active ? "true" : undefined} disabled={disabled}>by uncached input</button>
      <PanelHeadingLink id="design-system-panel-heading" onOpen={() => undefined}>Efficiency signals</PanelHeadingLink>
    </>,
  },
  {
    id: "text-link",
    name: "Text link",
    selector: ".commandTextLink",
    contract: "Inline with content, padding 0, no border or fill, --command-brand-text, 12px/400. Used for Show 20, Show more, Expand all, and other section expanders; never a standalone action.",
    hover: "Hover underlines with a 3px offset.",
    activeLabel: null,
    render: ({ disabled }) => <>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--command-muted)" }}>Showing 5 of 40 ·</span>
      <button type="button" className="commandTextLink" disabled={disabled}>Show 20</button>
      <button type="button" className="commandTextLink" disabled={disabled}>Expand all</button>
    </>,
  },
  {
    id: "icon",
    name: "Icon",
    selector: ".commandIconAction",
    contract: "32px square quiet button, padding 0, no border or fill, muted color, 16px direct-child stroke icon. Requires a title or aria-label.",
    hover: "Same 6% ink tint as quiet on hover and [aria-expanded=\"true\"]; :active uses 10%.",
    activeLabel: "Expanded",
    render: ({ active, disabled }) => <>
      <button type="button" className="commandIconAction" title="Copy transcript path" aria-label="Copy transcript path" aria-expanded={active ? "true" : undefined} disabled={disabled}><CopyIcon /></button>
      <button type="button" className="commandIconAction" title="Download report" aria-label="Download report" aria-expanded={active ? "true" : undefined} disabled={disabled}><DownloadIcon size={16} /></button>
    </>,
  },
];

const SAMPLE_SPLIT_ITEMS = [
  { value: "queue", label: "Create and queue", detail: "Goes to the end of Ready." },
  { value: "start", label: "Create and start session", detail: "Opens the session's terminal in Pomegr." },
];

export function ButtonsSection() {
  return <Section id="buttons" title="Buttons" lede="Six roles share one 4px radius (--control-radius), one focus ring (2px --focus-ring, offset 2px; inset inside segmented frames), and one disabled treatment (opacity .48). Borders use --command-line; --command-line-strong appears only on hover and on form fields.">
    {BUTTON_ROLES.map((role) => <article key={role.id} className="designSystemRole" aria-labelledby={`design-system-role-${role.id}`}>
      <h3 id={`design-system-role-${role.id}`}>{role.name}<code>{role.selector}</code></h3>
      <p>{role.contract}</p>
      <div className="designSystemStates">
        <Sample label="Default" note={`${role.hover} Tab to a sample: :focus-visible draws the shared 2px --focus-ring outline.`}>{role.render({})}</Sample>
        {role.activeLabel && <Sample label={role.activeLabel} note="Rendered with the real aria attribute; the class styles the attribute, not a modifier class.">{role.render({ active: true })}</Sample>}
        <Sample label="Disabled" note="Native disabled attribute; opacity .48 and default cursor.">{role.render({ disabled: true })}</Sample>
      </div>
    </article>)}
    <article className="designSystemRole" aria-labelledby="design-system-role-split">
      <h3 id="design-system-role-split">Split action<code>.commandSplitAction</code></h3>
      <p>A Primary and a caret in one frame, one pixel apart. The Primary runs the usual form of the action; the caret opens a menu of its other forms above the button. A composition of the Primary role, not a seventh role, and still the one primary of its view.</p>
      <div className="designSystemStates">
        <Sample label="Default" note="Press the caret: the menu opens above, with a label and one muted line for each item. Arrow keys move, Escape closes and returns to the caret.">
          <CommandSplitAction label="Create task" menuLabel="More ways to create" items={SAMPLE_SPLIT_ITEMS} onAction={() => undefined} onSelect={() => undefined} />
        </Sample>
        <Sample label="Disabled" note="Both halves take the native disabled attribute, and the menu cannot open.">
          <CommandSplitAction label="Create task" menuLabel="More ways to create, disabled" items={SAMPLE_SPLIT_ITEMS} disabled onAction={() => undefined} onSelect={() => undefined} />
        </Sample>
      </div>
    </article>
    <p className="designSystemNote">Phone widths (max-width 760px) and coarse pointers keep the roles and change only size: every target reaches 44px, primary and segmented stretch to the full row (segments flex evenly), secondary pairs split the row through their local grid, quiet actions become full-width left-aligned rows, icon buttons become 44px squares, and text links keep a 44px tap box. Resize this window below 760px to see the samples above adopt those sizes.</p>
  </Section>;
}

const SAMPLE_SCOPES = [{ value: "session", label: "Whole session" }, { value: "ancestors", label: "Ancestors only" }, { value: "agent", label: "Selected agent" }];
const SAMPLE_SCOPE_AGENTS = [
  { value: "all", label: "All agents" },
  { value: "primary", label: "Primary agent", icon: <i className="commandStatusDot online" />, iconLabel: "running" },
  { value: "review", label: "Contract review" },
  { value: "trace", label: "Trace and fix", icon: <i className="commandStatusDot online" />, iconLabel: "running" },
];

export function FormFieldsSection() {
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState("session");
  const [agent, setAgent] = useState("all");
  return <Section id="form-fields" title="Form fields" lede="Single-select dropdowns use CommandSelect: a 36px trigger with a 1px --command-line border that strengthens on hover or while open, --command-ground fill, a muted chevron inset 14px, and the shared focus ring. Its listbox is a --command-panel overlay; the active option takes the raised tone and the selected option the brand text. Options may carry a glyph, such as the running dot. Search uses CommandSearch.">
    <div className="designSystemStates">
      <Sample label="Select">
        <CommandSelect aria-label="Sample scope" value={scope} onChange={setScope} options={SAMPLE_SCOPES} />
      </Sample>
      <Sample label="Select · option glyphs" note="The Activities agent scope marks agents still running with a green status dot; the option's accessible name gains “running”.">
        <CommandSelect aria-label="Sample agent scope" value={agent} onChange={setAgent} options={SAMPLE_SCOPE_AGENTS} />
      </Sample>
      <Sample label="Select · disabled" note="Disabled selects keep the border, drop to opacity .55, and dim the chevron with :has().">
        <CommandSelect aria-label="Sample scope, disabled" value="session" onChange={() => undefined} options={SAMPLE_SCOPES.slice(0, 1)} disabled />
      </Sample>
      <Sample label="Search" note="36px, 1px --command-line-strong border, --command-ground fill, brand caret; the icon and label live inside the field.">
        <CommandSearch value={search} onChange={setSearch} placeholder="Filter sample rows" label="Filter sample rows" />
      </Sample>
    </div>
  </Section>;
}

export function ChipsSection() {
  return <Section id="chips" title="Chips and pills" lede="One chip contract covers every evidence chip: .commandChip (Command Center session badges) and .agentChip (the AgentChip component) share identical geometry — 20px min-height, a 1px --command-line/--line border, transparent fill, 11px/500 sentence-case text, and an optional 6px leading dot. Tone modifiers (info, positive, warning, negative) recolor only the text and dot; the border stays neutral.">
    <div className="designSystemStates">
      <Sample label="Neutral" note="Base .agentChip, rendered through the AgentChip component. With a title it becomes a tooltip trigger; as a button it opens a disclosure.">
        <AgentChip>Explore</AgentChip>
        <AgentChip title="Reported by the agent through the Pomegr MCP tool" ariaLabel="Sample reported signal">Reported signal</AgentChip>
        <AgentChip as="button" ariaLabel="Open sample disclosure" expanded={false}>2 compactions</AgentChip>
      </Sample>
      <Sample label="With a dot" note="An optional leading 6px dot (a direct-child <i>) picks up the tone color; the chip border stays neutral and the fill stays transparent. Command Center session badges (.commandChip, e.g. workflow status) render this form directly.">
        <span className="commandChip"><i aria-hidden="true" />Neutral</span>
        <span className="commandChip positive"><i aria-hidden="true" />Running</span>
        <span className="commandChip warning"><i aria-hidden="true" />Blocked</span>
      </Sample>
      <Sample label="Signal tones" note="Agent-reported signals use .sessionSignal / .agentSignal / .executionTaskSignal on top of .agentChip, with a bounded tone: neutral, info, positive, warning, negative. Tones recolor text only.">
        <AgentChip className="sessionSignal">neutral</AgentChip>
        <AgentChip className="sessionSignal info">info</AgentChip>
        <AgentChip className="sessionSignal positive">positive</AgentChip>
        <AgentChip className="sessionSignal warning">warning</AgentChip>
        <AgentChip className="sessionSignal negative">negative</AgentChip>
      </Sample>
      <Sample label="Truncation" note=".agentChipLabel ellipsizes chip text; .sessionSignal additionally caps width at 190px so a long agent-reported signal truncates instead of wrapping. A title makes the full text available as a tooltip.">
        <span style={{ display: "inline-block", maxWidth: 160 }}>
          <AgentChip className="sessionSignal" title="A much longer agent-reported signal that needs to truncate at the shared max width">A much longer reported signal that truncates</AgentChip>
        </span>
      </Sample>
      <Sample label="ProviderBadge" note="Provider names are words, never logos: an outline chip by default, plain inherited text in headings and inline metadata.">
        <ProviderBadge source="Claude Code" />
        <ProviderBadge source="Codex" />
        <ProviderBadge source="Claude Code" variant="text" />
        <ProviderBadge source="Codex" variant="text" />
      </Sample>
      <Sample label="CommandStatus" note=".commandStatusText with a .commandStatusDot: active, attention, idle, unknown.">
        <CommandStatus state="active">Working</CommandStatus>
        <CommandStatus state="attention">Needs input</CommandStatus>
        <CommandStatus state="idle">Idle</CommandStatus>
        <CommandStatus state="unknown">Status uncertain</CommandStatus>
      </Sample>
      <Sample label="Status pill" note=".statusPill: uppercase agent status text (not a chip — no border or fill), pairing a 7px dot with a tone color. Covers active, waiting, warm, finished, stopped, needs_input.">
        <span className="statusPill active">active</span>
        <span className="statusPill waiting">waiting</span>
        <span className="statusPill warm">warm</span>
        <span className="statusPill finished">finished</span>
        <span className="statusPill stopped">stopped</span>
        <span className="statusPill needs_input">needs input</span>
      </Sample>
    </div>
    <CommandToolbar label="Sample filters">
      <CommandFilter active onClick={() => {}} count={3}>Live</CommandFilter>
      <CommandFilter active={false} onClick={() => {}} count={12}>Recorded</CommandFilter>
      <CommandFilter active={false} onClick={() => {}}>Needs input</CommandFilter>
      <span className="commandToolbarCount">15 sessions</span>
    </CommandToolbar>
    <p className="designSystemNote">Filter chips (.commandFilterChip inside .commandToolbar) are 36px interactive toggles; the pressed chip takes --command-panel-3 and ink. Evidence chips (.commandChip / .agentChip) are transparent outline labels, not buttons.</p>
  </Section>;
}

export function PanelsSection() {
  return <Section id="panels" title="Panels and dividers" lede="Panels use --command-panel, a 1px --command-line rule, and the 6px --panel-radius. Rows divide with single 1px rules; never stack a rule against a border.">
    <div className="designSystemGrid">
      <section className="panel" aria-label="Sample panel">
        <PanelHeader title="Panel" trailing={<span className="quiet">Static sample</span>} />
        <div className="designSystemPanelBody">
          <div className="commandSettingRow"><div><strong>Row with a rule</strong><span>.commandSettingRow separates entries with a 1px --command-line top rule.</span></div><button type="button" className="commandSecondaryAction">Configure</button></div>
          <div className="commandSettingRow"><div><strong>Second row</strong><span>Trailing controls stay in the secondary role.</span></div><button type="button" className="commandSecondaryAction">Recheck</button></div>
        </div>
      </section>
      <div>
        <CommandEmpty icon="spark" title="Empty state" detail="CommandEmpty: centered icon, 13px title, 12px detail, 1px panel rule." />
      </div>
    </div>
    <div className="designSystemSession commandSessionView">
      <section className="sessionKpiStrip" aria-label="Sample session totals">
        <div className="sessionKpi"><span className="sessionEyebrow">Agents observed</span><strong>4</strong><small><span className="sessionPositive">1 active</span> · 2 idle · 1 finished</small></div>
        <div className="sessionKpi"><span className="sessionEyebrow">All-agent context</span><strong className="sessionContextValue">86k</strong><small>Sum of latest snapshots · not spend</small></div>
        <div className="sessionKpi"><span className="sessionEyebrow">Wall time</span><strong>1h 12m</strong><small>Includes idle gaps</small></div>
        <div className="sessionKpi"><span className="sessionEyebrow">Tool calls</span><strong>212</strong><small>3 workflows · 9 repeated</small></div>
        <div className="sessionKpi sessionKpiEstimate"><span className="sessionEyebrow">Agent estimate</span><strong className="sessionPositive">64%</strong><small>Implementing · 5–9 min left · medium confidence</small></div>
      </section>
      <p className="designSystemNote">Session KPI strip (.sessionKpiStrip &gt; .sessionKpi): 30px/500 tabular figures with 11px uppercase eyebrows, divided by 1px vertical rules; phones collapse to bordered 2-up tiles.</p>
    </div>
  </Section>;
}
