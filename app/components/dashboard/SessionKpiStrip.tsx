import type { MonitorState } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";
import { SessionWallTimeText } from "../LiveTime";
import { PHASE_LABELS, remainingLabel } from "./SessionProgressPanel";

export function SessionKpiStrip({ state, historical }: { state: MonitorState; historical: boolean }) {
  const { metrics, agents, session, readiness } = state;
  if (readiness && readiness.core !== "ready") return null;
  const agentReady = !readiness || readiness.agentEvidence === "ready";
  const contextReady = !readiness || readiness.contextEvidence === "ready";
  const activityReady = !readiness || readiness.activityEvidence === "ready";
  const active = agents.filter((agent) => agent.status === "active").length;
  const idle = agents.filter((agent) => ["idle", "waiting", "warm"].includes(agent.status)).length;
  const finished = agents.filter((agent) => ["finished", "stopped"].includes(agent.status)).length;
  const progress = session?.progress;
  const workflows = state.workflows || [];
  const unavailable = (domain: "agentEvidence" | "contextEvidence" | "activityEvidence") => readiness?.[domain] === "loading" ? "Loading evidence" : "Evidence unavailable";

  return <section className="sessionKpiStrip" aria-label="Session totals">
    <div className="sessionKpi">
      <span className="sessionEyebrow"><span className="sessionDesktopLabel">Agents observed</span><span className="sessionPhoneLabel">Agents</span></span>
      <strong>{agentReady ? metrics.agents.toLocaleString() : "—"}</strong>
      <small>{agentReady ? <><span className={active > 0 ? "sessionPositive" : undefined}>{active} active</span> · {idle} idle · {finished} finished</> : unavailable("agentEvidence")}</small>
    </div>
    <div className="sessionKpi">
      <span className="sessionEyebrow">All-agent context</span>
      <strong className="sessionContextValue">{contextReady ? compactNumber(metrics.tokens.allAgents) : "—"}</strong>
      <small>{contextReady ? "Sum of latest snapshots · not spend" : unavailable("contextEvidence")}</small>
    </div>
    <div className="sessionKpi">
      <span className="sessionEyebrow">{historical ? <><span className="sessionDesktopLabel">Recorded wall time</span><span className="sessionPhoneLabel">Wall time</span></> : "Wall time"}</span>
      <strong>{session ? <SessionWallTimeText session={session} historical={historical} /> : "—"}</strong>
      <small>Includes idle gaps</small>
    </div>
    <div className="sessionKpi">
      <span className="sessionEyebrow">Tool calls</span>
      <strong>{activityReady ? metrics.toolCalls.toLocaleString() : "—"}</strong>
      <small>{activityReady ? <>{workflows.length > 0 && `${workflows.length} workflows · `}{metrics.repeatedCalls.toLocaleString()} repeated</> : unavailable("activityEvidence")}</small>
    </div>
    <div className="sessionKpi sessionKpiEstimate">
      <span className="sessionEyebrow">Agent estimate</span>
      <strong className={activityReady && progress ? "sessionPositive" : undefined}>{activityReady && progress ? `${progress.percent}%` : "—"}</strong>
      <small>{!activityReady ? unavailable("activityEvidence") : progress ? `${PHASE_LABELS[progress.phase]} · ${remainingLabel(progress)} · ${progress.confidence} confidence` : "No estimate recorded"}</small>
    </div>
  </section>;
}
