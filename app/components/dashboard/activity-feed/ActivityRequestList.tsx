"use client";

import type { Agent } from "../../../../shared/monitor-contract";
import type { HistoryRequest } from "../../../../shared/session-history-contract";
import { agentDisplayName, agentRoleLabel, compactNumber, shortTime } from "../../../dashboard-utils";
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

/** Artboard copy for the phone caveat: what each line holds and what it never prints. */
const PHONE_HOW_TO_READ = <>
  Request line: agent, role, uncached input, time. Tap it for the four request-local counts.<br />
  Call line: kind icon, target, wall duration. Tap it for kind, status, exit code and times.<br />
  Icons match Actions by kind below. Failed or running calls tint only the duration text.<br />
  Targets are Bash descriptions and file basenames only. Counts are never summed.
</>;

/**
 * Right side of the Activity feed: request groups with nested recorded calls. Only bounded,
 * browser-safe metadata renders here: kind, label, target basename and wall duration.
 */
export function ActivityRequestList({ selection, feed, agents, busy, cacheWriteAvailable, onOpenAgent, onSelectRequest }: {
  selection: SessionRequestSelection; feed: ActivityFeedView; agents: Agent[]; busy: boolean;
  cacheWriteAvailable: boolean; onOpenAgent: (agentId: string) => void; onSelectRequest?: (requestNumber: number) => void;
}) {
  const selectedId = selection.selected?.id ?? null;
  const total = selection.history.total;
  const index = selection.selectedIndex;
  const phone = selection.phone;
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
      const agentName = agent ? agentDisplayName(agent) : "Unknown agent";
      const roleLabel = agent ? agentRoleLabel(agent) : "unreported";
      // The phone line carries the agent itself, so it also answers "which request is this" without
      // the separate agent link a desktop group keeps below its row.
      const phoneLabel = `Request #${group.request.number}, ${agentName}, ${roleLabel}`
        + `${tokens ? `, uncached input ${tokens.uncachedInputTokens.toLocaleString()}` : ""}, ${shortTime(group.request.observedAt)}, ${callsText}`;
      return <article className={`activityTableFrame${selected ? " isSelectedRequest" : ""}`} key={group.request.number} data-request={group.request.number} aria-label={`Request #${group.request.number}`}>
        <button type="button" className={`commandQuietAction activityRow${phone ? " activityRequestLine" : ""}${selected ? " selected" : ""}`} aria-pressed={selected}
          aria-label={phone ? phoneLabel : ariaLabel}
          onClick={() => { if (busy) return; onSelectRequest?.(group.request.number); selection.locate(group.request.id, selection.scope); }} aria-disabled={busy || undefined}>
          {phone
            ? <>
              <span className="requestsActionsNumber">#{group.request.number}</span>
              <span className="activityRequestWho"><strong>{agentName}</strong> <span>{roleLabel}</span></span>
              <span className="activityRequestMeta">{tokens ? `${compactNumber(tokens.uncachedInputTokens)} in · ` : ""}<time dateTime={group.request.observedAt}>{shortTime(group.request.observedAt)}</time></span>
            </>
            : <>
              <strong>Request #{group.request.number}</strong>{" "}
              {tokens && <><span className="activityRequestTokens">
                <i className="requestsActionsSwatch uncached" />{tokens.uncachedInputTokens.toLocaleString()}{" "}
                {cacheWriteAvailable && <><i className="requestsActionsSwatch write" />{tokens.cacheWriteTokens.toLocaleString()}{" "}</>}
                <i className="requestsActionsSwatch output" />{tokens.outputTokens.toLocaleString()}
              </span>{" "}</>}
              <span>{callsText}</span>
            </>}
        </button>
        {!phone && (agent
          ? <button type="button" className="commandTextLink" onClick={() => onOpenAgent(group.request.agentId)}>{agentDisplayName(agent)}</button>
          : "Unknown agent")}
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
    {phone
      ? <p className="activityFeedCaveat">Requests with their tool calls · tap a call for details · <DottedInfoPopover ariaLabel="How to read this feed" content={PHONE_HOW_TO_READ}>how to read this</DottedInfoPopover></p>
      : <p><DottedInfoPopover ariaLabel="About request rows" content="Each request's uncached input, cache write and output are request-local and never summed across requests. Tool calls nest under their request with wall duration. Targets show Bash descriptions and file names only.">Local counts only.</DottedInfoPopover></p>}
  </div>;
}
