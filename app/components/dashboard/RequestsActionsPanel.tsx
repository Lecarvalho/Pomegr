"use client";

import { useMemo, useRef, useState } from "react";
import type { Agent, CacheEventFeed, ContextHistoryBoundary, RequestSnapshot, RequestSnapshotFeed } from "../../../shared/monitor-contract";
import { agentDisplayName, agentTreeRows } from "../../dashboard-utils";
import { usePhoneLayout } from "../../hooks/usePhoneLayout";
import { EmptyState } from "../EmptyState";
import { CommandSelect } from "../command-center/CommandPage";
import { LargestRequestsList } from "./requests-actions/LargestRequestsList";
import { RequestBarsChart } from "./requests-actions/RequestBarsChart";
import { RequestDetail, RequestNavigation } from "./requests-actions/RequestDetail";
import { RequestMinimap } from "./requests-actions/RequestMinimap";
import { scopedRows, scaleMax, type ChartMode, type RequestRow } from "./requests-actions/model";
import { useRequestSelection } from "./requests-actions/useRequestSelection";
import { CacheEvidenceDisclosure } from "./CacheEvidenceDisclosure";

export function RequestsActionsPanel({ agents, requestSnapshots, contextBoundaries, cacheWriteAvailable, historical, cacheEvents }: {
  agents: Agent[]; requestSnapshots: RequestSnapshotFeed; contextBoundaries: ContextHistoryBoundary[];
  cacheWriteAvailable: boolean; historical: boolean; cacheEvents?: CacheEventFeed;
}) {
  const phone = usePhoneLayout();
  const [scope, setScope] = useState("all");
  const [mode, setMode] = useState<ChartMode>("fresh");
  const resolvedScope = scope === "all" || agents.some((agent) => agent.id === scope) ? scope : "all";
  const rows = useMemo(() => scopedRows(requestSnapshots, contextBoundaries, resolvedScope), [requestSnapshots, contextBoundaries, resolvedScope]);
  const size = phone ? 20 : 60;
  const { selected, start, end, select, selectScope, step, moveWindow } = useRequestSelection(rows, resolvedScope, size, historical);
  const maximum = Math.max(1, scaleMax(rows, mode));
  const chartRef = useRef<HTMLDivElement>(null);
  const locate = (row: RequestRow) => {
    select(row, true);
    if (phone) chartRef.current?.scrollIntoView?.({ block: "start" });
  };
  const locateEvidence = (snapshot: RequestSnapshot) => {
    const nextScope = resolvedScope === "all" ? "all" : snapshot.agentId;
    const nextRows = scopedRows(requestSnapshots, contextBoundaries, nextScope);
    const row = nextRows.find((item) => item.id === snapshot.id);
    if (!row) return;
    setScope(nextScope);
    selectScope(nextRows, nextScope, row);
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
        {mode === "fresh" && <span><i className="requestsActionsSwatch outline" />{phone ? "Prompt size" : "Prompt size outline"}</span>}
        {!phone && <span><i className="requestsActionsSwatch compaction" />Compaction dashed</span>}
      </div>
      <div className="requestsActionsModes" aria-label="Chart mode">{([['fresh', 'Fresh tokens'], ['full', 'Full breakdown']] as const).map(([value, label]) => <button type="button" className="requestsActionsButton" aria-pressed={mode === value} key={value} onClick={() => setMode(value)}>{label}</button>)}</div>
      <label className="contextScopeControl requestsActionsScope"><span className="srOnly">Agent scope</span><CommandSelect value={resolvedScope} onChange={(event) => setScope(event.target.value)} aria-label="Agent scope"><option value="all">All agents</option>{agentTreeRows(agents).map(({ agent }) => <option key={agent.id} value={agent.id}>{agentDisplayName(agent)}</option>)}</CommandSelect></label>
    </header>
    {requestSnapshots?.status !== "ready" || !rows.length || !selected ? <EmptyState text="No request observations for this session yet." /> : <>
      <div className="requestsActionsPlot" ref={chartRef}>
        <RequestBarsChart rows={rows} start={start} end={end} size={size} maximum={maximum} mode={mode} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={select} onStep={step} />
        {!phone && <RequestMinimap rows={rows} start={start} end={end} mode={mode} onMove={moveWindow} />}
        {phone && <RequestNavigation ordinal={selected.ordinal} count={rows.length} onStep={step} />}
      </div>
      <div className="requestsActionsDetails">
        <RequestDetail row={selected} agent={agents.find((agent) => agent.id === selected.agentId)} count={rows.length} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onStep={step} />
        <LargestRequestsList rows={rows} agents={agents} selectedId={selected.id} phone={phone} cacheWriteAvailable={cacheWriteAvailable} onSelect={locate} />
      </div>
      <p className="requestsActionsRetention">Numbers are positions in the retained feed (latest 100 per agent), not provider ids.</p>
    </>}
  </section>{cacheEvents && <CacheEvidenceDisclosure agents={agents} cacheEvents={cacheEvents} requestSnapshots={requestSnapshots} cacheWriteAvailable={cacheWriteAvailable} historical={historical} selectedSnapshot={selected} onSelectSnapshot={locateEvidence} />}</>;
}
