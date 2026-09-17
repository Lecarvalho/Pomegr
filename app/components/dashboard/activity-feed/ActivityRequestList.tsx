"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { HistoryRequest } from "../../../../shared/session-history-contract";
import { agentDisplayName } from "../../../dashboard-utils";
import { DottedInfoPopover } from "../../DottedInfoPopover";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { activityDuration } from "./duration";
import { targetBasename } from "./feed-model";
import type { ActivityFeedView } from "./useActivityFeed";

/**
 * A group's own request record already carries request-local counts (monitor-validated, never a
 * chart-page lookup), so every group can show them regardless of the 60-request chart window. Still
 * defensive: the grouped index only validates id/number/agentId, not these fields, so an
 * incomplete or non-numeric record renders no counts rather than a fabricated or partial one.
 */
function requestTokens(request: HistoryRequest, cacheWriteAvailable: boolean) {
  const { uncachedInputTokens, cacheWriteTokens, outputTokens } = request;
  if (!Number.isSafeInteger(uncachedInputTokens) || uncachedInputTokens < 0) return null;
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) return null;
  if (cacheWriteAvailable && (!Number.isSafeInteger(cacheWriteTokens) || cacheWriteTokens < 0)) return null;
  return { uncachedInputTokens, cacheWriteTokens, outputTokens };
}

/**
 * Right side of the Activity feed: request groups with nested recorded calls. Only bounded,
 * browser-safe metadata renders here: kind, label, target basename and wall duration.
 */
export function ActivityRequestList({ selection, feed, agents, busy, cacheWriteAvailable, onOpenAgent }: {
  selection: SessionRequestSelection; feed: ActivityFeedView; agents: Agent[]; busy: boolean;
  cacheWriteAvailable: boolean; onOpenAgent: (agentId: string) => void;
}) {
  const selectedId = selection.selected?.id ?? null;
  const total = selection.history.total;
  const index = selection.selectedIndex;
  return <div className="activityFeed">
    {feed.status === "unavailable" && <p className="activityHistoryError" role="status">
      {feed.groups.length ? "Activity feed could not update. Showing the previous requests." : "Activity feed is unavailable."}{" "}
      <button type="button" className="commandTextLink" onClick={feed.retry}>Retry</button>
    </p>}
    {feed.status === "ready" && !feed.groups.length && <p className="sessionTabState">No requests recorded in this scope.</p>}
    {feed.groups.map((group) => {
      const agent = agents.find((item) => item.id === group.request.agentId);
      const selected = group.request.id === selectedId;
      const tokens = requestTokens(group.request, cacheWriteAvailable);
      const callsText = `${group.calls.length.toLocaleString()} ${group.calls.length === 1 ? "call" : "calls"}${group.continuation ? ` of ${(group.calls.length + group.continuation.remaining).toLocaleString()}` : ""}`;
      const ariaLabel = tokens ? `Request #${group.request.number}, uncached input ${tokens.uncachedInputTokens.toLocaleString()}`
        + `${cacheWriteAvailable ? `, cache write ${tokens.cacheWriteTokens.toLocaleString()}` : ""}, output ${tokens.outputTokens.toLocaleString()}, ${callsText}` : undefined;
      return <article className="activityTableFrame" key={group.request.number} aria-label={`Request #${group.request.number}`}>
        <button type="button" className={`commandQuietAction activityRow${selected ? " selected" : ""}`} aria-pressed={selected} aria-label={ariaLabel}
          onClick={() => { if (!busy) selection.locate(group.request.id, selection.scope); }} aria-disabled={busy || undefined}>
          <strong>Request #{group.request.number}</strong>{" "}
          {tokens && <><span className="activityRequestTokens">
            <i className="requestsActionsSwatch uncached" />{tokens.uncachedInputTokens.toLocaleString()}{" "}
            {cacheWriteAvailable && <><i className="requestsActionsSwatch write" />{tokens.cacheWriteTokens.toLocaleString()}{" "}</>}
            <i className="requestsActionsSwatch output" />{tokens.outputTokens.toLocaleString()}
          </span>{" "}</>}
          <span>{callsText}</span>
        </button>
        {agent
          ? <button type="button" className="commandTextLink" onClick={() => onOpenAgent(group.request.agentId)}>{agentDisplayName(agent)}</button>
          : "Unknown agent"}
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
    <p><DottedInfoPopover ariaLabel="About request rows" content="Each request's uncached input, cache write and output are request-local and never summed across requests. Tool calls nest under their request with wall duration. Targets show Bash descriptions and file names only.">Local counts only.</DottedInfoPopover></p>
  </div>;
}
