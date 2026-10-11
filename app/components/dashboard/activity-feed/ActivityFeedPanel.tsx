"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { useStableHistoryStatus } from "../requests-actions/useStableHistoryStatus";
import { ActivityKindRail } from "./ActivityKindRail";
import { ActivityRequestList } from "./ActivityRequestList";
import { ActivityUnassociatedSection } from "./ActivityUnassociatedSection";
import type { ActivityFeedView } from "./useActivityFeed";

export function ActivityFeedPanel({ selection, feed, agents, busy, cacheWriteAvailable, onOpenAgent, onSelectRequest }: {
  selection: SessionRequestSelection; feed: ActivityFeedView; agents: Agent[]; busy: boolean;
  cacheWriteAvailable: boolean; onOpenAgent: (agentId: string) => void;
  onSelectRequest?: (requestNumber: number) => void;
}) {
  const historyStatus = useStableHistoryStatus(selection.history.status);
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
  const scopedAgents = selection.scope === "all" ? agents : agents.filter((candidate) => candidate.id === selection.scope);
  const tasks = scopedAgents.flatMap((candidate) => candidate.executionTasks || []);
  const selectedGroup = feed.groups.find((group) => group.request.id === selection.selected?.id);
  const selectedKinds = new Set(selectedGroup?.calls.map((call) => call.workKind) ?? []);
  if (selectedGroup?.request.issuedAssociation === "recorded_link") {
    for (const row of selectedGroup.request.issuedWork ?? []) {
      if (row.count > 0) selectedKinds.add(row.kind);
    }
  }
  const rail = <ActivityKindRail feed={feed} tasks={tasks} selectedKinds={selectedKinds} />;
  const list = <div className="activityFeedColumn">
    <ActivityRequestList selection={selection} feed={feed} agents={agents} busy={busy} cacheWriteAvailable={cacheWriteAvailable} onOpenAgent={onOpenAgent} onSelectRequest={onSelectRequest} />
    <ActivityUnassociatedSection unassociated={feed.unassociated} agents={agents} busy={busy} />
  </div>;
  return <section className="panel activityPanel" aria-label="Activity feed" aria-busy={busy || undefined}>
    <header className="activityPanelHeader">
      <div><h2>Activity feed</h2><p>{[
        `${scopeCalls.toLocaleString()} ${scopeCalls === 1 ? "tool call" : "tool calls"} in this scope`,
        // Omitted while the selection follows the newest request without a stable number.
        selection.selectedNumber === null ? null : `request #${selection.selectedNumber} selected`,
        "oldest first",
      ].filter(Boolean).join(" · ")}</p></div>
    </header>
    <div className={`activityLayout${selection.phone ? " isPhone" : ""}`}>{selection.phone ? <>{list}{rail}</> : <>{rail}{list}</>}</div>
  </section>;
}
