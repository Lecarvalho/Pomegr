"use client";

import { useState } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import type { HistoryRequest } from "../../../../shared/session-history-contract";
import { agentDisplayName, agentRoleLabel, compactNumber, shortTime } from "../../../dashboard-utils";
import { DottedInfoPopover } from "../../DottedInfoPopover";
import { WorkKindIcon } from "../../WorkKindIcon";
import { WORK_LABELS } from "../../agents/agent-presentation";
import type { SessionRequestSelection } from "../requests-actions/useSessionRequestSelection";
import { ActivityCallLine } from "./ActivityCallLine";
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
 * The feed's five served headers and the chart are independently sized. Both carry stable request
 * numbers once history has loaded, so their footer labels can be precise without turning chart
 * positions or preview ordinals into request numbers.
 */
function requestRangeLabel(selection: SessionRequestSelection, feed: ActivityFeedView) {
  const clauses: string[] = [];
  const firstServed = feed.groups[0]?.request.number;
  const lastServed = feed.groups.at(-1)?.request.number;
  if (typeof firstServed === "number" && typeof lastServed === "number" && firstServed > 0 && lastServed >= firstServed) {
    clauses.push(firstServed === lastServed ? `#${firstServed}` : `#${firstServed}–#${lastServed}`);
  }
  const chartRows = selection.rows.slice(selection.start - 1, selection.end);
  const first = chartRows.find((row) => typeof row.number === "number")?.number;
  // Keep this compatible with the dashboard's browser baseline, which predates Array#findLast.
  const last = [...chartRows].reverse().find((row) => typeof row.number === "number")?.number;
  if (!selection.history.preview && selection.history.status === "ready" && typeof first === "number" && typeof last === "number") {
    clauses.push(first === last ? `window #${first}` : `window #${first}–#${last}`);
  }
  return clauses.join(" · ");
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
  const rangeLabel = requestRangeLabel(selection, feed);
  // One phone call is open at a time, held here rather than per line so opening one closes the
  // other. It is view state only: no URL parameter, no sheet, no scroll lock.
  const [openCall, setOpenCall] = useState<string | null>(null);
  return <div className="activityFeed" onKeyDown={(event) => { if (event.key === "Escape" && openCall) setOpenCall(null); }}>
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
      const agentName = agent ? agentDisplayName(agent) : "Unknown agent";
      const roleLabel = agent ? agentRoleLabel(agent) : "unreported";
      const selectRequest = () => { if (busy) return; onSelectRequest?.(group.request.number); selection.locate(group.request.id, selection.scope); };
      // Both lines name their agent, so both labels open with the identity the row shows. The
      // counts stay request-local and are never summed across requests or agents.
      const countsLabel = tokens ? `, uncached input ${tokens.uncachedInputTokens.toLocaleString()}`
        + `${cacheWriteAvailable ? `, cache write ${tokens.cacheWriteTokens.toLocaleString()}` : ""}, output ${tokens.outputTokens.toLocaleString()}` : "";
      const ariaLabel = `Request #${group.request.number}, ${agentName}, ${roleLabel}${countsLabel}, ${callsText}`;
      // The phone line has no room for the counts the desktop label spells out, so it names the
      // agent, the uncached input and the time instead.
      const phoneLabel = `Request #${group.request.number}, ${agentName}, ${roleLabel}`
        + `${tokens ? `, uncached input ${tokens.uncachedInputTokens.toLocaleString()}` : ""}, ${shortTime(group.request.observedAt)}, ${callsText}`;
      return <article className={`activityTableFrame${selected ? " isSelectedRequest" : ""}`} key={group.request.number} data-request={group.request.number} aria-label={`Request #${group.request.number}`}>
        {phone
          ? <button type="button" className={`commandQuietAction activityRow activityRequestLine${selected ? " selected" : ""}`} aria-pressed={selected}
            aria-label={phoneLabel} onClick={selectRequest} aria-disabled={busy || undefined}>
            <span className="requestsActionsNumber">#{group.request.number}</span>
            <span className="activityRequestWho"><strong>{agentName}</strong> <span>{roleLabel}</span></span>
            <span className="activityRequestMeta">{tokens ? `${compactNumber(tokens.uncachedInputTokens)} in · ` : ""}<time dateTime={group.request.observedAt}>{shortTime(group.request.observedAt)}</time></span>
          </button>
          // The desktop line carries the agent itself, so the row is a grid container rather than
          // one button: the select control stretches its hit area over the whole row (the roster
          // row pattern) and the agent link sits beside it without nesting one control in another.
          : <div className={`activityRow activityRequestRow${selected ? " selected" : ""}`}>
            <button type="button" className="commandQuietAction activityRequestSelect" aria-pressed={selected} aria-label={ariaLabel}
              onClick={selectRequest} aria-disabled={busy || undefined}><strong className="requestsActionsNumber">#{group.request.number}</strong></button>
            <span className="activityRequestWho">
              {agent
                ? <button type="button" className="commandQuietAction activityRequestAgent" aria-label={`Open ${agentName} in the Agents inspector`}
                  onClick={() => onOpenAgent(group.request.agentId)}>{agentName}</button>
                : <strong>{agentName}</strong>}
              <span>{roleLabel}</span>
            </span>
            <span className="activityRequestTokens">{tokens && <>
              <span className="activityTokenValue uncached">{tokens.uncachedInputTokens.toLocaleString()}</span>
              {cacheWriteAvailable && <span className="activityTokenValue write">{tokens.cacheWriteTokens.toLocaleString()}</span>}
              <span className="activityTokenValue output">{tokens.outputTokens.toLocaleString()}</span>
            </>}</span>
          </div>}
        {group.noMatchingCalls && <p className="activityLinkNote">{selection.workKind ? `No ${WORK_LABELS[selection.workKind].toLowerCase()} calls for this request.` : "No recorded calls for this request."}</p>}
        {group.calls.length > 0 && <ul className="activityTable">
          {group.calls.map((call) => phone
            // Tapping a call line still selects its request and chart bar exactly as a request line
            // does; the disclosure beneath it is purely additive.
            ? <ActivityCallLine key={call.id} call={call} agent={agents.find((item) => item.id === (call.agentId ?? group.request.agentId))} busy={busy} open={openCall === call.id}
              onToggle={() => {
                setOpenCall((current) => (current === call.id ? null : call.id));
                onSelectRequest?.(group.request.number);
                selection.locate(group.request.id, selection.scope);
              }} />
            : <li key={call.id} className={`activityDesktopCallRow activityRow${call.status === "failed" ? " failed" : ""}`}>
              <time dateTime={call.timestamp}>{shortTime(call.timestamp)}</time>
              <span className="activityAction"><WorkKindIcon kind={call.workKind} /><span className="activityActionLabel">{call.tool}</span></span>
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
      {rangeLabel && <span>{rangeLabel}</span>}
      <nav aria-label="Request range">
        <button type="button" className="commandSecondaryAction" disabled={index === null || index <= 0} onClick={selection.previousRange}>Previous</button>
        <button type="button" className="commandSecondaryAction" disabled={index === null || index >= total - 1} onClick={selection.nextRange}>Next</button>
        <button type="button" className="commandSecondaryAction" disabled={selection.mode === "follow"} onClick={selection.jumpToLatest}>Jump to latest</button>
      </nav>
    </footer>
    {phone
      ? <p className="activityFeedCaveat">Requests with their tool calls · tap a call for details · <DottedInfoPopover ariaLabel="How to read this feed" content={PHONE_HOW_TO_READ}>how to read this</DottedInfoPopover></p>
      : <p className="activityFeedCaveat"><DottedInfoPopover className="activityFeedInfo" ariaLabel="About request rows" content="Each request's uncached input, cache write and output are request-local and never summed across requests. Tool calls nest under their request with wall duration. Targets show Bash descriptions and file names only.">Request-local counts</DottedInfoPopover></p>}
  </div>;
}
