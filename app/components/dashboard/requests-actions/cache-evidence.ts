import type { CacheEvent, CacheEventFeed, CacheLifetimeInference, CacheReadDropFeed, CacheReadDropOccurrence, CacheRefillCount, CacheRefillOccurrence, RequestSnapshot } from "../../../../shared/monitor-contract";

import { formatDuration } from "../../../dashboard-utils";

export type RequestCacheEvidence = {
  kind: "refill" | "provider_diagnosed" | "possible_refill" | "model_change";
  event?: CacheEvent;
  occurrence?: CacheRefillOccurrence;
  readDrop?: CacheReadDropOccurrence;
};

/** The upstream issue behind a possible full refill that carries no reason, status or inference. */
export const CACHE_REFILL_UPSTREAM_ISSUE = { label: "anthropics/claude-code#82563", href: "https://github.com/anthropics/claude-code/issues/82563" } as const;

/** Read-drop evidence is an inference; recorded and provider-diagnosed refills carry a recorded write. */
export function cacheEvidenceIsInferred(evidence: RequestCacheEvidence) {
  return evidence.kind === "possible_refill" || evidence.kind === "model_change";
}

/** One matched occurrence in the per-agent shape the Agents-tab popover renders. */
export function refillEvidenceCounts(agentId: string, occurrence: CacheRefillOccurrence): CacheRefillCount[] {
  const diagnosed = occurrence.kind === "provider_diagnosed";
  return [{
    agentId, count: diagnosed ? 0 : 1, ...(diagnosed ? { providerDiagnosedCount: 1 } : {}), occurrences: [occurrence],
    reasons: !diagnosed && occurrence.reason ? [{ reason: occurrence.reason, count: 1 }] : [], toolChangeAttributions: [],
  }];
}

export function cacheEvidenceLabel(evidence: RequestCacheEvidence, compact = false) {
  if (evidence.kind === "model_change") return compact ? "Reuse drop · model change" : "Cache reuse dropped across a model change";
  if (evidence.kind === "provider_diagnosed") return compact ? "Diagnosed refill" : "Provider-diagnosed refill";
  return evidence.kind === "refill" ? "Possible full refill" : "Possible refill";
}

export function cacheLifetimeInferenceLabel(inference: CacheLifetimeInference | null | undefined) {
  if (!inference || inference.cause !== "cache_lifetime_elapsed") return "";
  const lifetime = inference.cacheLifetime === "5m"
    ? "Five-minute cache"
    : inference.cacheLifetime === "1h"
      ? "One-hour cache"
      : "Mixed cache lifetimes";
  return `${lifetime} likely expired; ${formatDuration(inference.elapsedMs)} elapsed since the preceding request`;
}

/** Full label plus the monitor's expiry inference when one was recorded. */
export function cacheEvidenceDescription(evidence: RequestCacheEvidence) {
  const inference = cacheLifetimeInferenceLabel(evidence.occurrence?.cacheLifetimeInference);
  return inference ? `${cacheEvidenceLabel(evidence)}. ${inference}` : cacheEvidenceLabel(evidence);
}

export function snapshotEventKey(agentId: string, observedAt: string) {
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) return null;
  return `${agentId}\u0000${new Date(timestamp).toISOString()}`;
}

/** Keep ambiguous timestamps unavailable instead of choosing an arbitrary request. */
export function uniqueByRequest<T extends { observedAt: string }>(items: Array<T & { agentId: string }>) {
  const index = new Map<string, T | null>();
  for (const item of items) {
    const key = snapshotEventKey(item.agentId, item.observedAt);
    if (key !== null) index.set(key, index.has(key) ? null : item);
  }
  return index;
}

/** Associate existing normalized evidence only; the browser never classifies a refill. */
export function requestCacheEvidence(snapshots: RequestSnapshot[], events?: CacheEventFeed, drops?: CacheReadDropFeed) {
  const requests = uniqueByRequest(snapshots);
  const refills = uniqueByRequest(events?.status === "ready" ? events.items.filter((event) => event.kind !== "reuse") : []);
  const occurrences = uniqueByRequest(events?.status === "ready"
    ? (events.possibleFullRefills ?? []).flatMap((group) => group.occurrences.map((item) => ({ ...item, agentId: group.agentId }))) : []);
  const readDrops = uniqueByRequest(drops?.status === "ready"
    ? drops.items.flatMap((group) => group.occurrences.map((item) => ({ ...item, agentId: group.agentId }))) : []);
  const result = new Map<string, RequestCacheEvidence>();
  for (const [key, request] of requests) {
    if (!request) continue;
    const event = refills.get(key);
    const occurrence = occurrences.get(key);
    const readDrop = readDrops.get(key);
    if (event === null || occurrence === null || readDrop === null) continue;
    // Only the monitor's qualifying transition warrants a line. A large write
    // alone can be cache growth or initial creation; event details only enrich it.
    // Occurrences also preserve transitions beyond the detailed event cap.
    if (occurrence) result.set(request.id, { kind: occurrence.kind === "provider_diagnosed" ? "provider_diagnosed" : "refill", event, occurrence });
    else if (readDrop) result.set(request.id, { kind: readDrop.kind === "model_change" ? "model_change" : "possible_refill", readDrop });
  }
  return result;
}
