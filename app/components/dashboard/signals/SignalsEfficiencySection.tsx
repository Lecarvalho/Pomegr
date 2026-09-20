"use client";

import type { SignalsDomain } from "../../../../shared/session-domain-contract";

type SignalsEfficiencySectionProps = {
  insights: SignalsDomain["insights"];
  flowScore: SignalsDomain["flowScore"];
  readiness: SignalsDomain["sectionReadiness"]["activityEvidence"];
  onNavigateAgent: (agentId: string) => void;
};

function inputLabel(value: number | null, label: string) {
  return <div><dt>{label}</dt><dd>{value === null ? "—" : value.toLocaleString()}</dd></div>;
}

/** Deterministic attention evidence; it never evaluates an agent's quality. */
export function SignalsEfficiencySection({ insights, flowScore, readiness, onNavigateAgent }: SignalsEfficiencySectionProps) {
  if (readiness !== "ready") return <section className="signalsSection" aria-labelledby="signals-efficiency">
    <div className="signalsSectionHeading"><h2 id="signals-efficiency">Efficiency</h2></div>
    <p className="signalsUnavailable">Activity evidence is unavailable for this session.</p>
  </section>;

  return <section className="signalsSection" aria-labelledby="signals-efficiency">
    <div className="signalsSectionHeading"><div><h2 id="signals-efficiency">Efficiency</h2><p>Deterministic attention evidence from recorded activity. Not a quality assessment.</p></div><span className="commandChip">{insights.length} {insights.length === 1 ? "signal" : "signals"}</span></div>
    <div className="signalsFlowScore" aria-label="Flow score">
      <div><span>Flow score</span><strong>{flowScore.score}/100</strong></div>
      <dl>{inputLabel(flowScore.repeatedCalls, "Repeated calls")}{inputLabel(flowScore.overlappingTargets, "Overlapping edit targets")}</dl>
      <p>Flow score and its inputs are deterministic attention evidence, not a quality assessment.</p>
    </div>
    {insights.length === 0 ? <p className="signalsEmpty">No deterministic efficiency signals were recorded.</p> : <ul className="signalsInsightList">
      {insights.map((insight) => <li className={`signalsInsight signalsInsight-${insight.level}`} key={insight.id}>
        <div><strong>{insight.title}</strong><p>{insight.detail}</p></div>
        {typeof insight.agentId === "string" && insight.agentId.length > 0 && <button className="commandTextLink" type="button" onClick={() => onNavigateAgent(insight.agentId!)}>Show agent</button>}
      </li>)}
    </ul>}
  </section>;
}
