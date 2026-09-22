"use client";

import { RepositoryDisclosurePanel } from "./RepositoryDisclosurePanel";
import { ResourceUsagePanel } from "./ResourceUsagePanel";
import { SessionDetailsPanel } from "./SessionDetailsPanel";
import type { SessionTab } from "./session-route";
import { TransitionalSessionPanel } from "./TransitionalSessionPanel";

type LegacySessionTabProps = { tab: Exclude<SessionTab, "overview" | "agents" | "activities" | "signals">; sessionId: string; historical: boolean; paused: boolean; showEstimatedCost: boolean };

export function LegacySessionTab({ tab, sessionId, historical, paused, showEstimatedCost }: LegacySessionTabProps) {
  return <TransitionalSessionPanel sessionId={sessionId} historical={historical} paused={paused} loadingLabel={tab}>
    {(state) => {
      if (tab === "repository" && state.session) return <RepositoryDisclosurePanel session={state.session} historical={historical} />;
      if (tab === "resources") return <ResourceUsagePanel resources={state.metrics.resources || undefined} />;
      if (tab === "details") return <SessionDetailsPanel state={state} historical={historical} showEstimatedCost={showEstimatedCost} />;
      return null;
    }}
  </TransitionalSessionPanel>;
}
