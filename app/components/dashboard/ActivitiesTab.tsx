"use client";

import type { MonitorState } from "../../../shared/monitor-contract";
import { ActivityFeedPanel } from "./activity-feed/ActivityFeedPanel";
import { useActivityFeed } from "./activity-feed/useActivityFeed";
import { RequestsActionsPanel } from "./RequestsActionsPanel";
import { useSessionRequestSelection, type RequestSelectionRoute } from "./requests-actions/useSessionRequestSelection";
import { useTransitionalSessionState } from "./useTransitionalSessionState";

type ActivitiesTabProps = {
  sessionId: string; historical: boolean; paused: boolean;
  route: RequestSelectionRoute; onRouteChange: (next: RequestSelectionRoute) => void;
  onOpenAgent: (agentId: string) => void;
};

// Keyed on sessionId so a session change remounts the polled state, selection and feed.
export function ActivitiesTab(props: ActivitiesTabProps) {
  return <ActivitiesTabPanel key={props.sessionId} {...props} />;
}

function ActivitiesTabPanel({ sessionId, historical, paused, route, onRouteChange, onOpenAgent }: ActivitiesTabProps) {
  const { state, error } = useTransitionalSessionState({ sessionId, historical, paused });
  const visibleState = state?.session?.id === sessionId ? state : null;
  if (!visibleState) return <div className="sessionTabState">{error ? "This session panel is temporarily unavailable." : "Loading activities…"}</div>;
  return <>
    {error && <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded panel state.</div>}
    <ActivitiesContent state={visibleState} historical={historical} paused={paused} route={route} onRouteChange={onRouteChange} onOpenAgent={onOpenAgent} />
  </>;
}

/** One shared selection drives the chart, request details and the grouped feed; agent scope applies to all. */
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
  const feed = useActivityFeed({
    enabled: selection.history.enabled && !selection.history.preview && Boolean(historyRevision),
    query: { sessionId: state.session?.id ?? "", scope: selection.historyScope, selected: selection.selectedNumber, workKind: selection.workKind },
    historyRevision,
  });
  if (!state.session) return <div className="sessionTabState">Activity evidence is unavailable.</div>;
  return <div className="sessionLegacyStack">
    <RequestsActionsPanel agents={state.agents} requestSnapshots={tokens.requestSnapshots} contextBoundaries={tokens.contextHistory.boundaries} cacheWriteAvailable={state.capabilities.cacheWriteUsage} historical={historical} cacheEvents={tokens.cacheEvents} cacheReadDrops={tokens.cacheReadDrops} selection={selection} />
    {selection.history.enabled
      ? <ActivityFeedPanel selection={selection} feed={feed} agents={state.agents} busy={!feed.correlated || selection.pending} cacheWriteAvailable={state.capabilities.cacheWriteUsage} onOpenAgent={onOpenAgent} />
      // Paused desktop sessions stop polling the paged history endpoint: an honest unavailable
      // state replaces the feed instead of silently rendering nothing (the deleted ActivityPanel
      // was the only surface that still worked in this state, off its own local activity prop).
      : <section className="panel activityPanel" aria-label="Activity feed"><p className="sessionTabState">Activity history is unavailable while this session view is paused.</p></section>}
  </div>;
}
