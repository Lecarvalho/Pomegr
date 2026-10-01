"use client";

import type { SignalsDomain } from "../../../../shared/session-domain-contract";

type SignalsEfficiencySectionProps = {
  insights: SignalsDomain["insights"];
  readiness: SignalsDomain["sectionReadiness"]["activityEvidence"];
  onNavigateAgent: (agentId: string) => void;
};

/** Deterministic attention evidence; it never evaluates an agent's quality. */
export function SignalsEfficiencySection({ insights, readiness, onNavigateAgent }: SignalsEfficiencySectionProps) {
  if (readiness !== "ready") return <section className="signalsSection" aria-labelledby="signals-efficiency">
    <div className="signalsSectionHeading"><h2 id="signals-efficiency">Efficiency</h2></div>
    <p className="signalsUnavailable">Activity evidence is unavailable for this session.</p>
  </section>;

  return <section className="signalsSection" aria-labelledby="signals-efficiency">
    <div className="signalsSectionHeading"><div><h2 id="signals-efficiency">Efficiency</h2><p>Deterministic attention evidence from recorded activity. Not a quality assessment.</p></div><span className="commandChip">{insights.length} {insights.length === 1 ? "signal" : "signals"}</span></div>
    {insights.length === 0 ? <p className="signalsEmpty">No deterministic efficiency signals were recorded.</p> : <ul className="signalsInsightList">
      {insights.map((insight) => <li className={`signalsInsight signalsInsight-${insight.level}`} key={insight.id}>
        <div><strong>{insight.title}</strong><p>{insight.detail}</p></div>
        {typeof insight.agentId === "string" && insight.agentId.length > 0 && <button className="commandTextLink" type="button" onClick={() => onNavigateAgent(insight.agentId!)}>Show agent</button>}
      </li>)}
    </ul>}
  </section>;
}
