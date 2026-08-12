import type { MonitorState, ProviderCapabilities, ProviderSource } from "../../../shared/monitor-contract";
import { sessionListTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { SessionWallTimeText } from "../LiveTime";
import { ProviderBadge } from "../ProviderBadge";

export function SessionHero({ session, source, capabilities, historical }: { session: MonitorState["session"]; source: ProviderSource; capabilities: ProviderCapabilities; historical: boolean }) {
  const sessionLabel = session?.title || "Waiting for a session";
  const summary = capabilities.sessionSummary ? session?.summary : null;
  const sessionDisplayId = session?.id.includes(":") ? session.id.slice(session.id.indexOf(":") + 1) : session?.id;
  return (
    <section className="hero">
      <div>
        <h1>{sessionLabel}</h1>
        {session && <div className="sessionIdentity">
          <strong>{session.project}</strong>
          <span className="sessionIdentityPart"><span aria-hidden="true">·</span><ProviderBadge source={source} /></span>
          <span className="sessionIdentityPart"><span aria-hidden="true">·</span><code>{sessionDisplayId}</code></span>
        </div>}
        {session && <p title={summary ? "Provider-generated session summary" : undefined}>{summary?.text
          || (!capabilities.sessionSummary
            ? "Session summaries are not available for this provider."
            : historical ? "No provider summary was recorded for this session." : "Waiting for the provider to record a session summary.")}</p>}
        {summary && <small className="heroSummarySource">Provider summary</small>}
        {session?.signal && <div className="heroSignalRow" aria-label="Agent-reported session signal">
          <AgentChip className={`sessionSignal ${session.signal.tone}`} title={session.signal.description || "Reported for this session through the Threadlight MCP tool"}>{session.signal.label}</AgentChip>
        </div>}
      </div>
      {session && <div className="sessionMeta" aria-label="Session status">
        <div className="sessionMetaGroup sessionTiming">
          <span className="sessionMetaLabel">{historical ? "RECORDED WALL TIME" : "ELAPSED WALL TIME"}</span>
          <strong><SessionWallTimeText session={session} historical={historical} /></strong>
          {historical && <small>{`Ended ${sessionListTime(session.updatedAt || "")}`}</small>}
        </div>
        {capabilities.approvalMode && <div className="sessionMetaGroup sessionApprovalMode">
          <span className="sessionMetaLabel">{historical ? "LAST APPROVAL MODE" : "APPROVAL MODE"}</span>
          <strong
            className={`sessionApprovalModeValue${session.approvalMode ? "" : " sessionApprovalModeUnavailable"}`}
            title={session.approvalMode
              ? historical ? "Last provider-reported mode recorded for this session." : "Latest recognized provider-reported mode."
              : historical ? "The provider did not record an approval mode for this session." : "Waiting for the provider to report an approval mode for this session."}
          >{session.approvalMode?.label || (historical ? "Not recorded" : "Not reported yet")}</strong>
          {historical && session.approvalMode && <small>{session.approvalMode.observedAt
            ? `Recorded ${sessionListTime(session.approvalMode.observedAt)}`
            : "Provider-reported"}</small>}
        </div>}
      </div>}
    </section>
  );
}
