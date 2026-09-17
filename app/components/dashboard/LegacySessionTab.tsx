"use client";

import type { MonitorState } from "../../../shared/monitor-contract";
import { RepositoryDisclosurePanel } from "./RepositoryDisclosurePanel";
import { ResourceUsagePanel } from "./ResourceUsagePanel";
import { SessionDetailsPanel } from "./SessionDetailsPanel";
import { CacheEvidenceDisclosure } from "./CacheEvidenceDisclosure";
import { InsightsPanel } from "./InsightsPanel";
import { useSessionRequestSelection } from "./requests-actions/useSessionRequestSelection";
import type { SessionTab } from "./session-route";
import { useTransitionalSessionState } from "./useTransitionalSessionState";

type LegacySessionTabProps = { tab: Exclude<SessionTab, "overview" | "agents" | "activities">; sessionId: string; historical: boolean; paused: boolean; showEstimatedCost: boolean; onNavigateAgent: (agentId: string) => void };

// Keying the panel on sessionId makes React unmount and remount it on a session change instead of
// reusing the instance, so the polled state and its refs reset to their initial values for free
// (see useTransitionalSessionState).
export function LegacySessionTab(props: LegacySessionTabProps) {
  return <LegacySessionTabPanel key={props.sessionId} {...props} />;
}

function LegacySessionTabPanel({ tab, sessionId, historical, paused, showEstimatedCost, onNavigateAgent }: LegacySessionTabProps) {
  const { state, error } = useTransitionalSessionState({ sessionId, historical, paused });
  const visibleState = state?.session?.id === sessionId ? state : null;
  if (!visibleState) return <div className="sessionTabState">{error ? "This session panel is temporarily unavailable." : `Loading ${tab}…`}</div>;
  const notice = error ? <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded panel state.</div> : null;
  if (tab === "signals") return <>{notice}<LegacySignals state={visibleState} historical={historical} paused={paused} onNavigateAgent={onNavigateAgent} /></>;
  if (tab === "repository" && visibleState.session) return <>{notice}<RepositoryDisclosurePanel session={visibleState.session} historical={historical} /></>;
  if (tab === "resources") return <>{notice}<ResourceUsagePanel resources={visibleState.metrics.resources || undefined} /></>;
  if (tab === "details") return <>{notice}<SessionDetailsPanel state={visibleState} historical={historical} showEstimatedCost={showEstimatedCost} /></>;
  return null;
}

function LegacySignals({ state, historical, paused, onNavigateAgent }: { state: MonitorState; historical: boolean; paused: boolean; onNavigateAgent: (agentId: string) => void }) {
  const selection = useSessionRequestSelection({
    historyEnabled: !paused, sessionId: state.session?.id, agents: state.agents,
    requestSnapshots: state.metrics.tokens.requestSnapshots,
    contextBoundaries: state.metrics.tokens.contextHistory.boundaries,
    historical, cacheEvents: state.metrics.tokens.cacheEvents, cacheReadDrops: state.metrics.tokens.cacheReadDrops,
  });
  return <div className="sessionLegacyStack">
    <InsightsPanel insights={state.insights} onShowAgent={onNavigateAgent} />
    <CacheEvidenceDisclosure agents={state.agents} cacheEvents={state.metrics.tokens.cacheEvents} requestSnapshots={state.metrics.tokens.requestSnapshots} cacheWriteAvailable={state.capabilities.cacheWriteUsage} historical={historical} selectedSnapshot={selection.selected} onSelectSnapshot={(snapshot) => selection.locate(snapshot.id)} />
  </div>;
}
