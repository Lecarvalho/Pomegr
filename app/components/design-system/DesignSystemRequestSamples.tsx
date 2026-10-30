"use client";

import { useState } from "react";
import type { Agent, CacheRefillCount, CacheRefillOccurrence, Workflow } from "../../../shared/monitor-contract";
import type { WorkKind } from "../../../shared/request-snapshot-contract";
import type { HistoryActivity } from "../../../shared/session-history-contract";
import { PopoverFrame } from "../PopoverFrame";
import { WorkKindIcon } from "../WorkKindIcon";
import { cacheRefillEvidenceView } from "../dashboard/AgentHistoryIndicators";
import { ActivityUnassociatedSection } from "../dashboard/activity-feed/ActivityUnassociatedSection";
import { IDLE_UNASSOCIATED } from "../dashboard/activity-feed/useUnassociatedActivity";
import { buildRequestLanes } from "../dashboard/requests-actions/lane-model";
import { scaleMax, type RequestRow } from "../dashboard/requests-actions/model";
import { RequestBarsChart } from "../dashboard/requests-actions/RequestBarsChart";
import { requestRefillTooltip } from "../dashboard/requests-actions/RequestEvidencePopover";
import { RequestLaneChart } from "../dashboard/requests-actions/RequestLaneChart";
import { RequestMinimap } from "../dashboard/requests-actions/RequestMinimap";
import { RequestRoleLegend } from "../dashboard/requests-actions/RequestRoleTrack";
import { SAMPLE_TIME, Section, sampleAgent } from "./DesignSystemKit";

export function RoleFamilySection() {
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

const SAMPLE_WINDOW = 32;
const SAMPLE_WORKFLOW_ID = "sample-test-sweep";

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
    ordinal: index + 1, number: index + 1, freshTokens: uncachedInputTokens + cacheWriteTokens + outputTokens,
    compactionBefore: index === 16 || index === 33,
    ...(index === 37 ? { cacheEvidence: { kind: "refill" as const } } : {}),
  };
});
const SAMPLE_LANES = buildRequestLanes(SAMPLE_ROWS, SAMPLE_AGENTS, "fresh", true).lanes;
const SAMPLE_PANEL_STYLE = { marginTop: "var(--space-4)" };
function ignoreFocus() {}

function unrecorded(id: number, minute: number, tool: string, workKind: WorkKind, detail: string, overrides: Partial<HistoryActivity> = {}): HistoryActivity {
  return { id: `sample-unrecorded-${id}`, timestamp: new Date(SAMPLE_TIME + minute * 60_000).toISOString(), actor: "Primary agent", tool, workKind, detail, status: null, durationMs: 1_500, requestId: null, agentId: "primary", requestNumber: null, ...overrides };
}
const UNRECORDED_CALLS: HistoryActivity[] = [
  unrecorded(9, 21, "Bash", "shell", "Check the docs", { durationMs: 4_200 }),
  unrecorded(10, 23, "Read", "read", "docs/internal/architecture/metrics.md", { durationMs: 300 }),
  unrecorded(11, 25, "Edit", "write", "app/styles/activity-feed.css", { agentId: "worker-1", actor: "Lane model tests" }),
  unrecorded(12, 27, "Bash", "test", "Run the focused tests", { status: "failed", durationMs: 12_800 }),
  unrecorded(13, 29, "Bash", "shell", "Check the architecture", { durationMs: null }),
  unrecorded(14, 31, "Edit", "write", "DESIGN.md"),
];
const UNRECORDED_CLOSED = { ...IDLE_UNASSOCIATED, total: 14 };
const UNRECORDED_OPEN = { ...IDLE_UNASSOCIATED, total: 14, open: true, status: "ready" as const, remaining: 8, calls: UNRECORDED_CALLS };

/** The lane and single charts of one request window. Tests mount this part without the section's heading. */
export function RequestChartSamples() {
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
  const visibleMaximum = Math.max(1, scaleMax(SAMPLE_ROWS.slice(windowStart - 1, end), "fresh", true));
  const chart = { rows: SAMPLE_ROWS, start: windowStart, end, size: SAMPLE_WINDOW, mode: "fresh" as const, selectedId: selected.id, cacheWriteAvailable: true,
    onSelect: (row: RequestRow) => selectIndex(row.ordinal - 1), onStep: (delta: number) => selectIndex(selectedIndex + delta), windowStart, total: SAMPLE_ROWS.length };
  return <>
    <section className="panel requestsActionsPanel" aria-label="Lane chart sample" style={SAMPLE_PANEL_STYLE}>
      <div className="requestsActionsPlot">
        <p className="requestsActionsRange">Showing #{windowStart}–#{end} of {SAMPLE_ROWS.length}</p>
        <RequestLaneChart lanes={SAMPLE_LANES} agents={SAMPLE_AGENTS} workflows={SAMPLE_WORKFLOWS} expanded={expanded} onToggleGroup={toggleGroup} focusedAgentId={null} onFocusAgent={ignoreFocus} {...chart} />
        <RequestMinimap rows={SAMPLE_ROWS} start={windowStart} end={end} mode="fresh" cacheWriteAvailable onMove={moveWindow} />
      </div>
    </section>
    <p className="designSystemNote">Lanes: 220px ellipsized labels with name · role · model in the tooltip and accessible name, a per-lane max in a 72px gutter, and a taller primary lane. Beyond eight roster lanes, Direct subagents and each workflow collapse into one group row; Primary and Compactions never collapse. Lane names are quiet buttons that focus the agent across the tab (inert here). Lanes, labels, and the minimap carry no role tint; the minimap window is grey, only cache-evidence ticks stay amber, and its hint lives in the tooltip and accessible description.</p>
    <section className="panel requestsActionsPanel" aria-label="Single chart sample" style={SAMPLE_PANEL_STYLE}>
      <div className="requestsActionsPlot">
        <p className="requestsActionsRange">Showing #{windowStart}–#{end} of {SAMPLE_ROWS.length}</p>
        <RequestBarsChart {...chart} maximum={visibleMaximum} phone={false} onMove={moveWindow} agents={SAMPLE_AGENTS} onInspect={setInspectedId} />
        <RequestRoleLegend rows={SAMPLE_ROWS.slice(windowStart - 1, end)} agents={SAMPLE_AGENTS} named={SAMPLE_ROWS.find((row) => row.id === inspectedId) ?? selected} />
      </div>
    </section>
    <p className="designSystemNote">Single chart: one visible-window scale so off-window requests cannot compress its bars, a 4px role-family segment under each bar, and a legend of the roles in view with distinct agent counts. Hovering or focusing a bar names its agent beside the legend, else the selected request&apos;s agent. Phone draws only the single chart and has no layout toggle.</p>
  </>;
}

/** The phone Activities exceptions and the section of actions without a recorded request, closed and open. All static. */
export function PhoneActivitySamples() {
  return <>
    <section className="activityPanel" aria-label="Phone Activities exceptions sample" style={SAMPLE_PANEL_STYLE}>
      <header className="activityPanelHeader"><div><h2>Phone Activities exceptions</h2><p>Static selected request and nested call-line sample.</p></div></header>
      <div className="activityLayout isPhone designSystemActivityPhoneSample">
        <div className="activityFeed">
          <article className="activityTableFrame isSelectedRequest" aria-label="Selected request #34">
            <button type="button" className="commandQuietAction activityRow activityRequestLine" aria-pressed="true" aria-label="Request #34, Primary agent, orchestrator, model claude-opus-5, uncached input 12,480, cache write 3,120, output 840, 12:34 PM, 1 call">
              <span className="requestsActionsNumber">#34</span><span className="activityRequestWho"><strong>Primary agent</strong> <span>orchestrator</span> <span className="activityRequestModel">claude-opus-5</span></span><span className="activityRequestMeta"><span className="activityRequestTokens"><span className="activityTokenValue uncached">12.5k</span><span className="activityTokenValue write">3,120</span><span className="activityTokenValue output">840</span></span><time dateTime="2026-08-09T12:34:00.000Z">12:34 PM</time></span>
            </button>
            <ul className="activityTable"><li><button type="button" className="commandQuietAction activityCallLine" aria-expanded="false" aria-label="Bash, verify-ui, 0.8s"><WorkKindIcon kind="shell" /><span className="activityCallTarget">verify-ui</span><span className="activityCallDuration">0.8s</span><svg className="activityCallChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg></button></li></ul>
          </article>
          <p className="designSystemNote">Documented exceptions: the selected phone request group alone carries the brand left rule; its nested call disclosure line alone is 32px high.</p>
        </div>
      </div>
    </section>
    <section className="activityPanel" aria-label="Closed actions without a recorded request sample" style={SAMPLE_PANEL_STYLE}>
      <div className="activityLayout isPhone designSystemActivityPhoneSample designSystemUnassociatedClosed">
        <div className="activityFeedColumn"><ActivityUnassociatedSection unassociated={UNRECORDED_CLOSED} agents={SAMPLE_AGENTS} busy={false} /></div>
      </div>
    </section>
    <p className="designSystemNote">Closed, the section reads &ldquo;Actions without a recorded request&rdquo; with its call count and nothing else. It is absent when the committed feed counts no such calls, so it never appears and then disappears.</p>
    <section className="activityPanel" aria-label="Open actions without a recorded request sample" style={SAMPLE_PANEL_STYLE}>
      <div className="activityLayout isPhone designSystemActivityPhoneSample designSystemUnassociatedOpen">
        <div className="activityFeedColumn">
          <div className="activityFeed">
            <article className="activityTableFrame" aria-label="Request #12">
              <button type="button" className="commandQuietAction activityRow activityRequestLine" aria-pressed="false" aria-label="Request #12, Primary agent, orchestrator, model claude-opus-5, uncached input 9,860, cache write 410, output 1,260, 12:34 PM, 1 call">
                <span className="requestsActionsNumber">#12</span><span className="activityRequestWho"><strong>Primary agent</strong> <span>orchestrator</span> <span className="activityRequestModel">claude-opus-5</span></span><span className="activityRequestMeta"><span className="activityRequestTokens"><span className="activityTokenValue uncached">9.9k</span><span className="activityTokenValue write">410</span><span className="activityTokenValue output">1,260</span></span><time dateTime="2026-08-09T12:34:00.000Z">12:34 PM</time></span>
              </button>
              <ul className="activityTable"><li><button type="button" className="commandQuietAction activityCallLine" aria-expanded="false" aria-label="Read, metrics.md, 0.3s"><WorkKindIcon kind="read" /><span className="activityCallTarget">metrics.md</span><span className="activityCallDuration">0.3s</span><svg className="activityCallChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg></button></li></ul>
            </article>
          </div>
          <ActivityUnassociatedSection unassociated={UNRECORDED_OPEN} agents={SAMPLE_AGENTS} busy={false} />
        </div>
      </div>
    </section>
    <p className="designSystemNote">Open, the section lists its calls oldest first with the recorded time, kind icon, target and wall duration, a failed call included, under the request group it is ruled apart from. Listed apart, never attributed to a request: no row carries a request number or a token value, and the rows are tool calls, not successful edits. Show more loads the calls just older than those listed.</p>
  </>;
}

export function RequestChartsSection() {
  return <Section id="request-charts" title="Request charts" lede="Activities draws one lane per agent on desktop; Single chart stacks every request on one scale above the role-family agent track. Both share request order, window, selection, arrow keys, and the neutral minimap. Static data only.">
    <RequestChartSamples />
    <PhoneActivitySamples />
  </Section>;
}

const REFILL_BASE: CacheRefillOccurrence = { observedAt: "2026-08-09T12:04:00.000Z", reason: "tools_changed", providerStatus: null, cacheLifetimeInference: null, messageChangeSequence: null, toolChangeAttribution: null };
const REFILL_COUNT: CacheRefillCount = { agentId: "primary", count: 0, occurrences: [], reasons: [], toolChangeAttributions: [] };
const REFILLS_DIAGNOSED = [{ ...REFILL_COUNT, providerDiagnosedCount: 2, occurrences: [{ ...REFILL_BASE, kind: "provider_diagnosed" as const }, { ...REFILL_BASE, kind: "provider_diagnosed" as const, observedAt: "2026-08-09T12:21:00.000Z", reason: "messages_changed" as const }] }];
const REFILLS_LIFETIME_ELAPSED = [{ ...REFILL_COUNT, lifetimeElapsedCount: 1, occurrences: [{ ...REFILL_BASE, kind: "lifetime_elapsed" as const, reason: null, cacheLifetimeInference: { cause: "cache_lifetime_elapsed" as const, cacheLifetime: "5m" as const, elapsedMs: 354_000 } }] }];
const REFILLS_POSSIBLE_FULL = [{ ...REFILL_COUNT, count: 1, occurrences: [{ ...REFILL_BASE, reason: "system_changed" as const }], reasons: [{ reason: "system_changed" as const, count: 1 }] }];

const REMOTE_CONTROL_CHANGES = [{ tool: "RemoteTrigger", kind: "added" }, { tool: "PushNotification", kind: "added" }, { tool: "ListAgents", kind: "definition_changed" }] as const;
const REFILLS_DEFERRED_DEFINITIONS = [{ ...REFILL_COUNT, count: 1, occurrences: [{ ...REFILL_BASE, toolChangeAttribution: { cause: "deferred_definitions_loaded" as const, changes: [], addedDefinitionCount: 8 } }], reasons: [{ reason: "tools_changed" as const, count: 1 }], toolChangeAttributions: [{ cause: "deferred_definitions_loaded" as const, count: 1, changes: [] }] }];
const REFILLS_UNEXPLAINED = [{ ...REFILL_COUNT, count: 1, occurrences: [{ ...REFILL_BASE, reason: null }] }];
const REFILLS_REMOTE_CONTROL = [{ ...REFILL_COUNT, count: 1, occurrences: [{ ...REFILL_BASE, toolChangeAttribution: { cause: "remote_control_connected" as const, changes: [...REMOTE_CONTROL_CHANGES] } }], reasons: [{ reason: "tools_changed" as const, count: 1 }], toolChangeAttributions: [{ cause: "remote_control_connected" as const, count: 1, changes: [...REMOTE_CONTROL_CHANGES] }] }];

const DEFERRED_OCCURRENCE: CacheRefillOccurrence = { ...REFILL_BASE, toolChangeAttribution: { cause: "deferred_definitions_loaded", changes: [], addedDefinitionCount: 8 } };
const MARKER_ROWS: RequestRow[] = SAMPLE_ROWS.slice(0, 16).map((row, index) => {
  const refill = (kind: "refill" | "provider_diagnosed", occurrence: CacheRefillOccurrence): RequestRow => ({ ...row, cacheEvidence: { kind, occurrence: { ...occurrence, observedAt: row.observedAt } } });
  return index === 2 ? refill("provider_diagnosed", { ...REFILL_BASE, kind: "provider_diagnosed" }) : index === 5 ? refill("refill", DEFERRED_OCCURRENCE) : row;
});
const UNEXPLAINED_ROW: RequestRow = { ...MARKER_ROWS[5], cacheEvidence: { kind: "refill", occurrence: { ...REFILL_BASE, reason: null, observedAt: MARKER_ROWS[5].observedAt } } };

export function CacheRefillEvidenceSection() {
  const requestFrame = (sample: string, row: RequestRow) => <div data-sample={sample}>
    <span className="tooltipPopover" role="tooltip"><span className="tooltipPopoverText">{requestRefillTooltip(row)}</span></span>
  </div>;
  const frame = (sample: string, refills: CacheRefillCount[]) => {
    const view = cacheRefillEvidenceView(refills, ["primary"]);
    return <div data-sample={sample}><PopoverFrame id={`${sample}-popover`} ariaLabel="Cache refill evidence" eyebrow="Cache evidence" title={view.title} closeLabel="Close cache refill evidence" onClose={ignoreFocus} summary={view.summary}>{view.body}</PopoverFrame></div>;
  };
  return <Section id="cache-refill-evidence" title="Cache refill evidence" lede="The agent cache popover lists a possible full refill (read share at most 10%) apart from a provider-diagnosed refill, where the provider named a reason while part of the prefix was still read from cache. A tools-changed refill can carry a labeled inference: definitions loaded after a tool search (count only, never names) or the fixed Remote Control changes. All render the real popover content, inert and with static data.">
    <div className="designSystemGrid">
      {frame("refill-provider-diagnosed", REFILLS_DIAGNOSED)}
      {frame("refill-lifetime-elapsed", REFILLS_LIFETIME_ELAPSED)}
      {frame("refill-possible-full", REFILLS_POSSIBLE_FULL)}
      {frame("refill-deferred-definitions", REFILLS_DEFERRED_DEFINITIONS)}
      {frame("refill-remote-control", REFILLS_REMOTE_CONTROL)}
      {frame("refill-unexplained", REFILLS_UNEXPLAINED)}
    </div>
    <p className="designSystemNote">The Activities request chart shows the same evidence as a small tooltip when a refill marker is hovered or focused. A possible full refill with no reason, provider status or inference says that no cause was recorded and points to the Agents tab; the upstream-issue link stays in the agent popover.</p>
    <div className="designSystemGrid">
      {requestFrame("request-refill-popover", MARKER_ROWS[5])}
      {requestFrame("request-refill-lifetime-elapsed", { ...MARKER_ROWS[5], cacheEvidence: { kind: "lifetime_elapsed", occurrence: { ...REFILLS_LIFETIME_ELAPSED[0].occurrences[0], observedAt: MARKER_ROWS[5].observedAt } } })}
      {requestFrame("request-refill-unexplained", UNEXPLAINED_ROW)}
    </div>
    <section className="panel requestsActionsPanel" aria-label="Refill marker sample" style={SAMPLE_PANEL_STYLE} data-sample="request-refill-marker">
      <div className="requestsActionsPlot">
        <RequestBarsChart rows={MARKER_ROWS} start={1} end={16} size={16} maximum={Math.max(1, scaleMax(MARKER_ROWS, "fresh", true))} mode="fresh" selectedId={MARKER_ROWS[0].id} phone={false} cacheWriteAvailable
          onSelect={ignoreFocus} onStep={ignoreFocus} windowStart={1} total={MARKER_ROWS.length} onMove={ignoreFocus} />
      </div>
    </section>
  </Section>;
}
