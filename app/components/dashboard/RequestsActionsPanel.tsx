"use client";

import { useMemo, useRef, useState } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshotFeed } from "../../../shared/monitor-contract";
import { agentDisplayName, agentTreeRows, compactNumber } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { CommandSelect } from "../command-center/CommandPage";
import { LargestRequestsList } from "./requests-actions/LargestRequestsList";
import { RequestBarsChart } from "./requests-actions/RequestBarsChart";
import { RequestDetail } from "./requests-actions/RequestDetail";
import { RequestMinimap } from "./requests-actions/RequestMinimap";
import { isCompleteRequestOverview, scaleMax, type ChartMode, type RequestRow } from "./requests-actions/model";
import type { SessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import { CacheRefillIcon } from "./CacheRefillIcon";

export function RequestsActionsPanel({ agents, requestSnapshots, cacheWriteAvailable, selection }: {
  agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  cacheWriteAvailable: boolean; historical: boolean; cacheEvents?: CacheEventFeed; cacheReadDrops?: CacheReadDropFeed;
  selection: SessionRequestSelection;
}) {
  const [mode, setMode] = useState<ChartMode>("fresh");
  const { selected, start, end, select, step, moveWindow, phone, size, rows, scope: resolvedScope, setScope, history: requestHistory } = selection;
  const overview = requestHistory.enabled ? requestHistory.overview : null;
  const scaleRows = useMemo(() => isCompleteRequestOverview(overview, requestHistory.total)
    ? overview.map(([uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens]) => ({ uncachedInputTokens, cacheWriteTokens, cacheReadTokens, outputTokens }))
    : null, [overview, requestHistory.total]);
  const scaleInput = scaleRows ?? rows;
  const maximum = useMemo(() => Math.max(1, scaleMax(scaleInput, mode, cacheWriteAvailable)), [scaleInput, mode, cacheWriteAvailable]);
  const scopedAgent = agents.find((agent) => agent.id === resolvedScope);
  const scopeLabel = resolvedScope === "all" ? "All agents" : scopedAgent ? agentDisplayName(scopedAgent) : "Unknown agent";
  const chartRef = useRef<HTMLDivElement>(null);
  const locate = (row: RequestRow) => {
    select(row, true);
    if (phone) chartRef.current?.scrollIntoView?.({ block: "start" });
  };
  return <section className="panel requestsActionsPanel" aria-label="Requests & actions">
    <header className="requestsActionsHeader">
      <div className="requestsActionsHeading"><h2>Requests &amp; actions</h2><span className="sessionEyebrow">One bar per model request</span></div>
      <div className="requestsActionsLegend" aria-label="Chart legend">
        <span><i className="requestsActionsSwatch uncached" />{phone ? "Uncached" : "Uncached input"}</span>
        {cacheWriteAvailable && <span><i className="requestsActionsSwatch write" />Cache write</span>}
        {mode === "full" && <span><i className="requestsActionsSwatch read" />Cache read</span>}
        <span><i className="requestsActionsSwatch output" />Output</span>
        <span><i className="requestsActionsSwatch compaction" />Compaction dashed</span>
        {rows.some((row) => row.cacheEvidence?.kind === "refill") && <span><CacheRefillIcon className="requestsActionsLegendIcon" />Possible full refill dotted</span>}
        {rows.some((row) => row.cacheEvidence?.kind === "possible_refill") && <span><CacheRefillIcon inferred className="requestsActionsLegendIcon" />Possible refill dotted</span>}
      </div>
      <div className="commandSegmented requestsActionsModes" role="group" aria-label="Chart mode">{([['fresh', 'Fresh tokens'], ['full', 'Full breakdown']] as const).map(([value, label]) => <button type="button" aria-pressed={mode === value} key={value} onClick={() => setMode(value)}>{label}</button>)}</div>
      <label className="contextScopeControl requestsActionsScope"><span className="srOnly">Agent scope</span><CommandSelect value={resolvedScope} onChange={(event) => setScope(event.target.value)} aria-label="Agent scope"><option value="all">All agents</option>{agentTreeRows(agents).map(({ agent }) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}</CommandSelect></label>
    </header>
    {(!requestHistory.enabled && requestSnapshots?.status !== "ready") || !rows.length || !selected ? <EmptyState text={requestHistory.enabled && requestHistory.status === "loading" ? "Loading request history…" : requestHistory.enabled && requestHistory.status === "unavailable" ? "Request history is unavailable. Retrying…" : "No request observations for this session yet."} /> : <>
      <div className="requestsActionsPlot" ref={chartRef}>
        <p className="requestsActionsScale" aria-live="polite"><strong>0–{compactNumber(maximum)} tokens</strong><span>{mode === "fresh" ? "Rescaled · cache reads excluded" : "All input + output"}</span></p>
        <RequestBarsChart rows={rows} start={start} end={end} size={size} maximum={maximum} mode={mode} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={select} onStep={step} windowStart={requestHistory.enabled && !requestHistory.preview ? requestHistory.offset + start : start} total={requestHistory.enabled ? requestHistory.total : rows.length} onMove={requestHistory.enabled ? requestHistory.moveWindow : moveWindow} />
        {!requestHistory.preview && <RequestMinimap rows={rows} overview={requestHistory.enabled ? requestHistory.overview : null} start={requestHistory.enabled ? requestHistory.windowStart : start} end={requestHistory.enabled ? Math.min(requestHistory.total, requestHistory.windowStart + size - 1) : end} total={requestHistory.enabled ? requestHistory.total : rows.length} offset={requestHistory.enabled ? requestHistory.offset : 0} mode={mode} cacheWriteAvailable={cacheWriteAvailable} onMove={requestHistory.enabled ? requestHistory.moveWindow : moveWindow} />}
      </div>
      <div className="requestsActionsDetails">
        <RequestDetail row={selected} agent={agents.find((agent) => agent.id === selected.agentId)} count={rows.length} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onStep={step} canPrev={selected.ordinal > 1 || (requestHistory.enabled && requestHistory.hasOlder)} canNext={selected.ordinal < rows.length || (requestHistory.enabled && requestHistory.hasNewer)} />
        {!phone && <LargestRequestsList rows={rows} scopeLabel={scopeLabel} selectedId={selected.id} onSelect={locate} />}
      </div>
      <p className="requestsActionsRetention">{requestHistory.preview ? (requestHistory.status === "unavailable" ? "Showing recent requests by time. Full history is unavailable; retrying…" : "Showing recent requests by time while full history loads…") : requestHistory.enabled ? "Request numbers are stable labels within this session, not provider ids." : "Request numbers are positions in the retained feed (latest 100 per agent), not provider ids."} Before and Issued come from transcript adjacency and recorded links; they do not establish token cost per operation.</p>
    </>}
  </section>;
}
