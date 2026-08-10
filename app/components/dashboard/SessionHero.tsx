import type { MonitorState } from "../../../shared/monitor-contract";
import { sessionListTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { RelativeTimeText, SessionWallTimeText } from "../LiveTime";

export function SessionHero({ session, historical }: { session: MonitorState["session"]; historical: boolean }) {
  const sessionLabel = session?.title || "Waiting for a session";
  return (
    <section className="hero">
      <div>
        <h1>{sessionLabel}</h1>
        {session && <div className="sessionIdentity"><strong>{session.project}</strong><span>·</span><code>{session.id}</code></div>}
        {session && <p title={session.summary ? "Provider-generated session summary" : undefined}>{session.summary?.text
          || (historical ? "No provider summary was recorded for this session." : "Waiting for the provider to record a session summary.")}</p>}
        {session?.summary && <small className="heroSummarySource">Provider summary</small>}
      </div>
      {session && <div className="sessionMeta">
        <div className="sessionMetaValues">
          <span>{historical ? "RECORDED WALL TIME" : "ELAPSED WALL TIME"}</span>
          <strong><SessionWallTimeText session={session} historical={historical} /></strong>
          <small>{historical ? `Ended ${sessionListTime(session.updatedAt || "")}` : <>Last event <RelativeTimeText value={session.updatedAt} /></>}</small>
          {session?.approvalMode && <div className="sessionApprovalMode">
            <span>{historical ? "LAST APPROVAL MODE" : "APPROVAL MODE"}</span>
            <AgentChip
              className="sessionApprovalModeChip"
              title={historical ? "Last provider-reported mode recorded for this session." : "Provider-reported mode from the latest recorded user turn."}
            >{session.approvalMode.label}</AgentChip>
            <small>{session.approvalMode.observedAt
              ? historical ? `Recorded ${sessionListTime(session.approvalMode.observedAt)}` : <>Observed <RelativeTimeText value={session.approvalMode.observedAt} /></>
              : "Provider-reported"}</small>
          </div>}
        </div>
        {session?.signal && <AgentChip className={`sessionSignal ${session.signal.tone}`} title="Reported for this session through the Threadlight MCP tool">{session.signal.label}</AgentChip>}
      </div>}
    </section>
  );
}
