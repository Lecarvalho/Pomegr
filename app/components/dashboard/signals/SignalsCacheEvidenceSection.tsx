"use client";

import type { CacheEvent, CacheReadDropOccurrence, CacheRefillOccurrence } from "../../../../shared/monitor-contract";
import type { SignalsDomain } from "../../../../shared/session-domain-contract";
import { formatDuration, timelineTime } from "../../../dashboard-utils";

export type SignalsActivityTarget = { agent: string; request: string };

type Evidence = {
  id: string | null;
  agentId: string;
  observedAt: string;
  label: string;
  detail: string;
};

function eventEvidence(event: CacheEvent): Evidence {
  const label = event.kind === "reuse" ? "Observed cache reuse" : event.kind === "miss_refill" ? "Observed possible cache miss · refill" : "Observed cache refill";
  return { id: event.id, agentId: event.agentId, observedAt: event.observedAt, label, detail: `${event.cacheReadPercent}% cache read observed.` };
}

function refillEvidence(agentId: string, occurrence: CacheRefillOccurrence): Evidence {
  const details = ["Provider count observed."];
  if (occurrence.providerStatus === "previous_cache_entry_unavailable") details.push("Provider status: previous cache entry unavailable.");
  if (occurrence.cacheLifetimeInference?.cause === "cache_lifetime_elapsed") {
    const lifetime = occurrence.cacheLifetimeInference.cacheLifetime === "5m" ? "5m" : occurrence.cacheLifetimeInference.cacheLifetime === "1h" ? "1h" : "mixed";
    details.push(`Inference: ${lifetime} cache lifetime elapsed after ${formatDuration(occurrence.cacheLifetimeInference.elapsedMs)}.`);
  }
  if (occurrence.toolChangeAttribution) {
    const changes = occurrence.toolChangeAttribution.changes.map((change) => `${change.tool} ${change.kind === "added" ? "added" : "definition changed"}`).join(", ");
    details.push(`Attributed: remote control connected${changes ? `; ${changes}` : ""}.`);
  }
  return { id: null, agentId, observedAt: occurrence.observedAt, label: "Possible full cache refill · observed", detail: details.join(" ") };
}

function readDropEvidence(agentId: string, occurrence: CacheReadDropOccurrence): Evidence {
  const modelChange = occurrence.kind === "model_change";
  return {
    id: occurrence.id,
    agentId,
    observedAt: occurrence.observedAt,
    label: modelChange ? "Cache reuse dropped across a model change" : "Possible cache refill · inference",
    detail: modelChange
      ? `${occurrence.previousCacheReadPercent}% → ${occurrence.cacheReadPercent}% cache read observed. No refill, expiry, or causation claim.`
      : `${occurrence.previousCacheReadPercent}% → ${occurrence.cacheReadPercent}% cache read observed. Possible refill inference; no positive cache-write evidence.`,
  };
}

/** A chronological presentation of monitor-projected cache evidence, never a browser inference. */
export function SignalsCacheEvidenceSection({ agents, cacheEvents, cacheReadDrops, historical, activityTargets, onOpenActivity }: {
  agents: SignalsDomain["agents"];
  cacheEvents: SignalsDomain["cacheEvents"];
  cacheReadDrops: SignalsDomain["cacheReadDrops"];
  historical: boolean;
  activityTargets: ReadonlyMap<string, SignalsActivityTarget>;
  onOpenActivity: (target: SignalsActivityTarget) => void;
}): React.JSX.Element {
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.label]));
  const evidence: Evidence[] = [
    ...(cacheEvents.status === "ready" ? cacheEvents.items.map(eventEvidence) : []),
    ...(cacheEvents.status === "ready" ? cacheEvents.possibleFullRefills.flatMap((group) => group.occurrences.map((occurrence) => refillEvidence(group.agentId, occurrence))) : []),
    ...(cacheReadDrops.status === "ready" ? cacheReadDrops.items.flatMap((group) => group.occurrences.map((occurrence) => readDropEvidence(group.agentId, occurrence))) : []),
  ].sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.label.localeCompare(right.label));
  const ready = cacheEvents.status === "ready" || cacheReadDrops.status === "ready";

  return <section className="signalsCacheEvidenceSection" data-signals-section="cache-evidence" aria-labelledby="signals-cache-evidence">
    <header><div><h2 id="signals-cache-evidence">Cache evidence</h2><p>Observed counts and monitor-projected inferences; never cost or savings.</p></div></header>
    {!ready ? <p className="signalsEmptyState">{historical ? "No comparable cache evidence was recorded for this session." : "Comparable cache evidence is unavailable."}</p>
      : evidence.length === 0 ? <p className="signalsEmptyState">{historical ? "No cache evidence was recorded for this session." : "No cache evidence yet."}</p>
        : <ol className="signalsCacheEvidenceList">
          {evidence.map((item, index) => {
            const target = item.id ? activityTargets.get(item.id) : undefined;
            const supported = Boolean(target?.agent && target.request);
            return <li className="signalsCacheEvidenceRow" key={`${item.id || "occurrence"}-${item.agentId}-${item.observedAt}-${index}`}>
              <div><strong>{item.label}</strong><p>{agentNames.get(item.agentId) || "Agent"} · <time dateTime={item.observedAt}>{timelineTime(item.observedAt, true)}</time></p><p>{item.detail}</p></div>
              {supported && <button className="commandTextLink" type="button" onClick={() => onOpenActivity(target!)}>Open in Activities</button>}
            </li>;
          })}
        </ol>}
  </section>;
}
