import type { SignalsDomain } from "../../../../shared/session-domain-contract";

type ReportedSignal = NonNullable<SignalsDomain["sessionSignal"]>;

function SignalRow({ label, signal, source }: { label: string; signal: ReportedSignal; source: "session" | "agent" }) {
  return <li className={`signalsReportedRow ${signal.tone}`}>
    <div><strong>{signal.label}</strong>{signal.description && <p>{signal.description}</p>}</div>
    <span>{source === "session" ? "Session · agent-reported" : `Agent · agent-reported · ${label}`}</span>
  </li>;
}

/** Signals originate with the agent; Pomegr only presents their bounded fields. */
export function SignalsReportedSection({ sessionSignal, agents, historical }: {
  sessionSignal: SignalsDomain["sessionSignal"];
  agents: SignalsDomain["agents"];
  historical: boolean;
}): React.JSX.Element {
  const agentSignals = agents.flatMap((agent) => agent.signal ? [{ agent, signal: agent.signal }] : []);
  const hasSignals = Boolean(sessionSignal) || agentSignals.length > 0;
  return <section className="signalsReportedSection sessionSignalsAside" data-signals-section="reported" aria-labelledby="signals-reported">
    <header><div><h2 id="signals-reported">Reported signals</h2><p>{historical ? "Recorded agent-reported signals for this session." : "Agent-reported signals for this session."}</p></div></header>
    {hasSignals ? <ul className="signalsReportedList">
      {sessionSignal && <SignalRow label="Session" signal={sessionSignal} source="session" />}
      {agentSignals.map(({ agent, signal }) => <SignalRow key={agent.id} label={agent.label} signal={signal} source="agent" />)}
    </ul> : <p className="signalsEmptyState">{historical ? "No reported signals were recorded for this session." : "No reported signals yet."}</p>}
    <p className="signalsSectionNote">Signals are agent-reported, may be stale, and are not Pomegr judgments.</p>
  </section>;
}
