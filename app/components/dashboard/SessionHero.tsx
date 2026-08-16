import type { MonitorState, ProviderCapabilities, ProviderSource } from "../../../shared/monitor-contract";
import { sessionListTime } from "../../dashboard-utils";
import { AgentChip } from "../AgentChip";
import { RelativeTimeText, SessionWallTimeText } from "../LiveTime";
import { ProviderBadge } from "../ProviderBadge";

type SessionCost = NonNullable<NonNullable<MonitorState["session"]>["cost"]>;

function estimatedCostLabel(cost: SessionCost) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
    maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
  }).format(cost.amount);
}

function SessionCostMeta({ cost, source, supported, historical }: {
  cost: SessionCost | null;
  source: ProviderSource;
  supported: boolean;
  historical: boolean;
}) {
  return (
    <div className="sessionMetaGroup sessionCost">
      <span className="sessionMetaLabel">SESSION COST ESTIMATE</span>
      <strong className={!supported || !cost ? "sessionCostUnavailable" : undefined}>
        {!supported ? "Unsupported" : cost ? estimatedCostLabel(cost) : historical ? "Not recorded" : "Not observed"}
      </strong>
      <small>
        {!supported
          ? "This provider does not report a session estimate."
          : cost
            ? <><span>{source} estimate · {historical ? <>recorded {sessionListTime(cost.observedAt)}</> : <>observed <RelativeTimeText value={cost.observedAt} /></>}</span><span>May differ from actual billing.</span></>
            : historical
              ? "No estimate was captured for this session."
              : "Waiting for a provider status-line estimate."}
      </small>
    </div>
  );
}

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
          <AgentChip className={`sessionSignal ${session.signal.tone}`} title={session.signal.description || "Reported for this session through the Pomegr MCP tool"}>{session.signal.label}</AgentChip>
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
        <SessionCostMeta cost={session.cost} source={source} supported={capabilities.estimatedCost} historical={historical} />
      </div>}
    </section>
  );
}
