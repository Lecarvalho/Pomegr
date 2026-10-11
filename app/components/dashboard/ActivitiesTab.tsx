"use client";

import { useState } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { ActivityFeedPanel } from "./activity-feed/ActivityFeedPanel";
import { useActivityFeed } from "./activity-feed/useActivityFeed";
import { RequestsActionsPanel } from "./RequestsActionsPanel";
import { useSessionRequestSelection, type RequestSelectionRoute } from "./requests-actions/useSessionRequestSelection";
import { TransitionalSessionPanel } from "./TransitionalSessionPanel";

type ActivitiesTabProps = {
  sessionId: string; historical: boolean; paused: boolean;
  route: RequestSelectionRoute; onRouteChange: (next: RequestSelectionRoute) => void;
  onOpenAgent: (agentId: string) => void;
};

// The panel is keyed on sessionId, so a session change also remounts the selection and feed.
export function ActivitiesTab({ sessionId, historical, paused, route, onRouteChange, onOpenAgent }: ActivitiesTabProps) {
  return <TransitionalSessionPanel sessionId={sessionId} historical={historical} paused={paused} loadingLabel="activities">
    {(state) => <ActivitiesContent state={state} historical={historical} paused={paused} route={route} onRouteChange={onRouteChange} onOpenAgent={onOpenAgent} />}
  </TransitionalSessionPanel>;
}

function ActivitiesContent({ state, historical, paused, route, onRouteChange, onOpenAgent }: {
  state: MonitorState; historical: boolean; paused: boolean; route: RequestSelectionRoute;
  onRouteChange: (next: RequestSelectionRoute) => void; onOpenAgent: (agentId: string) => void;
}) {
  const tokens = state.metrics.tokens;
  const selection = useSessionRequestSelection({
    historyEnabled: !paused, sessionId: state.session?.id, agents: state.agents,
    requestSnapshots: tokens.requestSnapshots, contextBoundaries: tokens.contextHistory.boundaries,
    historical, cacheEvents: tokens.cacheEvents, cacheReadDrops: tokens.cacheReadDrops, route, onRouteChange,
  });
  const historyRevision = selection.history.revision;
  const [tappedRequest, setTappedRequest] = useState<number | null>(null);
  const [feedWindow, setFeedWindow] = useState<{ selected: number | null; anchor: number | null }>({ selected: selection.selectedNumber, anchor: null });
  const selectedNumber = selection.selectedNumber;
  let feedAnchor = feedWindow.anchor;
  if (selectedNumber !== null && feedWindow.selected !== selectedNumber) {
    feedAnchor = tappedRequest === selectedNumber ? feedWindow.anchor ?? feedWindow.selected : null;
    setFeedWindow({ selected: selectedNumber, anchor: feedAnchor });
    if (tappedRequest !== null) setTappedRequest(null);
  }
  const feed = useActivityFeed({
    enabled: selection.history.enabled && !selection.history.preview && Boolean(historyRevision),
    query: { sessionId: state.session?.id ?? "", scope: selection.historyScope, selected: feedAnchor ?? selectedNumber },
    historyRevision,
  });
  if (!state.session) return <div className="sessionTabState">Activity evidence is unavailable.</div>;
  return <div className="sessionLegacyStack">
    <RequestsActionsPanel agents={state.agents} workflows={state.workflows} requestSnapshots={tokens.requestSnapshots} contextBoundaries={tokens.contextHistory.boundaries} cacheWriteAvailable={state.capabilities.cacheWriteUsage} historical={historical} cacheEvents={tokens.cacheEvents} cacheReadDrops={tokens.cacheReadDrops} selection={selection} />
    {selection.history.enabled
      ? <ActivityFeedPanel selection={selection} feed={feed} agents={state.agents} busy={!feed.correlated || selection.pending} cacheWriteAvailable={state.capabilities.cacheWriteUsage} onOpenAgent={onOpenAgent} onSelectRequest={setTappedRequest} />
      : <section className="panel activityPanel" aria-label="Activity feed"><p className="sessionTabState">Activity history is unavailable while this session view is paused.</p></section>}
  </div>;
}
