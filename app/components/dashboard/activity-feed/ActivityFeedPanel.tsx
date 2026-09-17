"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { ActivityKindRail } from "./ActivityKindRail";
import { ActivityRequestList } from "./ActivityRequestList";
import type { ActivityFeedView } from "./useActivityFeed";

/** One activity feed grouped by request: a left rail of kind/shell aggregates and the request list. */
export function ActivityFeedPanel({ selection, feed, agents, busy, cacheWriteAvailable, onOpenAgent, onSelectRequest }: {
  selection: SessionRequestSelection; feed: ActivityFeedView; agents: Agent[]; busy: boolean;
  cacheWriteAvailable: boolean; onOpenAgent: (agentId: string) => void;
  /** Reports the request number a group line selected, so the tab can hold the shown window still. */
  onSelectRequest?: (requestNumber: number) => void;
}) {
  // A body exists once the feed has ever answered (even with zero groups) or retains prior groups
  // through a revalidation. Anything else — the chart's own first page still loading or failed
  // (preview), or the feed's own first query still loading, idle or failed — has no real counts to
  // show yet, so request total, shell counts and paging must not render invented zeros next to them.
  const hasBody = feed.status === "ready" || feed.groups.length > 0;
  if (!hasBody) {
    const chartUnavailable = selection.history.preview && selection.history.status === "unavailable";
    const feedUnavailable = !selection.history.preview && feed.status === "unavailable";
    return <section className="panel activityPanel" aria-label="Activity feed" aria-busy="true">
      <header className="activityPanelHeader"><div><h2>Activity feed</h2></div></header>
      {feedUnavailable
        ? <p className="activityHistoryError" role="status">Activity feed is unavailable. <button type="button" className="commandTextLink" onClick={feed.retry}>Retry</button></p>
        : <p className="sessionTabState" role="status">{chartUnavailable ? "Activity history is unavailable; retrying…" : "Loading activity…"}</p>}
    </section>;
  }
  // Phone reads the request groups first and keeps the kind and shell aggregates below them; the
  // desktop rail keeps its leading 360px column. Same components, same props, one order decision.
  const rail = <ActivityKindRail feed={feed} selection={selection} />;
  const list = <ActivityRequestList selection={selection} feed={feed} agents={agents} busy={busy} cacheWriteAvailable={cacheWriteAvailable} onOpenAgent={onOpenAgent} onSelectRequest={onSelectRequest} />;
  return <section className="panel activityPanel" aria-label="Activity feed" aria-busy={busy || undefined}>
    <header className="activityPanelHeader">
      <div><h2>Activity feed</h2><p>{feed.requestTotal.toLocaleString()} {feed.requestTotal === 1 ? "request" : "requests"} in this scope</p></div>
    </header>
    <div className={`activityLayout${selection.phone ? " isPhone" : ""}`}>{selection.phone ? <>{list}{rail}</> : <>{rail}{list}</>}</div>
  </section>;
}
