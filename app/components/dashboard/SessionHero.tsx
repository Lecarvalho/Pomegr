import type { MonitorState, ProviderCapabilities, ProviderSource, SessionActivityStatus } from "../../../shared/monitor-contract";
import { shortTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { SessionWallTimeText } from "../LiveTime";
import { ProviderBadge } from "../ProviderBadge";

export function SessionHero({ session, source, capabilities, historical, activityStatus = "unknown" }: { session: MonitorState["session"]; source: ProviderSource; capabilities: ProviderCapabilities; historical: boolean; activityStatus?: SessionActivityStatus }) {
  const sessionLabel = session?.title || "Waiting for a session";
  const providerSummary = capabilities.sessionSummary ? session?.summary : null;
  const reportedSummary = !capabilities.sessionSummary && capabilities.signals
    ? session?.signal?.description || null
    : null;
  const summaryText = providerSummary?.text || reportedSummary;
  const summarySource = providerSummary
    ? "Provider summary"
    : reportedSummary ? "Agent-reported summary" : null;
  const summaryTitle = providerSummary
    ? "Provider-generated session summary"
    : reportedSummary ? "Agent-reported session summary from the Pomegr MCP tool" : undefined;
  const emptySummary = capabilities.sessionSummary
    ? historical ? "No provider summary was recorded for this session." : "Waiting for the provider to record a session summary."
    : capabilities.signals
      ? historical ? "No agent-reported summary was recorded for this session." : "Waiting for an agent to report a session summary through Pomegr."
      : "Session summaries are not available for this provider.";
  const sessionDisplayId = session?.id.includes(":") ? session.id.slice(session.id.indexOf(":") + 1) : session?.id;
  const statusLabel = historical ? "Recorded session · ended"
    : activityStatus === "working" ? "Live session · active"
      : activityStatus === "needs_input" ? "Live session · needs your input"
        : `Live session · ${activityStatus}`;
  const statusTone = historical ? "idle" : activityStatus === "working" ? "active" : activityStatus === "needs_input" ? "attention" : "idle";
  const approvalLabel = session?.approvalMode?.label || (historical ? "Not recorded" : "Not reported yet");
  const approvalTitle = session?.approvalMode
    ? historical ? "Last provider-reported mode recorded for this session." : "Latest recognized provider-reported mode."
    : historical ? "The provider did not record an approval mode for this session." : "Waiting for the provider to report an approval mode for this session.";
  const updatedTime = session?.updatedAt && Number.isFinite(Date.parse(session.updatedAt)) ? shortTime(session.updatedAt) : "Time unavailable";
  return (
    <section className="hero">
      <div>
        <h1>{sessionLabel}</h1>
        {session && <div className="sessionIdentity">
          <strong>{session.project}</strong>
          <span className="sessionIdentityPart"><span aria-hidden="true">·</span><ProviderBadge source={source} /></span>
          <span className="sessionIdentityPart"><span aria-hidden="true">·</span><code>{sessionDisplayId}</code></span>
          <span className="sessionIdentityPart"><span aria-hidden="true">·</span><span className="commandBadge">{historical ? "Historical snapshot" : "Live session"}</span></span>
        </div>}
        {session && <p title={summaryTitle}>{summaryText || emptySummary}</p>}
        {(summarySource || session?.signal) && <div className="heroSummaryRow">
          {summarySource && <small className="heroSummarySource sessionEyebrow">{summarySource}</small>}
          {session?.signal && <div className="heroSignalRow" aria-label="Agent-reported session signal">
            <AgentChip className={`sessionSignal ${session.signal.tone}`} title={session.signal.description || "Reported for this session through the Pomegr MCP tool"}>{session.signal.label}</AgentChip>
          </div>}
        </div>}
      </div>
      {session && <div className="sessionHeroActions">
        <div className={`sessionStatusCard ${statusTone}`} aria-label="Session status">
          <i aria-hidden="true" />
          <strong>{statusLabel}</strong>
          <small><time dateTime={session.updatedAt || undefined}>{updatedTime}</time>
            {capabilities.approvalMode && <> · <span className="sessionApprovalModeValue" title={approvalTitle}>{approvalLabel}</span></>}
            {" · "}<span><SessionWallTimeText session={session} historical={historical} /></span> wall time
          </small>
        </div>
      </div>}
    </section>
  );
}
