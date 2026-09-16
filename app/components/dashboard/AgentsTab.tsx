"use client";

import { useEffect, useState } from "react";
import type { SessionSummaryDomain } from "../../../shared/session-domain-contract";
import { useSessionDomain } from "../../session-domain-store";
import { AgentActivityPanel, type AgentActivityViewMode } from "./AgentActivityPanel";

function storedAgentActivityViewMode(sessionId: string | null): AgentActivityViewMode {
  if (!sessionId || typeof window === "undefined") return "list";
  try {
    return window.localStorage.getItem(`pomegr-agent-activity-view-${sessionId}`) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export type AgentsTabProps = {
  sessionId: string;
  historical: boolean;
  summary: SessionSummaryDomain;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string | null) => void;
  onOpenActivities: (selection: { agentId?: string; request?: string }) => void;
  /** Desktop pause halts both mounted domain subscriptions but keeps their committed entries visible. */
  paused?: boolean;
};

/** Stable T05 mount point. T04 keeps this bounded to the agents domain. */
export function AgentsTab({ sessionId, historical, selectedAgentId, onSelectAgent, onOpenActivities, paused = false }: AgentsTabProps) {
  const [viewPreference, setViewPreference] = useState<{ sessionId: string | null; viewMode: AgentActivityViewMode }>(
    () => ({ sessionId, viewMode: storedAgentActivityViewMode(sessionId) }),
  );
  const viewMode = viewPreference.sessionId === sessionId ? viewPreference.viewMode : storedAgentActivityViewMode(sessionId);
  const changeViewMode = (mode: AgentActivityViewMode) => {
    setViewPreference({ sessionId, viewMode: mode });
    try {
      window.localStorage.setItem(`pomegr-agent-activity-view-${sessionId}`, mode);
    } catch {
      // The in-memory controlled state remains usable when preferences are unavailable.
    }
  };
  const result = useSessionDomain({ sessionId, domain: "agents" }, { historical, enabled: !paused });
  // The store may expose its bounded loading envelope before the agents payload is ready.
  const agents = Array.isArray(result.data?.agents) ? result.data.agents : [];
  const defaultAgentId = agents.find((agent) => agent.id === "primary")?.id || agents[0]?.id || null;
  const selectedAgentIsKnown = Boolean(selectedAgentId && agents.some((agent) => agent.id === selectedAgentId));
  const inspectorAgentId = selectedAgentIsKnown ? selectedAgentId : defaultAgentId;
  useEffect(() => {
    if (selectedAgentId && agents.length > 0 && !selectedAgentIsKnown) onSelectAgent(null);
  }, [agents.length, onSelectAgent, selectedAgentId, selectedAgentIsKnown]);
  const inspector = useSessionDomain(
    { sessionId, domain: "agent", agentId: inspectorAgentId || "" },
    { historical, enabled: !paused && Boolean(inspectorAgentId) },
  );
  if (!result.data || result.data.readiness === "loading") return <div className="sessionTabState" role="status">Loading agent evidence…</div>;
  if (result.data.readiness === "unavailable") return <div className="sessionTabState">Agent evidence is unavailable for this session.</div>;
  if (agents.length === 0) return <div className="sessionTabState">No agents were recorded for this session.</div>;
  const agentEvidence = inspector.data?.readiness === "ready" ? inspector.data : null;
  return <AgentActivityPanel
    agents={agents}
    workflows={result.data.workflows}
    executionTasks={[]}
    planTasks={[]}
    historical={historical}
    sessionId={sessionId}
    selectedAgentId={selectedAgentId}
    onSelectAgent={(agentId) => onSelectAgent(agentId === selectedAgentId ? null : agentId)}
    inspector={agentEvidence}
    onOpenActivities={(agentId) => onOpenActivities({ agentId })}
    viewMode={viewMode}
    onViewModeChange={changeViewMode}
  />;
}
