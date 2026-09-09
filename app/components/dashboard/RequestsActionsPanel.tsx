"use client";

import { useRef, useState } from "react";
import type { Agent, CacheEventFeed, CacheReadDropFeed, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../../shared/monitor-contract";
import { agentDisplayName, agentTreeRows, compactNumber } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { CommandSelect } from "../command-center/CommandPage";
import { LargestRequestsList } from "./requests-actions/LargestRequestsList";
import { RequestBarsChart } from "./requests-actions/RequestBarsChart";
import { RequestDetail, RequestNavigation } from "./requests-actions/RequestDetail";
import { RequestMinimap } from "./requests-actions/RequestMinimap";
import { scopedRows, scaleMax, type ChartMode, type RequestRow } from "./requests-actions/model";
import type { SessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import { CacheEvidenceDisclosure } from "./CacheEvidenceDisclosure";
import { CacheRefillIcon } from "./CacheRefillIcon";

export function RequestsActionsPanel({ agents, requestSnapshots, contextBoundaries, cacheWriteAvailable, historical, cacheEvents, cacheReadDrops, selection }: {
  agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  cacheWriteAvailable: boolean; historical: boolean; cacheEvents?: CacheEventFeed; cacheReadDrops?: CacheReadDropFeed;
  selection: SessionRequestSelection;
}) {
  const [mode, setMode] = useState<ChartMode>("fresh");
  const { selected, start, end, select, selectScope, step, moveWindow, phone, size, rows, scope: resolvedScope, setScope, locate: locateRequest, history: requestHistory } = selection;
  const maximum = Math.max(1, scaleMax(rows, mode, cacheWriteAvailable));
  const chartRef = useRef<HTMLDivElement>(null);
  const locate = (row: RequestRow) => {
    select(row, true);
    if (phone) chartRef.current?.scrollIntoView?.({ block: "start" });
  };
  const locateEvidence = (snapshot: RequestSnapshot) => {
    if (!requestHistory.enabled) {
      const nextScope = resolvedScope === "all" ? "all" : snapshot.agentId;
      const nextRows = scopedRows(requestSnapshots, contextBoundaries, nextScope, cacheEvents, cacheReadDrops);
      const row = nextRows.find((item) => item.id === snapshot.id);
      if (!row) return;
      setScope(nextScope);
      selectScope(nextRows, nextScope, row);
      chartRef.current?.scrollIntoView?.({ block: "start" });
      return;
    }
    locateRequest(snapshot.id);
    chartRef.current?.scrollIntoView?.({ block: "start" });
  };
  return <><section className="panel requestsActionsPanel" aria-label="Requests & actions">
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
    {requestHistory.enabled && <p className="requestsActionsRetention" aria-live="polite">{requestHistory.status === "loading" ? "Loading request history…" : requestHistory.status === "unavailable" ? "Request history is unavailable." : `Showing ${rows.length ? `${requestHistory.offset + 1}–${requestHistory.offset + rows.length}` : "0"} of ${requestHistory.total.toLocaleString()} requests.`}</p>}
    {(!requestHistory.enabled && requestSnapshots?.status !== "ready") || !rows.length || !selected ? <EmptyState text="No request observations for this session yet." /> : <>
      <div className="requestsActionsPlot" ref={chartRef}>
        <p className="requestsActionsScale" aria-live="polite"><strong>0–{compactNumber(maximum)} tokens</strong><span>{mode === "fresh" ? "Rescaled · cache reads excluded" : "All input + output"}</span></p>
        <RequestBarsChart rows={rows} start={start} end={end} size={size} maximum={maximum} mode={mode} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={select} onStep={step} />
        {!phone && <RequestMinimap rows={rows} start={start} end={end} mode={mode} cacheWriteAvailable={cacheWriteAvailable} onMove={moveWindow} total={requestHistory.enabled ? requestHistory.total : undefined} />}
        {phone && <RequestNavigation ordinal={selected.ordinal} count={rows.length} onStep={step} canPrev={selected.ordinal > 1 || (requestHistory.enabled && requestHistory.hasOlder)} canNext={selected.ordinal < rows.length || (requestHistory.enabled && requestHistory.hasNewer)} />}
        {requestHistory.enabled && <nav className="requestsActionsNavigation" aria-label="Request history pages"><button type="button" className="commandSecondaryAction" disabled={!requestHistory.hasOlder || requestHistory.status === "loading"} onClick={requestHistory.first}>First</button><button type="button" className="commandSecondaryAction" disabled={!requestHistory.hasOlder || requestHistory.status === "loading"} onClick={requestHistory.older}>Older</button><button type="button" className="commandSecondaryAction" disabled={!requestHistory.hasNewer || requestHistory.status === "loading"} onClick={requestHistory.newer}>Newer</button><button type="button" className="commandSecondaryAction" disabled={!requestHistory.hasNewer || requestHistory.status === "loading"} onClick={requestHistory.latest}>Latest</button></nav>}
      </div>
      <div className="requestsActionsDetails">
        <RequestDetail row={selected} agent={agents.find((agent) => agent.id === selected.agentId)} count={rows.length} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onStep={step} canPrev={selected.ordinal > 1 || (requestHistory.enabled && requestHistory.hasOlder)} canNext={selected.ordinal < rows.length || (requestHistory.enabled && requestHistory.hasNewer)} />
        <LargestRequestsList rows={rows} agents={agents} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={locate} />
      </div>
      <p className="requestsActionsRetention">{requestHistory.enabled ? "Request numbers are stable labels within this session, not provider ids." : "Request numbers are positions in the retained feed (latest 100 per agent), not provider ids."} Before and Issued come from transcript adjacency and recorded links; they do not establish token cost per operation.</p>
    </>}
  </section>{cacheEvents && <CacheEvidenceDisclosure agents={agents} cacheEvents={cacheEvents} requestSnapshots={requestSnapshots} cacheWriteAvailable={cacheWriteAvailable} historical={historical} selectedSnapshot={selected} onSelectSnapshot={locateEvidence} />}</>;
}
