"use client";

import { RepositoryDisclosurePanel } from "./RepositoryDisclosurePanel";
import { ResourceUsagePanel } from "./ResourceUsagePanel";
import { SessionDetailsPanel } from "./SessionDetailsPanel";
import type { SessionTab } from "./session-route";
import { useTransitionalSessionState } from "./useTransitionalSessionState";

type LegacySessionTabProps = { tab: Exclude<SessionTab, "overview" | "agents" | "activities" | "signals">; sessionId: string; historical: boolean; paused: boolean; showEstimatedCost: boolean; onNavigateAgent: (agentId: string) => void };

// Keying the panel on sessionId makes React unmount and remount it on a session change instead of
// reusing the instance, so the polled state and its refs reset to their initial values for free
// (see useTransitionalSessionState).
export function LegacySessionTab(props: LegacySessionTabProps) {
  return <LegacySessionTabPanel key={props.sessionId} {...props} />;
}

function LegacySessionTabPanel({ tab, sessionId, historical, paused, showEstimatedCost }: LegacySessionTabProps) {
  const { state, error } = useTransitionalSessionState({ sessionId, historical, paused });
  const visibleState = state?.session?.id === sessionId ? state : null;
  if (!visibleState) return <div className="sessionTabState">{error ? "This session panel is temporarily unavailable." : `Loading ${tab}…`}</div>;
  const notice = error ? <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded panel state.</div> : null;
  if (tab === "repository" && visibleState.session) return <>{notice}<RepositoryDisclosurePanel session={visibleState.session} historical={historical} /></>;
  if (tab === "resources") return <>{notice}<ResourceUsagePanel resources={visibleState.metrics.resources || undefined} /></>;
  if (tab === "details") return <>{notice}<SessionDetailsPanel state={visibleState} historical={historical} showEstimatedCost={showEstimatedCost} /></>;
  return null;
}
