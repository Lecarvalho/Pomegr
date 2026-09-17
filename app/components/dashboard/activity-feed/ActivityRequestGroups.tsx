"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName } from "../../../dashboard-utils";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import { activityDuration } from "./duration";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { targetBasename } from "./feed-model";
import type { ActivityFeedView } from "./useActivityFeed";

/**
 * Five request groups around the shared selection with nested recorded calls. Only bounded,
 * browser-safe metadata renders here: kind, label, target basename and wall duration.
 */
export function ActivityRequestGroups({ selection, feed, agents, busy }: {
  selection: SessionRequestSelection; feed: ActivityFeedView; agents: Agent[]; busy: boolean;
}) {
  const kindTotal = feed.byKind.reduce((sum, row) => sum + row.count, 0);
  const selectedId = selection.selected?.id ?? null;
  const total = selection.history.total;
  const index = selection.selectedIndex;
  return <section className="panel activityPanel" aria-label="Activity by request" aria-busy={busy || undefined}>
    <header className="activityPanelHeader">
      <div><h2>Activity by request</h2><p>{feed.requestTotal.toLocaleString()} {feed.requestTotal === 1 ? "request" : "requests"} in this scope</p></div>
    </header>
    <div className="activityLayout">
      <div className="activityBreakdown">
        <header><h3 className="sessionEyebrow">Actions by kind</h3><span>count · share · median duration</span></header>
        <div role="group" aria-label="Filter calls by kind">
          {feed.byKind.map(({ kind, count, medianDurationMs }) => <button type="button" key={kind} className="commandQuietAction activityKindRow" aria-pressed={selection.workKind === kind}
            onClick={() => selection.setWorkKind(selection.workKind === kind ? null : kind)}>
            <WorkKindIcon kind={kind} /><span className="activityKindLabel">{WORK_LABELS[kind]}</span>
            <strong>{count.toLocaleString()}</strong><span>{kindTotal ? Math.round(count / kindTotal * 100) : 0}%</span><span>{activityDuration(medianDurationMs)}</span>
          </button>)}
        </div>
        <div className="activityOtherCounts">
          <div><span>Shell tasks</span><strong>{feed.shellTasks.total.toLocaleString()}</strong></div>
          <div className={feed.shellTasks.failed ? "activityFailures" : ""}><span>Failed shell runs</span><strong>{feed.shellTasks.failed.toLocaleString()}</strong></div>
        </div>
        <p>Counts describe recorded tool calls, not effort or quality. Duration is wall time from call to result, including approval waits.</p>
      </div>
      <div className="activityFeed">
        {feed.status === "unavailable" && <p className="activityHistoryError" role="status">
          {feed.groups.length ? "Activity by request could not update. Showing the previous requests." : "Activity by request is unavailable."}{" "}
          <button type="button" className="commandTextLink" onClick={feed.retry}>Retry</button>
        </p>}
        {feed.status === "ready" && !feed.groups.length && <p className="sessionTabState">No requests recorded in this scope.</p>}
        {feed.groups.map((group) => {
          const agent = agents.find((item) => item.id === group.request.agentId);
          const selected = group.request.id === selectedId;
          return <article className="activityTableFrame" key={group.request.number} aria-label={`Request #${group.request.number}`}>
            <button type="button" className={`commandQuietAction activityRow${selected ? " selected" : ""}`} aria-pressed={selected}
              onClick={() => { if (!busy) selection.locate(group.request.id, selection.scope); }} aria-disabled={busy || undefined}>
              <strong>Request #{group.request.number}</strong><span className="actor">{agent ? agentDisplayName(agent) : "Unknown agent"}</span>
              <span>{group.calls.length.toLocaleString()} {group.calls.length === 1 ? "call" : "calls"}{group.continuation ? ` of ${(group.calls.length + group.continuation.remaining).toLocaleString()}` : ""}</span>
            </button>
            {group.noMatchingCalls && <p className="activityLinkNote">{selection.workKind ? `No ${WORK_LABELS[selection.workKind].toLowerCase()} calls for this request.` : "No recorded calls for this request."}</p>}
            {group.calls.length > 0 && <ul className="activityTable">
              {group.calls.map((call) => <li key={call.id} className={`activityRow${call.status === "failed" ? " failed" : ""}`}>
                <span className="activityAction"><WorkKindIcon kind={call.workKind} /><strong>{call.tool}</strong></span>
                <span className="target">{call.detail ? targetBasename(call.detail) : "—"}</span>
                <span className={`activityDuration${call.durationMs === null ? " unavailable" : ""}`}>{activityDuration(call.durationMs)}</span>
              </li>)}
            </ul>}
            {group.continuation && <button type="button" className="commandTextLink" disabled={feed.loadingMore === group.request.number} onClick={() => feed.loadMore(group.request.number)}>
              {feed.loadingMore === group.request.number ? "Loading calls…" : `Show ${group.continuation.remaining.toLocaleString()} more calls`}
            </button>}
          </article>;
        })}
        <footer className="activityPagination">
          <nav aria-label="Request range">
            <button type="button" className="commandSecondaryAction" disabled={index === null || index <= 0} onClick={selection.previousRange}>Previous</button>
            <button type="button" className="commandSecondaryAction" disabled={index === null || index >= total - 1} onClick={selection.nextRange}>Next</button>
            <button type="button" className="commandSecondaryAction" disabled={selection.mode === "follow"} onClick={selection.jumpToLatest}>Jump to latest</button>
          </nav>
        </footer>
      </div>
    </div>
  </section>;
}
