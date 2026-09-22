"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { useStableHistoryStatus } from "../requests-actions/useStableHistoryStatus";
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
  const historyStatus = useStableHistoryStatus(selection.history.status);
  // A body exists once the feed has ever answered (even with zero groups) or retains prior groups
  // through a revalidation. Anything else — the chart's own first page still loading or failed
  // (preview), or the feed's own first query still loading, idle or failed — has no real counts to
  // show yet, so request total, shell counts and paging must not render invented zeros next to them.
  const hasBody = feed.status === "ready" || feed.groups.length > 0;
  if (!hasBody) {
    const chartUnavailable = selection.history.preview && historyStatus === "unavailable";
    const feedUnavailable = !selection.history.preview && feed.status === "unavailable";
    return <section className="panel activityPanel" aria-label="Activity feed" aria-busy="true">
      <header className="activityPanelHeader"><div><h2>Activity feed</h2></div></header>
      {feedUnavailable
        ? <p className="activityHistoryError" role="status">Activity feed is unavailable. <button type="button" className="commandTextLink" onClick={feed.retry}>Retry</button></p>
        : <p className="sessionTabState" role="status">{chartUnavailable ? "Activity history is unavailable; retrying…" : "Loading activity…"}</p>}
    </section>;
  }
  const scopeCalls = feed.byKind.reduce((sum, row) => sum + row.count, 0);
  // Task rows describe the agent scope the feed itself is reading, so an agent selection narrows
  // them with everything else. Their fields are already the bounded browser-safe ones.
  const scopedAgents = selection.scope === "all" ? agents : agents.filter((candidate) => candidate.id === selection.scope);
  const tasks = scopedAgents.flatMap((candidate) => candidate.executionTasks || []);
  // Phone reads the request groups first and keeps the kind and shell aggregates below them; the
  // desktop rail keeps its leading 360px column. Same components, same props, one order decision.
  const rail = <ActivityKindRail feed={feed} tasks={tasks} />;
  const list = <ActivityRequestList selection={selection} feed={feed} agents={agents} busy={busy} cacheWriteAvailable={cacheWriteAvailable} onOpenAgent={onOpenAgent} onSelectRequest={onSelectRequest} />;
  return <section className="panel activityPanel" aria-label="Activity feed" aria-busy={busy || undefined}>
    <header className="activityPanelHeader">
      <div><h2>Activity feed</h2><p>{[
        // The scope total is the kind aggregate, which counts every recorded call in the agent
        // scope. `callTotal` counts only the five served groups, so it cannot carry "in this scope".
        `${scopeCalls.toLocaleString()} ${scopeCalls === 1 ? "tool call" : "tool calls"} in this scope`,
        // Omitted while the selection follows the newest request without a stable number.
        selection.selectedNumber === null ? null : `request #${selection.selectedNumber} selected`,
        "oldest first",
      ].filter(Boolean).join(" · ")}</p></div>
    </header>
    <div className={`activityLayout${selection.phone ? " isPhone" : ""}`}>{selection.phone ? <>{list}{rail}</> : <>{rail}{list}</>}</div>
  </section>;
}
