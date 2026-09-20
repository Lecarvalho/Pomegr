"use client";

import { useSessionDomain } from "../../session-domain-store";
import { SignalsCacheEvidenceSection, type SignalsActivityTarget } from "./signals/SignalsCacheEvidenceSection";
import { SignalsEfficiencySection } from "./signals/SignalsEfficiencySection";
import { SignalsLifetimeSection } from "./signals/SignalsLifetimeSection";
import { SignalsReportedSection } from "./signals/SignalsReportedSection";
import styles from "./SignalsTab.module.css";

export type SignalsTabProps = {
  sessionId: string;
  historical: boolean;
  paused: boolean;
  onNavigateAgent: (agentId: string) => void;
  onNavigateActivities: (target: SignalsActivityTarget) => void;
};

// The committed Signals domain intentionally contains no request associations. Keep this empty
// until the monitor supplies an explicit normalized agent/request pair.
const noActivityTargets: ReadonlyMap<string, SignalsActivityTarget> = new Map();

/** The sole Signals-domain subscription. Historical store entries do not poll. */
export function SignalsTab({ sessionId, historical, paused, onNavigateAgent, onNavigateActivities }: SignalsTabProps) {
  const result = useSessionDomain({ sessionId, domain: "signals" }, { historical, enabled: !paused });
  const signals = result.data;
  if (!signals) return <div className="sessionTabState" role="status">{result.unavailable ? "Signal evidence is unavailable for this session." : result.error ? "Signal evidence is temporarily unavailable." : "Loading signal evidence…"}</div>;
  if (signals.readiness === "loading") return <div className="sessionTabState" role="status">Loading signal evidence…</div>;
  return <div className={`${styles.tab} sessionSignalsTab`} aria-busy={result.fetching || undefined}>
    {result.error && <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded signal evidence.</div>}
    <header className={styles.intro}><div><p className="sessionEyebrow">Signals</p><h2>Session signals</h2><p>Deterministic evidence and agent-reported updates. <strong>Not a quality assessment.</strong></p></div></header>
    <div className={styles.grid}>
      <SignalsEfficiencySection insights={signals.insights} flowScore={signals.flowScore} readiness={signals.sectionReadiness.activityEvidence} onNavigateAgent={onNavigateAgent} />
      <SignalsCacheEvidenceSection agents={signals.agents} cacheEvents={signals.cacheEvents} cacheReadDrops={signals.cacheReadDrops} historical={historical} activityTargets={noActivityTargets} onOpenActivity={onNavigateActivities} />
      <SignalsLifetimeSection agents={signals.agents} readiness={signals.sectionReadiness.contextEvidence} />
      <SignalsReportedSection sessionSignal={signals.sessionSignal} agents={signals.agents} historical={historical} />
    </div>
  </div>;
}
