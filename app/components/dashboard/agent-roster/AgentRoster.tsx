"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Agent, CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary, ExecutionTask, Insight, LoopPattern, PlanTask, RequestSnapshotFeed, Workflow } from "../../../../shared/monitor-contract";
import { agentAssignment, agentDisplayName, agentsWithFinishedVisibility, agentTreeRows, compactNumber, formatDuration } from "../../../dashboard-utils";
import { liveWallTimeMs } from "../../../formatting.mjs";
import { useLiveNow } from "../../../hooks/LiveClockContext";
import { EmptyState } from "../../EmptyState";
import { phaseProgress } from "./workflow-phase-progress";
import { buildRosterGroups, roleTally, statusTally, type RosterGroup } from "./groups";
import { DEFAULT_FILTERS, RosterFilterBar, type RosterFilters } from "./RosterFilters";
import { RosterCaret, RosterRow } from "./RosterRow";
import { AgentInspector } from "./AgentInspector";
import { InspectorSheet } from "./InspectorSheet";
import { AgentGridFooter, AgentGridToolbar, AgentGridView, readGridMetric, type AgentGridMetric } from "./AgentGridView";
import { AgentTreeView } from "../agent-tree/AgentTreeView";
import { usePhoneLayout } from "../../../hooks/usePhoneLayout";

export type AgentActivityViewMode = "list" | "grid";
export type AgentRosterProps = {
  agents: Agent[]; executionTasks: ExecutionTask[]; planTasks: PlanTask[]; historical: boolean;
  cacheRefills?: CacheRefillCount[]; cacheReadDrops?: CacheReadDropCount[]; contextBoundaries?: ContextHistoryBoundary[];
  requestSnapshots?: RequestSnapshotFeed; workflows?: Workflow[]; insights?: Insight[]; loops?: LoopPattern[];
  sessionId?: string; viewMode?: AgentActivityViewMode; onViewModeChange?: (mode: AgentActivityViewMode) => void;
  selectedAgentId?: string | null; onSelectAgent?: (id: string) => void; workflowNavigation?: { id: string; request: number } | null;
  agentNavigation?: { id: string; request: number } | null;
};

function readOpenGroups(sessionId: string): Set<string> {
  try { const value: unknown = JSON.parse(window.localStorage.getItem(`pomegr-agent-roster-open-${sessionId}`) || "[]"); return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []); } catch { return new Set(); }
}

function RosterDistribution({ agents }: { agents: Agent[] }) {
  const tally = statusTally(agents);
  const statuses = Object.entries(tally).filter(([status, count]) => status !== "other" || count > 0);
  return <div className="rosterDistribution">
    <div className="rosterSegments" aria-hidden="true">{statuses.filter(([, count]) => count > 0).map(([status, count]) => <span className={`rosterSegment rosterSegment-${status}`} style={{ flex: count }} key={status} />)}</div>
    <div className="rosterLegends"><div className="rosterStatusLegend">{statuses.map(([status, count]) => <span key={status}><i className={`rosterSegment-${status}`} />{status}<b>{count}</b></span>)}</div><div className="rosterRoleLegend"><span>Roles</span>{roleTally(agents).map(({ role, count }) => <span key={role}>{role}<b>{count}</b></span>)}</div></div>
  </div>;
}

function GroupTreeGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5m0 0-6 5m6-5 6 5" /></svg>; }

function RosterGroupHeader({ group, open, onToggle, onOpenTree, agentsById }: { group: RosterGroup; open: boolean; onToggle: () => void; onOpenTree: (id: string) => void; agentsById: Map<string, Agent> }) {
  const tally = statusTally(group.agents);
  const state = group.workflow?.status === "completed" ? "completed" : group.workflow?.status === "running" ? "running" : `${tally.idle} idle · ${tally.finished} finished`;
  return <div className="rosterGroupHeading">
    <button type="button" className="rosterGroupToggle" aria-expanded={open} onClick={onToggle}>
      <RosterCaret /><span className="rosterGroupTitle"><strong>{group.kind === "workflow" ? "Workflow · " : ""}{group.title}</strong>{group.subtitle && <small className="rosterDesktop">{group.subtitle}</small>}</span>
      <span className="rosterGroupSummary rosterDesktop">{group.rollup.agents} agents · {compactNumber(group.rollup.context)} context · {formatDuration(group.rollup.wallMs)} wall · {group.rollup.toolCalls} calls · {state}</span>
      <span className="rosterGroupSummary rosterPhone">{group.rollup.agents} · {compactNumber(group.rollup.context)} · {group.workflow?.status === "completed" || group.workflow?.status === "running" ? group.workflow.status : `${tally.idle} idle`}</span>
    </button>
    {group.agents[0] && <button type="button" className="rosterGroupOpenTree" aria-label="Open in tree" title={`Open ${group.title} in tree`} onClick={() => onOpenTree(group.agents[0].id)}><GroupTreeGlyph /></button>}
    {open && group.workflow && <ol className="workflowPhaseProgress rosterPhaseProgress" aria-label={`${group.workflow.name} phase progress`}>{phaseProgress(group.workflow, agentsById).map(({ phase, finished, observed, state: phaseState }) => <li key={phase.id}><strong>{phase.label}</strong><span>{phaseState}</span><span>{finished}/{observed} finished</span></li>)}</ol>}
  </div>;
}

export function AgentActivityPanel(props: AgentRosterProps) { return <SessionAgentRoster key={props.sessionId || "agent-activity"} {...props} />; }

function SessionAgentRoster({ agents, executionTasks, planTasks, requestSnapshots, cacheRefills = [], cacheReadDrops = [], contextBoundaries = [], workflows = [], insights = [], loops = [], historical, sessionId = "agent-activity", viewMode = "list", onViewModeChange = () => {}, selectedAgentId, onSelectAgent, workflowNavigation, agentNavigation }: AgentRosterProps) {
  const now = useLiveNow();
  const phone = usePhoneLayout();
  const [filters, setFilters] = useState<RosterFilters>(DEFAULT_FILTERS);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<string | null>(null);
  const [gridMetric, setGridMetric] = useState<AgentGridMetric>("context");
  const [phoneInspectorOpen, setPhoneInspectorOpen] = useState(false);
  const [phoneTreeInspectorId, setPhoneTreeInspectorId] = useState<string | null>(null);
  const [treeFocusId, setTreeFocusId] = useState<string | null>(null);
  const [treeReturnsToSheet, setTreeReturnsToSheet] = useState(false);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const treeOpener = useRef<HTMLElement | null>(null);
  const treeReturnId = useRef<string | null>(null);
  const handledAgentNavigation = useRef<string | null>(null);
  const defaultSelection = agents.find((agent) => agent.id === "primary")?.id || agents[0]?.id || null;
  const selectionCandidate = selectedAgentId === undefined ? selection : selectedAgentId;
  const selected = selectionCandidate && agents.some((agent) => agent.id === selectionCandidate) ? selectionCandidate : defaultSelection;
  // This preference is restored once for the keyed session instance. Later
  // polling updates must preserve the user's current selection.
  useEffect(() => {
    // Restore browser-only preferences after hydration; the server renders closed groups.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpenGroups(readOpenGroups(sessionId));
    setGridMetric(readGridMetric(sessionId));
    try { setFilters((current) => ({ ...current, hideFinished: window.localStorage.getItem(`pomegr-agent-activity-show-finished-${sessionId}`) === "false" })); } catch { /* Local preferences are optional. */ }
    try {
      const stored = window.localStorage.getItem(`pomegr-agent-roster-selected-${sessionId}`);
      const restored = stored && agents.some((agent) => agent.id === stored) ? stored : agents.find((agent) => agent.id === "primary")?.id || agents[0]?.id || null;
      setSelection(restored);
    } catch {
      setSelection(agents.find((agent) => agent.id === "primary")?.id || agents[0]?.id || null);
    }
  // The preference is intentionally not re-read on polling updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const groups = buildRosterGroups(agents, workflows, { historical, now });
  const saveOpen = (next: Set<string>) => { setOpenGroups(next); try { window.localStorage.setItem(`pomegr-agent-roster-open-${sessionId}`, JSON.stringify([...next])); } catch { /* Local preferences are optional. */ } };
  const targetGroupId = groups.find((item) => item.kind !== "primary" && selected && item.agents.some((agent) => agent.id === selected))?.id;
  useEffect(() => {
    if (targetGroupId) {
      // External selection/navigation explicitly requests revealing the target group.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpenGroups((current) => { const next = new Set(current).add(targetGroupId); try { window.localStorage.setItem(`pomegr-agent-roster-open-${sessionId}`, JSON.stringify([...next])); } catch { /* Optional. */ } return next; });
      setRevealed((current) => new Set(current).add(targetGroupId));
    }
    // Selection and workflow navigation open their group once, without defeating manual collapse.
  }, [targetGroupId, sessionId]);
  const requestedWorkflowGroup = groups.find((group) => workflowNavigation && group.id === `workflow:${workflowNavigation.id}`)?.id;
  useEffect(() => {
    if (!requestedWorkflowGroup) return;
    // Explicit workflow navigation must reveal its destination even after restrictive filters.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFilters(DEFAULT_FILTERS);
    setSelection(null);
    setOpenGroups((current) => {
      const next = new Set(current).add(requestedWorkflowGroup);
      try {
        window.localStorage.setItem(`pomegr-agent-roster-open-${sessionId}`, JSON.stringify([...next]));
        window.localStorage.setItem(`pomegr-agent-activity-show-finished-${sessionId}`, "true");
      } catch { /* Local preferences are optional. */ }
      return next;
    });
    setRevealed((current) => new Set(current).add(requestedWorkflowGroup));
  }, [requestedWorkflowGroup, workflowNavigation?.request, sessionId]);
  const requestedAgentId = agentNavigation?.id;
  const requestedAgentRequest = agentNavigation?.request;
  const requestedAgentGroupId = groups.find((group) => group.kind !== "primary" && group.agents.some((agent) => agent.id === requestedAgentId))?.id;
  useEffect(() => {
    if (!requestedAgentId || !agents.some((agent) => agent.id === requestedAgentId)) return;
    const navigationKey = `${sessionId}:${requestedAgentRequest}:${requestedAgentId}`;
    if (handledAgentNavigation.current === navigationKey) return;
    handledAgentNavigation.current = navigationKey;
    // Insight links are explicit navigation: reset every excluding roster view constraint.
    setFilters(DEFAULT_FILTERS);
    setSelection(requestedAgentId);
    setTreeFocusId(null);
    setTreeReturnsToSheet(false);
    if (requestedAgentGroupId) {
      queueMicrotask(() => {
        setOpenGroups((current) => {
          const next = new Set(current).add(requestedAgentGroupId);
          try { window.localStorage.setItem(`pomegr-agent-roster-open-${sessionId}`, JSON.stringify([...next])); } catch { /* Optional. */ }
          return next;
        });
        setRevealed((current) => new Set(current).add(requestedAgentGroupId));
      });
    }
    onViewModeChange("list");
    try { window.localStorage.setItem(`pomegr-agent-roster-selected-${sessionId}`, requestedAgentId); } catch { /* Optional. */ }
    if (phone) queueMicrotask(() => setPhoneInspectorOpen(true));
  }, [agents, onViewModeChange, phone, requestedAgentGroupId, requestedAgentId, requestedAgentRequest, sessionId]);
  const changeFilters = (next: RosterFilters) => { setFilters(next); try { window.localStorage.setItem(`pomegr-agent-activity-show-finished-${sessionId}`, String(!next.hideFinished)); } catch { /* Optional. */ } };
  const visible = agentsWithFinishedVisibility(agents, !filters.hideFinished).filter((agent) => {
    const statusMatches = filters.status === "all" || (filters.status === "idle" ? ["idle", "waiting", "warm", "needs_input"].includes(agent.status) : agent.status === filters.status);
    return statusMatches && (filters.model === "all" || agent.model === filters.model) && `${agent.label} ${agentAssignment(agent) || ""}`.toLowerCase().includes(filters.search.trim().toLowerCase());
  });
  const visibleIds = new Set(visible.map((agent) => agent.id));
  const treeRows = agentTreeRows(agents);
  const depthById = new Map(treeRows.map(({ agent, depth }) => [agent.id, depth]));
  const sort = (members: Agent[]) => [...members].sort((a, b) => filters.sort === "context" ? b.tokens.total - a.tokens.total : filters.sort === "calls" ? b.toolCalls - a.toolCalls : filters.sort === "wall" ? liveWallTimeMs(b.durationMs, b.startedAt, !historical && ["active", "waiting"].includes(b.status), now) - liveWallTimeMs(a.durationMs, a.startedAt, !historical && ["active", "waiting"].includes(a.status), now) : 0);
  const filteredGroups = groups.map((group) => ({ ...group, agents: sort(group.agents.filter((agent) => visibleIds.has(agent.id))) })).filter((group) => group.agents.length > 0);
  const gridGroups = buildRosterGroups(visible, workflows, { historical, now }).map((group) => ({ ...group, agents: sort(group.agents) }));
  const collapsible = filteredGroups.filter((group) => group.kind !== "primary");
  const allOpen = collapsible.length > 0 && collapsible.every((group) => openGroups.has(group.id) && (group.agents.length <= 8 || revealed.has(group.id)));
  const flat = sort(treeRows.map(({ agent }) => agent).filter((agent) => agent.id !== "primary" && visibleIds.has(agent.id)));
  const shown = filters.grouped ? filteredGroups.reduce((sum, group) => sum + (group.kind === "primary" ? group.agents.length : openGroups.has(group.id) ? Math.min(group.agents.length, revealed.has(group.id) ? Infinity : 8) : 0), 0) : visible.length;
  useEffect(() => {
    if (!selected) return;
    const frame = window.requestAnimationFrame(() => {
      const row = viewMode === "grid" ? tileRefs.current.get(selected) : rowRefs.current.get(selected);
      if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selected, openGroups, revealed, filters.grouped, requestedAgentRequest, viewMode]);
  const select = (id: string) => {
    setSelection(id);
    try { window.localStorage.setItem(`pomegr-agent-roster-selected-${sessionId}`, id); } catch { /* Local preferences are optional. */ }
    if (phone) setPhoneInspectorOpen(true);
    onSelectAgent?.(id);
  };
  const inspectorAgentId = phoneTreeInspectorId && agents.some((agent) => agent.id === phoneTreeInspectorId) ? phoneTreeInspectorId : selected;
  const inspectorSelectedAgent = agents.find((agent) => agent.id === inspectorAgentId) || null;
  const inspectorAgent = inspectorSelectedAgent ? { ...inspectorSelectedAgent, executionTasks: inspectorSelectedAgent.executionTasks || (inspectorSelectedAgent.id === "primary" ? executionTasks : []) } : null;
  const focusAgent = treeFocusId ? agents.find((agent) => agent.id === treeFocusId) || null : null;
  const activeTreeFocusId = focusAgent?.id || null;
  const openTree = (id: string) => {
    treeOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    treeReturnId.current = id;
    if (phone) {
      setSelection(id);
      setPhoneTreeInspectorId(id);
      onSelectAgent?.(id);
      try { window.localStorage.setItem(`pomegr-agent-roster-selected-${sessionId}`, id); } catch { /* Local preferences are optional. */ }
    }
    setTreeReturnsToSheet(phone);
    setPhoneInspectorOpen(false);
    setTreeFocusId(id);
  };
  const restoreTreeOpener = useCallback(() => {
    const returnId = treeReturnId.current || selected;
    const fallback = returnId ? (viewMode === "grid" ? tileRefs.current.get(returnId) : rowRefs.current.get(returnId)?.querySelector<HTMLButtonElement>(".rosterSelectAgent")) : null;
    const target = treeOpener.current?.isConnected ? treeOpener.current : fallback;
    treeOpener.current = null;
    treeReturnId.current = null;
    target?.focus({ preventScroll: true });
  }, [selected, viewMode]);
  const closeTree = useCallback(() => {
    setTreeFocusId(null);
    if (treeReturnsToSheet) setPhoneInspectorOpen(true);
    else queueMicrotask(restoreTreeOpener);
  }, [restoreTreeOpener, treeReturnsToSheet]);
  useEffect(() => {
    if (!treeFocusId || activeTreeFocusId) return;
    // A live update can remove a former agent. Return to the stable roster rather than rendering an unscoped tree.
    const timer = window.setTimeout(() => {
      setTreeFocusId(null);
      if (treeReturnsToSheet) setPhoneInspectorOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTreeFocusId, treeFocusId, treeReturnsToSheet]);
  useEffect(() => {
    if (!activeTreeFocusId || phone) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); closeTree(); } };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [activeTreeFocusId, closeTree, phone]);
  const closePhoneInspector = () => {
    setPhoneInspectorOpen(false);
    if (!treeReturnsToSheet) return;
    setTreeReturnsToSheet(false);
    setPhoneTreeInspectorId(null);
    if (!selected) return;
    queueMicrotask(restoreTreeOpener);
  };
  const tree = <AgentTreeView agents={agents} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} contextBoundaries={contextBoundaries} focusId={activeTreeFocusId} historical={historical} insights={insights} mode="ancestors" requestSnapshots={requestSnapshots} workflows={workflows} sessionId={sessionId} />;
  const row = (agent: Agent) => <RosterRow rowRef={(element) => { if (element) rowRefs.current.set(agent.id, element); else rowRefs.current.delete(agent.id); }} key={agent.id} agent={agent} depth={depthById.get(agent.id) || 0} selected={selected === agent.id} onSelect={select} insights={insights} loops={loops} executionTasks={executionTasks} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} contextBoundaries={contextBoundaries} />;
  return <article className="panel agentsPanel agentRosterPanel" data-session-id={sessionId}>
    {activeTreeFocusId ? <header className="rosterPanelHeader rosterTreePanelHeader"><div><button className="rosterTreeBack" type="button" aria-label="Back to agent activity" onClick={closeTree}>← Agent activity</button><h2>Tree · focused on {agentDisplayName(focusAgent!)}</h2></div></header> : <header className="rosterPanelHeader"><div><h2>Agent activity</h2><span>{agents.length} observed · showing {viewMode === "grid" ? visible.length : shown}</span></div><div className="rosterViewModes" role="group" aria-label="Agent activity view"><button type="button" aria-pressed={viewMode === "list"} onClick={() => onViewModeChange("list")}>List</button><button type="button" aria-pressed={viewMode === "grid"} onClick={() => onViewModeChange("grid")}>Grid</button></div></header>}
    <div className="rosterActivitySurface" hidden={Boolean(activeTreeFocusId)}>
    <RosterDistribution agents={agents} />
    <RosterFilterBar filters={filters} models={[...new Set(agents.map((agent) => agent.model))].sort()} onChange={changeFilters} allowGrouping={viewMode === "list"} />
    {viewMode === "grid" && <AgentGridToolbar metric={gridMetric} historical={historical} onChange={(metric) => { setGridMetric(metric); try { window.localStorage.setItem(`pomegr-agent-grid-metric-${sessionId}`, metric); } catch { /* Optional. */ } }} />}
    <div className="rosterWorkspace"><div className="rosterMain">
      {viewMode === "list" && <div className="rosterColumns sessionEyebrow" aria-hidden="true"><span /><span>Agent</span><span>{historical ? "Final" : "Latest"} context</span><span>Wall time</span><span>Calls</span><span>Cache TTL</span><span>Status</span><span /></div>}
      <div className="rosterScrollFrame"><div className={`rosterRegion ${visibleIds.has("primary") ? "rosterHasPrimary" : ""}`} role="region" aria-label="Agent roster" tabIndex={0}>
        {viewMode === "grid" ? <AgentGridView groups={gridGroups} agents={agents} selectedAgentId={selected} onSelect={select} onOpenTree={openTree} insights={insights} metric={gridMetric} historical={historical} now={now} tileRef={(id, element) => { if (element) tileRefs.current.set(id, element); else tileRefs.current.delete(id); }} /> : <div role="table" aria-label="Session agents">
          {agents.length === 0 ? <EmptyState text="No agents have appeared in this session yet." /> : visible.length === 0 ? <EmptyState text="No agents match these filters." /> : null}
          {filteredGroups.filter((group) => group.kind === "primary").flatMap((group) => group.agents.map(row))}
          {filters.grouped ? collapsible.map((group) => <div className="rosterGroup" key={group.id} data-group-id={group.id}>
            <RosterGroupHeader group={groups.find((item) => item.id === group.id)!} open={openGroups.has(group.id)} onToggle={() => { const next = new Set(openGroups); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); saveOpen(next); }} onOpenTree={openTree} agentsById={new Map(agents.map((agent) => [agent.id, agent]))} />
            {openGroups.has(group.id) && <>{group.agents.slice(0, revealed.has(group.id) ? undefined : 8).map(row)}{group.agents.length > 8 && !revealed.has(group.id) && <button type="button" className="rosterShowMore" onClick={() => setRevealed(new Set(revealed).add(group.id))}>Show {group.agents.length - 8} more in {group.title}</button>}</>}
          </div>) : flat.map(row)}
        </div>}
      </div></div>
      {viewMode === "grid" ? <AgentGridFooter /> : <footer className="rosterFooter"><span>Scroll inside the roster · groups stay pinned</span>{filters.grouped && collapsible.length > 0 && <button type="button" onClick={() => { saveOpen(allOpen ? new Set() : new Set(collapsible.map((group) => group.id))); setRevealed(allOpen ? new Set() : new Set(collapsible.map((group) => group.id))); }}>{allOpen ? "Collapse all" : `Expand all ${visible.length}`}</button>}</footer>}
    </div>{!phone && <aside className="rosterInspectorPlaceholder"><AgentInspector agent={inspectorAgent} agents={agents} workflows={workflows} sessionId={sessionId} historical={historical} requestSnapshots={requestSnapshots || { status: "unavailable", items: [] }} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} contextBoundaries={contextBoundaries} insights={insights} planTasks={planTasks} onOpenTree={openTree} /></aside>}
      {phone && phoneInspectorOpen && <AgentInspector agent={inspectorAgent} agents={agents} workflows={workflows} sessionId={sessionId} historical={historical} requestSnapshots={requestSnapshots || { status: "unavailable", items: [] }} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} contextBoundaries={contextBoundaries} insights={insights} planTasks={planTasks} presentation="sheet" onClose={closePhoneInspector} onOpenTree={openTree} />}
    </div>
    </div>{activeTreeFocusId && (phone
      ? <InspectorSheet title={`Tree · ${agentDisplayName(focusAgent!)}`} subtitle="Focused tree" onClose={closeTree}>{tree}</InspectorSheet>
      : <section className="rosterTreeDrilldown" aria-label="Agent tree">{tree}</section>)}
  </article>;
}
