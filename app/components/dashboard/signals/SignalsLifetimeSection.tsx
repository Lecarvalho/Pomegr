import type { SignalsDomain } from "../../../../shared/session-domain-contract";

function lifetimeLabel(lifetime: SignalsDomain["agents"][number]["cacheLifetime"]) {
  if (lifetime === "30m+") return "≥30m";
  return lifetime || "unavailable";
}

/** Recorded per-agent cache lifetime evidence; a minimum is never an expiry claim. */
export function SignalsLifetimeSection({ agents, readiness }: {
  agents: SignalsDomain["agents"];
  readiness: SignalsDomain["sectionReadiness"]["contextEvidence"];
}): React.JSX.Element {
  const ready = readiness === "ready";
  return <section className="signalsLifetimeSection" data-signals-section="cache-lifetime" aria-labelledby="signals-cache-lifetime">
    <header><div><h2 id="signals-cache-lifetime">Cache lifetime</h2><p>Recorded cache-lifetime evidence by agent.</p></div></header>
    {agents.length === 0 ? <p className="signalsEmptyState">No agents were recorded for this session.</p> : <ul className="signalsLifetimeList">
      {agents.map((agent) => <li key={agent.id}>
        <span>{agent.label}</span>
        <strong>{ready ? lifetimeLabel(agent.cacheLifetime) : "unavailable"}</strong>
      </li>)}
    </ul>}
    {ready && agents.some((agent) => agent.cacheLifetime === "30m+") && <p className="signalsSectionNote">≥30m is a documented minimum, not a recorded expiry.</p>}
    {!ready && <p className="signalsSectionNote">Context evidence is unavailable, so cache lifetimes are unavailable.</p>}
  </section>;
}
