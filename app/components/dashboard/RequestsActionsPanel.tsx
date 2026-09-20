"use client";

import { useMemo, useRef, useState } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshotFeed, Workflow } from "../../../shared/monitor-contract";
import { agentDisplayName, agentTreeRows, compactNumber } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { DottedInfoPopover } from "../DottedInfoPopover";
import { CommandSelect } from "../command-center/CommandPage";
import { LargestRequestsList } from "./requests-actions/LargestRequestsList";
import { RequestBarsChart } from "./requests-actions/RequestBarsChart";
import { buildRequestLanes } from "./requests-actions/lane-model";
import { RequestLaneChart } from "./requests-actions/RequestLaneChart";
import { RequestDetail } from "./requests-actions/RequestDetail";
import { RequestMinimap } from "./requests-actions/RequestMinimap";
import { RequestRoleLegend } from "./requests-actions/RequestRoleTrack";
import { isCompleteRequestOverview, scaleMax, type ChartMode, type RequestRow } from "./requests-actions/model";
import type { SessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import { useStableHistoryStatus } from "./requests-actions/useStableHistoryStatus";
import { CacheRefillIcon } from "./CacheRefillIcon";

const NO_WORKFLOWS: Workflow[] = [];

type ChartLayout = "lanes" | "single";

export function RequestsActionsPanel({ agents, workflows = NO_WORKFLOWS, requestSnapshots, cacheWriteAvailable, selection }: {
  agents: Agent[]; workflows?: Workflow[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  cacheWriteAvailable: boolean; historical: boolean; cacheEvents?: CacheEventFeed; cacheReadDrops?: CacheReadDropFeed;
  selection: SessionRequestSelection;
}) {
  const [mode, setMode] = useState<ChartMode>("fresh");
  // Desktop defaults to lanes; phone always draws the single chart with its role track, legend and
  // Largest strip. Expanded lane groups and the
  // layout live here so switching between lanes and the single chart keeps both.
  const [layout, setLayout] = useState<ChartLayout>("lanes");
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const { selected, start, end, select, step, moveWindow, phone, size, rows, scope: resolvedScope, setScope, history: requestHistory } = selection;
  const single = phone || layout === "single";
  // One status for every line the five-second history retry would otherwise flicker.
  const historyStatus = useStableHistoryStatus(requestHistory.status);
  const overview = requestHistory.enabled ? requestHistory.overview : null;
  const scaleRows = useMemo(() => isCompleteRequestOverview(overview, requestHistory.total)
    ? overview.map(([uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens]) => ({ uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens }))
    : null, [overview, requestHistory.total]);
  const scaleInput = scaleRows ?? rows;
  const maximum = useMemo(() => Math.max(1, scaleMax(scaleInput, mode, cacheWriteAvailable)), [scaleInput, mode, cacheWriteAvailable]);
  const lanes = useMemo(() => buildRequestLanes(single ? [] : rows, agents, mode, cacheWriteAvailable), [single, rows, agents, mode, cacheWriteAvailable]);
  const toggleGroup = (groupId: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (!next.delete(groupId)) next.add(groupId);
    return next;
  });
  const windowStart = requestHistory.enabled && !requestHistory.preview ? requestHistory.offset + start : start;
  const chartTotal = requestHistory.enabled ? requestHistory.total : rows.length;
  const scopedAgent = agents.find((agent) => agent.id === resolvedScope);
  const scopeLabel = resolvedScope === "all" ? "All agents" : scopedAgent ? agentDisplayName(scopedAgent) : "Unknown agent";
  const chartRef = useRef<HTMLDivElement>(null);
  const locate = (row: RequestRow) => {
    select(row, true);
    if (phone) chartRef.current?.scrollIntoView?.({ block: "start" });
  };
  return <section className="panel requestsActionsPanel" aria-label="Requests">
    <header className="requestsActionsHeader">
      <div className="requestsActionsHeading"><h2><DottedInfoPopover ariaLabel="About request links" content={<>{!requestHistory.preview && <>{requestHistory.enabled ? "Request numbers are stable labels within this session, not provider ids." : "Request numbers are positions in the retained feed (latest 100 per agent), not provider ids."} </>}Before and Issued come from transcript adjacency and recorded links; they do not establish token cost per operation.</>}>Requests</DottedInfoPopover></h2><span className="sessionEyebrow">One bar per model request</span></div>
      <label className="contextScopeControl requestsActionsScope"><span className="srOnly">Agent scope</span><CommandSelect value={resolvedScope} onChange={(event) => setScope(event.target.value)} aria-label="Agent scope"><option value="all">All agents</option>{agentTreeRows(agents).map(({ agent }) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}</CommandSelect></label>
      <div className="requestsActionsModes">
        <div className="commandSegmented" role="group" aria-label="Chart mode">{([['fresh', 'Fresh tokens'], ['full', 'Full breakdown']] as const).map(([value, label]) => <button type="button" aria-pressed={mode === value} key={value} onClick={() => setMode(value)}>{label}</button>)}</div>
        {!phone && <div className="commandSegmented" role="group" aria-label="Chart layout">{([['lanes', 'Lanes'], ['single', 'Single chart']] as const).map(([value, label]) => <button type="button" aria-pressed={layout === value} key={value} onClick={() => setLayout(value)}>{label}</button>)}</div>}
      </div>
    </header>
    {(!requestHistory.enabled && requestSnapshots?.status !== "ready") || !rows.length || !selected ? <EmptyState text={requestHistory.enabled && historyStatus === "loading" ? "Loading request history…" : requestHistory.enabled && historyStatus === "unavailable" ? "Request history is unavailable. Retrying…" : "No request observations for this session yet."} /> : <>
      <div className="requestsActionsPlot" ref={chartRef}>
        <div className="requestsActionsGuide">
          <p className="requestsActionsScale" aria-live="polite"><strong>{single ? `0–${compactNumber(maximum)} tokens` : <DottedInfoPopover ariaLabel="About lanes" content="Each lane has its own scale; max is its tallest request on the loaded page. Click a lane name to focus that agent across the tab, and click it again to show all agents. With more than eight lanes, workflow groups collapse; click a group name to expand it.">Per-lane scales</DottedInfoPopover>}</strong><span>{mode === "fresh" ? "Rescaled · cache reads excluded" : "All input + output"}</span></p>
          <div className="requestsActionsLegend" aria-label="Chart legend">
            <span><i className="requestsActionsSwatch uncached" />{phone ? "Uncached" : "Uncached input"}</span>
            {cacheWriteAvailable && <span><i className="requestsActionsSwatch write" />Cache write</span>}
            {mode === "full" && <span><i className="requestsActionsSwatch read" />Cache read</span>}
            <span><i className="requestsActionsSwatch output" />Output</span>
            <span><i className="requestsActionsSwatch compaction" />Compaction dashed</span>
            {rows.some((row) => row.cacheEvidence?.kind === "refill") && <span><CacheRefillIcon className="requestsActionsLegendIcon" />Possible full refill dotted</span>}
            {rows.some((row) => row.cacheEvidence?.kind === "possible_refill") && <span><CacheRefillIcon inferred className="requestsActionsLegendIcon" />Possible refill dotted</span>}
            {rows.some((row) => row.cacheEvidence?.kind === "model_change") && <span><CacheRefillIcon inferred className="requestsActionsLegendIcon" />Reuse drop · model change dotted</span>}
          </div>
        </div>
        {single
          ? <RequestBarsChart rows={rows} start={start} end={end} size={size} maximum={maximum} mode={mode} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={select} onStep={step} windowStart={windowStart} total={chartTotal} onMove={requestHistory.enabled ? requestHistory.moveWindow : moveWindow}
            agents={agents} onInspect={setInspectedId} />
          : <RequestLaneChart lanes={lanes.lanes} agents={agents} workflows={workflows} expanded={expandedGroups} onToggleGroup={toggleGroup} focusedAgentId={resolvedScope === "all" ? null : resolvedScope} onFocusAgent={(agentId) => setScope(agentId ?? "all")} rows={rows} start={start} end={end} size={size} mode={mode} selectedId={selected.id} cacheWriteAvailable={cacheWriteAvailable} onSelect={select} onStep={step} windowStart={windowStart} total={chartTotal} />}
        {single && <RequestRoleLegend rows={rows.slice(start - 1, end)} agents={agents} named={(inspectedId && rows.find((row) => row.id === inspectedId)) || selected} />}
        <RequestMinimap rows={rows} overview={overview} start={requestHistory.enabled ? requestHistory.windowStart : start} end={requestHistory.enabled ? Math.min(requestHistory.total, requestHistory.windowStart + size - 1) : end} total={requestHistory.enabled ? requestHistory.total : rows.length} offset={requestHistory.enabled ? requestHistory.offset : 0} mode={mode} cacheWriteAvailable={cacheWriteAvailable} onMove={requestHistory.enabled ? requestHistory.moveWindow : moveWindow} interactive={!requestHistory.enabled || isCompleteRequestOverview(overview, requestHistory.total)} />
        <LargestRequestsList rows={rows} scopeLabel={scopeLabel} selectedId={selected.id} cacheWriteAvailable={cacheWriteAvailable} onSelect={locate} />
      </div>
      <div className="requestsActionsDetails">
        <RequestDetail row={selected} agent={agents.find((agent) => agent.id === selected.agentId)} count={rows.length} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onStep={step} canPrev={selected.ordinal > 1 || (requestHistory.enabled && requestHistory.hasOlder)} canNext={selected.ordinal < rows.length || (requestHistory.enabled && requestHistory.hasNewer)} />
      </div>
      {requestHistory.preview && <p className="requestsActionsRetention">{historyStatus === "unavailable" ? "Showing recent requests by time. Full history is unavailable; retrying…" : "Showing recent requests by time while full history loads…"}</p>}
    </>}
  </section>;
}
