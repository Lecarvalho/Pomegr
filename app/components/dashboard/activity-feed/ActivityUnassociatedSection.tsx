"use client";

import { useId, useState } from "react";
import type { Agent } from "../../../../shared/monitor-contract";
import { ActivityCallLine } from "./ActivityCallLine";
import type { UnassociatedActivity } from "./useUnassociatedActivity";

const TITLE = "Actions without a recorded request";

/**
 * Tool calls the provider recorded no request for, kept apart from the request groups. It renders
 * only what the view object holds (no fetching here) and implies no owner: rows carry the recorded
 * time, kind, target, status and wall duration, never a request number or a token value. The count
 * is the committed feed's own scoped tool-call total, so it is shown whether or not rows are loaded
 * and never replaced by the loaded length.
 */
export function ActivityUnassociatedSection({ unassociated, agents, busy }: {
  unassociated: UnassociatedActivity; agents: Agent[]; busy: boolean;
}) {
  const { total, status, calls, remaining, open, setOpen, loadMore, retry } = unassociated;
  // One call detail is open at a time, as in the request groups; it is view state only.
  const [openCall, setOpenCall] = useState<string | null>(null);
  const headingId = useId();
  const bodyId = useId();
  if (total <= 0) return null;
  const loading = status === "loading";
  return <section className="activityUnassociated" aria-labelledby={headingId}
    onKeyDown={(event) => { if (event.key === "Escape" && openCall) setOpenCall(null); }}>
    <h3 className="activityUnassociatedHeading" id={headingId}>
      <button type="button" className="commandQuietAction activityUnassociatedToggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="activityUnassociatedTitle">{TITLE}</span>{" "}
        <span className="activityUnassociatedCount">{total.toLocaleString()} {total === 1 ? "tool call" : "tool calls"}</span>
        <svg className="activityUnassociatedChevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
      </button>
    </h3>
    {open && <div className="activityUnassociatedBody" id={bodyId}>
      <p className="activityUnassociatedNote">These tool calls ran, but the provider recorded no request for them, so none is attributed.</p>
      {calls.length > 0 && <ul className="activityUnassociatedList">
        {calls.map((call) => <ActivityCallLine key={call.id} call={call} showTime busy={busy} open={openCall === call.id}
          agent={agents.find((item) => item.id === call.agentId)}
          onToggle={() => setOpenCall((current) => (current === call.id ? null : call.id))} />)}
      </ul>}
      {calls.length === 0 && loading && <p className="activityUnassociatedState" role="status">Loading calls…</p>}
      {status === "unavailable" && <p className="activityHistoryError" role="status">
        {calls.length ? "Actions without a recorded request could not update. Showing the calls already loaded." : "Actions without a recorded request are unavailable."}{" "}
        <button type="button" className="commandTextLink" onClick={retry}>Retry</button>
      </p>}
      {calls.length > 0 && remaining > 0 && (status === "ready" || loading) && <div className="activityUnassociatedFooter">
        <button type="button" className="commandTextLink activityUnassociatedMore" disabled={loading} onClick={loadMore}>
          {loading ? "Loading calls…" : `Show ${remaining.toLocaleString()} more calls`}
        </button>
      </div>}
    </div>}
  </section>;
}
