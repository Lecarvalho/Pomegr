"use client";

import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { Agent, AgentRole, Workflow } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { PanelHeadingLink } from "../PanelHeadingLink";
import { PanelHeader } from "../PanelHeader";
import { ProviderBadge } from "../ProviderBadge";
import { RepositoryRow } from "../repositories/RepositoryRow";
import { DashboardDisclosurePanel } from "../dashboard/DashboardDisclosurePanel";
import { WorkKindIcon } from "../WorkKindIcon";
import { buildRequestLanes } from "../dashboard/requests-actions/lane-model";
import { scaleMax, type RequestRow } from "../dashboard/requests-actions/model";
import { RequestBarsChart } from "../dashboard/requests-actions/RequestBarsChart";
import { RequestLaneChart } from "../dashboard/requests-actions/RequestLaneChart";
import { RequestMinimap } from "../dashboard/requests-actions/RequestMinimap";
import { RequestRoleLegend } from "../dashboard/requests-actions/RequestRoleTrack";
import {
  CommandEmpty,
  CommandFilter,
  CommandMetric,
  CommandPage,
  CommandPageHeader,
  CommandSearch,
  CommandSelect,
  CommandStatus,
  CommandToolbar,
} from "../command-center/CommandPage";
import { useClientAccess } from "../../hooks/ClientAccessContext";

// Layer 1 of the web-only gate: the desktop preload exposes `window.pomegrDesktop`
// whenever the page runs inside the Electron renderer. Presence alone is the signal.
function subscribeAvailability() { return () => {}; }
function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean((window as Window & { pomegrDesktop?: unknown }).pomegrDesktop);
}

export function DesignSystemUnavailable() {
  return <CommandPage title="Not found" description="This page is not part of the Pomegr application.">
    <CommandEmpty icon="close" title="Design system unavailable here" detail="The design-system reference renders only on the web development server. It never appears in the desktop app, in phone access, or in navigation." />
  </CommandPage>;
}

export function DesignSystemView() {
  const desktop = useSyncExternalStore(subscribeAvailability, isDesktopRuntime, () => false);
  const { mode } = useClientAccess();
  if (desktop || mode === "lan") return <DesignSystemUnavailable />;
  return <CommandPage title="Design system" description="Every control below is the real shared class or component, rendered with static sample data. Nothing on this page reads session state.">
    <ButtonsSection />
    <FormFieldsSection />
    <ShellSection />
    <RoleFamilySection />
    <RequestChartsSection />
    <ChipsSection />
    <Section id="repository-row" title="Repository setup row" lede="Shared settings geometry, standard chips, and independent row actions.">
      <RepositoryRow title="Pomegr plugin" label="Enabled" tone="positive" detail={<><code>v1.0.0</code> · Project installation · Up to date</>} actions={<button type="button" className="commandQuietAction">Recheck</button>} />
    </Section>
    <PanelsSection />
    <TypographySection />
  </CommandPage>;
}

function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  const headingId = `design-system-${id}`;
  return <section className="designSystemSection" aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2>
    {lede && <p className="designSystemLede">{lede}</p>}
    {children}
  </section>;
}

function Sample({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemSample">
    <span>{label}</span>
    <div className="designSystemSampleBody">{children}</div>
    {note && <small>{note}</small>}
  </div>;
}

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
    hover: "No tone shift; the fill already carries the commitment. Focus draws the shared ring.",
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
    hover: "Hover underlines with a 3px offset. Focus draws the shared ring.",
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

function ButtonsSection() {
  return <Section id="buttons" title="Buttons" lede="Six roles share one 4px radius (--control-radius), one focus ring (2px --focus-ring, offset 2px; inset inside segmented frames), and one disabled treatment (opacity .48). Borders use --command-line; --command-line-strong appears only on hover and on form fields.">
    {BUTTON_ROLES.map((role) => <article key={role.id} className="designSystemRole" aria-labelledby={`design-system-role-${role.id}`}>
      <h3 id={`design-system-role-${role.id}`}>{role.name}<code>{role.selector}</code></h3>
      <p>{role.contract}</p>
      <div className="designSystemStates">
        <Sample label="Default">{role.render({})}</Sample>
        <Sample label="Hover" note={role.hover}>{role.render({})}</Sample>
        {role.activeLabel && <Sample label={role.activeLabel} note="Rendered with the real aria attribute; the class styles the attribute, not a modifier class.">{role.render({ active: true })}</Sample>}
        <Sample label="Disabled" note="Native disabled attribute; opacity .48 and default cursor.">{role.render({ disabled: true })}</Sample>
        <Sample label="Focus" note="Tab to this sample: :focus-visible draws the shared 2px --focus-ring outline.">{role.render({})}</Sample>
      </div>
    </article>)}
    <p className="designSystemNote">Phone widths (max-width 760px) and coarse pointers keep the roles and change only size: every target reaches 44px, primary and segmented stretch to the full row (segments flex evenly), secondary pairs split the row through their local grid, quiet actions become full-width left-aligned rows, icon buttons become 44px squares, and text links keep a 44px tap box. Resize this window below 760px to see the samples above adopt those sizes.</p>
  </Section>;
}

function FormFieldsSection() {
  const [search, setSearch] = useState("");
  return <Section id="form-fields" title="Form fields" lede="Native single-select dropdowns use CommandSelect: appearance none, 36px, 1px --command-line border that strengthens on hover, --command-ground fill, a muted chevron inset 14px, and the shared focus ring. Search uses CommandSearch.">
    <div className="designSystemStates">
      <Sample label="Select">
        <CommandSelect aria-label="Sample scope" defaultValue="session">
          <option value="session">Whole session</option>
          <option value="ancestors">Ancestors only</option>
          <option value="agent">Selected agent</option>
        </CommandSelect>
      </Sample>
      <Sample label="Select · disabled" note="Disabled selects keep the border, drop to opacity .55, and dim the chevron with :has().">
        <CommandSelect aria-label="Sample scope, disabled" defaultValue="session" disabled>
          <option value="session">Whole session</option>
        </CommandSelect>
      </Sample>
      <Sample label="Search" note="36px, 1px --command-line-strong border, --command-ground fill, brand caret; the icon and label live inside the field.">
        <CommandSearch value={search} onChange={setSearch} placeholder="Filter sample rows" label="Filter sample rows" />
      </Sample>
    </div>
  </Section>;
}

function ChipsSection() {
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
      <Sample label="ProviderBadge" note="Provider marks stay adapter-specific content; the badge is text plus a 13px mark (10px compact).">
        <ProviderBadge source="Claude Code" />
        <ProviderBadge source="Codex" />
        <ProviderBadge source="Claude Code" compact />
        <ProviderBadge source="Codex" compact />
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
      <Sample label="Badge" note=".commandBadge: 1px --command-line, faint text, no fill. Labels a state, never an action.">
        <span className="commandBadge">Coming soon</span>
        <span className="commandBadge">Estimate</span>
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

function ShellSection() {
  return <Section id="shell" title="Page header, tabs, and sidebar limits" lede="Every route starts with CommandPageHeader: an optional breadcrumb eyebrow, title, optional meta line, and a right-aligned actions slot. Its tab slot supplies the shared one-rule tab bar. Sidebar limits are shell chrome from the account usage store, never session evidence.">
    <div className="designSystemShellSample">
      <CommandPageHeader breadcrumb={<><span>Repositories</span> <span aria-hidden="true">/</span> <span>pomegr</span></>} title="Repository activity" meta="Observed sessions and recorded setup." actions={<button type="button" className="commandSecondaryAction">View sessions</button>} tabs={<><button type="button" role="tab" aria-selected="true">Overview</button><button type="button" role="tab" aria-selected="false">Files</button><button type="button" role="tab" aria-selected="false">Context</button></>} />
    </div>
    <div className="designSystemSidebarLimits" aria-label="Sidebar limits sample"><header><span>Usage limits</span><a href="/usage-limits">View</a></header><a href="/usage-limits" className="commandSidebarLimit normal"><span>Claude Code</span><strong>42% · 5-hour</strong><i aria-hidden="true"><b style={{ width: "42%" }} /></i></a><a href="/usage-limits" className="commandSidebarLimit warning"><span>Codex</span><strong>78% · Weekly</strong><i aria-hidden="true"><b style={{ width: "78%" }} /></i></a></div>
  </Section>;
}

function RoleFamilySection() {
  return <Section id="role-families" title="Agent track role families" lede="Role tints appear only in request tracks and their legends. Orchestrator remains neutral; same-role agents share one tint.">
    <div className="sessionRoleLegend" aria-label="Agent role family legend">
      <span><i className="roleFamily-neutral" aria-hidden="true" />Orchestrator ×1</span>
      <span><i className="roleFamily-reading" aria-hidden="true" />Explore ×2</span>
      <span><i className="roleFamily-planning" aria-hidden="true" />Plan ×1</span>
      <span><i className="roleFamily-writing" aria-hidden="true" />Builder ×3</span>
      <span><i className="roleFamily-reviewing" aria-hidden="true" />Reviewer ×1</span>
      <span><i className="roleFamily-generic" aria-hidden="true" />Fork ×2</span>
      <span><i className="roleFamily-system" aria-hidden="true" />Compaction ×1</span>
    </div>
  </Section>;
}

// Static request-chart sample: nine roster agents plus a compaction agent, so the lane chart
// crosses the eight-lane threshold and shows one expanded and one collapsed group.
const SAMPLE_TIME = Date.parse("2026-08-09T12:00:00.000Z");
const SAMPLE_WINDOW = 32;
const SAMPLE_WORKFLOW_ID = "sample-test-sweep";

function sampleAgent(id: string, label: string, role: AgentRole, workflowId: string | null = null): Agent {
  const seen = new Date(SAMPLE_TIME).toISOString();
  return {
    id, parentId: id === "primary" ? null : "primary", workflowId, workflowPhaseId: null, workflowOrder: null, workflowState: workflowId ? "done" : null,
    label, role, model: id === "primary" ? "large-model" : "small-model", effort: "medium", status: "finished", signal: null, toolCalls: 0, skills: [],
    lastSeen: seen, startedAt: seen, updatedAt: seen, durationMs: 0, cacheLifetime: "1h", tokens: { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  };
}

const SAMPLE_AGENTS: Agent[] = [
  sampleAgent("primary", "Primary agent", "orchestrator"),
  sampleAgent("explore", "Map the request feed", "explore"),
  sampleAgent("plan", "Plan lane collapse", "plan"),
  sampleAgent("review", "Review the chart diff", "reviewer"),
  sampleAgent("worker-1", "Lane model tests", "builder", SAMPLE_WORKFLOW_ID),
  sampleAgent("worker-2", "Label geometry tests", "builder", SAMPLE_WORKFLOW_ID),
  sampleAgent("worker-3", "Collapse tests", "tester", SAMPLE_WORKFLOW_ID),
  sampleAgent("worker-4", "Focus tests", "tester", SAMPLE_WORKFLOW_ID),
  sampleAgent("worker-5", "Minimap tests", "general-purpose", SAMPLE_WORKFLOW_ID),
  sampleAgent("compaction", "Compaction", "compaction"),
];

const SAMPLE_WORKFLOWS: Workflow[] = [{
  id: SAMPLE_WORKFLOW_ID, name: "Test sweep", summary: null, status: "completed", metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 0,
  agentIds: ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"], phases: [],
}];

// One key per request in order: p primary, e explore, l plan, r review, c compaction, 1-5 workers.
const SAMPLE_KEYS: Record<string, string> = { p: "primary", e: "explore", l: "plan", r: "review", c: "compaction", 1: "worker-1", 2: "worker-2", 3: "worker-3", 4: "worker-4", 5: "worker-5" };
const SAMPLE_ROWS: RequestRow[] = "p p e e p l p 1 2 3 1 4 5 2 p c p r r p p e p 3 4 p l p 5 1 p p c p r p e p 2 p".split(" ").map((key, index) => {
  const agentId = SAMPLE_KEYS[key];
  const weight = agentId === "primary" ? 6 : agentId === "compaction" ? 4 : 2;
  const uncachedInputTokens = weight * (500 + index * 37 % 11 * 160);
  const cacheWriteTokens = weight * (index % 5 === 0 ? 900 : 120);
  const cacheReadTokens = weight * 3_000;
  const outputTokens = weight * (180 + index % 7 * 70);
  return {
    id: `sample-request-${index + 1}`, agentId, observedAt: new Date(SAMPLE_TIME + index * 45_000).toISOString(), cacheLifetime: "1h",
    uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens, totalTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    precedingWork: [], precedingAssociation: null, issuedWork: [], issuedAssociation: null,
    ordinal: index + 1, number: index + 1, promptTokens: uncachedInputTokens + cacheWriteTokens + cacheReadTokens, freshTokens: uncachedInputTokens + cacheWriteTokens + outputTokens,
    // The primary rows after each compaction-agent request, and one recorded refill.
    compactionBefore: index === 16 || index === 33,
    ...(index === 37 ? { cacheEvidence: { kind: "refill" as const } } : {}),
  };
});
const SAMPLE_LANES = buildRequestLanes(SAMPLE_ROWS, SAMPLE_AGENTS, "fresh", true).lanes;
const SAMPLE_MAXIMUM = Math.max(1, scaleMax(SAMPLE_ROWS, "fresh", true));
const SAMPLE_PANEL_STYLE = { marginTop: "var(--space-4)" };
function ignoreFocus() {}

function RequestChartsSection() {
  const [windowStart, setWindowStart] = useState(SAMPLE_ROWS.length - SAMPLE_WINDOW + 1);
  const [selectedIndex, setSelectedIndex] = useState(33);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(["direct"]));
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const end = windowStart + SAMPLE_WINDOW - 1;
  const selected = SAMPLE_ROWS[selectedIndex];
  const selectIndex = (index: number) => {
    const next = Math.max(0, Math.min(SAMPLE_ROWS.length - 1, index));
    setSelectedIndex(next);
    if (next + 1 < windowStart) setWindowStart(next + 1);
    else if (next + 1 > end) setWindowStart(next + 2 - SAMPLE_WINDOW);
  };
  const moveWindow = (start: number) => {
    setWindowStart(start);
    setSelectedIndex((current) => Math.max(start - 1, Math.min(start + SAMPLE_WINDOW - 2, current)));
  };
  const toggleGroup = (groupId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(groupId)) next.add(groupId);
    return next;
  });
  const chart = { rows: SAMPLE_ROWS, start: windowStart, end, size: SAMPLE_WINDOW, mode: "fresh" as const, selectedId: selected.id, cacheWriteAvailable: true,
    onSelect: (row: RequestRow) => selectIndex(row.ordinal - 1), onStep: (delta: number) => selectIndex(selectedIndex + delta), windowStart, total: SAMPLE_ROWS.length };
  return <Section id="request-charts" title="Request charts" lede="Activities draws one lane per agent on desktop; Single chart stacks every request on one scale above the role-family agent track. Both share request order, window, selection, arrow keys, and the neutral minimap. Static data only.">
    <section className="panel requestsActionsPanel" aria-label="Lane chart sample" style={SAMPLE_PANEL_STYLE}>
      <div className="requestsActionsPlot">
        <p className="requestsActionsScale"><strong>Per-lane scales</strong><span>Rescaled · cache reads excluded</span></p>
        <RequestLaneChart lanes={SAMPLE_LANES} agents={SAMPLE_AGENTS} workflows={SAMPLE_WORKFLOWS} expanded={expanded} onToggleGroup={toggleGroup} focusedAgentId={null} onFocusAgent={ignoreFocus} {...chart} />
        <RequestMinimap rows={SAMPLE_ROWS} start={windowStart} end={end} mode="fresh" cacheWriteAvailable onMove={moveWindow} />
      </div>
    </section>
    <p className="designSystemNote">Lanes: 220px ellipsized labels with name · role · model in the tooltip and accessible name, a per-lane max in a 72px gutter, and a taller primary lane. Beyond eight roster lanes, Direct subagents and each workflow collapse into one group row; Primary and Compactions never collapse. Lane names are quiet buttons that focus the agent across the tab (inert here). Lanes, labels, and the minimap carry no role tint; the minimap window is grey, only cache-evidence ticks stay amber, and its hint lives in the tooltip and accessible description.</p>
    <section className="panel requestsActionsPanel" aria-label="Single chart sample" style={SAMPLE_PANEL_STYLE}>
      <div className="requestsActionsPlot">
        <p className="requestsActionsScale"><strong>0–{compactNumber(SAMPLE_MAXIMUM)} tokens</strong><span>Rescaled · cache reads excluded</span></p>
        <RequestBarsChart {...chart} maximum={SAMPLE_MAXIMUM} phone={false} onMove={moveWindow} agents={SAMPLE_AGENTS} onInspect={setInspectedId} />
        <RequestRoleLegend rows={SAMPLE_ROWS.slice(windowStart - 1, end)} agents={SAMPLE_AGENTS} named={SAMPLE_ROWS.find((row) => row.id === inspectedId) ?? selected} />
      </div>
    </section>
    <p className="designSystemNote">Single chart: one whole-history scale, a 4px role-family segment under each bar, and a legend of the roles in view with distinct agent counts. Hovering or focusing a bar names its agent beside the legend, else the selected request&apos;s agent. Phone draws only the single chart and has no layout toggle.</p>
    <section className="activityPanel" aria-label="Phone Activities exceptions sample" style={SAMPLE_PANEL_STYLE}>
      <header className="activityPanelHeader"><div><h2>Phone Activities exceptions</h2><p>Static selected request and nested call-line sample.</p></div></header>
      <div className="activityLayout isPhone designSystemActivityPhoneSample">
        <div className="activityFeed">
          <article className="activityTableFrame isSelectedRequest" aria-label="Selected request #34">
            <button type="button" className="commandQuietAction activityRow activityRequestLine" aria-pressed="true" aria-label="Request #34, Primary agent, orchestrator, model claude-opus-5, uncached input 12,480, 12:34 PM, 1 call">
              <span className="requestsActionsNumber">#34</span><span className="activityRequestWho"><strong>Primary agent</strong> <span>orchestrator</span> <span className="activityRequestModel">claude-opus-5</span></span><span className="activityRequestMeta">12.5k in · <time dateTime="2026-08-09T12:34:00.000Z">12:34 PM</time></span>
            </button>
            <ul className="activityTable"><li><button type="button" className="commandQuietAction activityCallLine" aria-expanded="false" aria-label="Bash, verify-ui, 0.8s"><WorkKindIcon kind="shell" /><span className="activityCallTarget">verify-ui</span><span className="activityCallDuration">0.8s</span><svg className="activityCallChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg></button></li></ul>
          </article>
          <p className="designSystemNote">Documented exceptions: the selected phone request group alone carries the brand left rule; its nested call disclosure line alone is 32px high.</p>
        </div>
      </div>
    </section>
  </Section>;
}

function PanelsSection() {
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
        <CommandMetric label="KPI tile" value="12,480" detail="CommandMetric · label, value, detail" />
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
    <div className="designSystemGrid">
      <DashboardDisclosurePanel title="Disclosure" storageKey="pomegr-design-system-disclosure" defaultOpen summary={<span className="disclosureSummaryUnavailable">Collapsed summary text</span>}>
        <div className="designSystemPanelBody"><p className="designSystemLede">DashboardDisclosurePanel: a native details element with a 24px plus/minus icon, 13px/610 title, and a 1px top rule on the body. Its open state persists per storage key.</p></div>
      </DashboardDisclosurePanel>
    </div>
  </Section>;
}

const TYPE_SCALE = [
  { name: "Title", tokens: "--text-title · 600 · --font-ui", style: { font: "600 var(--text-title)/1.25 var(--font-ui)", letterSpacing: "-.025em" } },
  { name: "Section heading", tokens: "--text-heading · 600 · --font-ui", style: { font: "600 var(--text-heading)/1.35 var(--font-ui)" } },
  { name: "Body", tokens: "--text-base · 400 · --font-ui", style: { font: "400 var(--text-base)/1.5 var(--font-ui)" } },
  { name: "Control", tokens: "--text-sm · 500 · --font-ui", style: { font: "500 var(--text-sm)/1.4 var(--font-ui)" } },
  { name: "Metadata", tokens: "--text-xs · 400 · --font-ui · --command-muted", style: { font: "400 var(--text-xs)/1.4 var(--font-ui)", color: "var(--command-muted)" } },
  { name: "Caption", tokens: "--text-caption · 500 · --font-ui · --command-faint · uppercase", style: { font: "500 var(--text-caption)/1.4 var(--font-ui)", color: "var(--command-faint)", letterSpacing: ".06em", textTransform: "uppercase" } },
  { name: "Data", tokens: "--text-xs · 400 · --font-data · tabular-nums", style: { font: "400 var(--text-xs)/1.4 var(--font-data)", fontVariantNumeric: "tabular-nums" } },
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

function TypographySection() {
  return <Section id="typography" title="Typography and tokens" lede="Inter carries the interface (--font-ui); Geist Mono is reserved for data (--font-data). Every value below resolves through app/styles/tokens.css, so this page follows the active theme.">
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
