import type { CacheEvent, CacheEventFeed, CacheReadDropFeed, CacheReadDropOccurrence, CacheRefillOccurrence, RequestSnapshot } from "../../../../shared/monitor-contract";

export type RequestCacheEvidence = {
  kind: "refill" | "possible_refill" | "model_change";
  event?: CacheEvent;
  occurrence?: CacheRefillOccurrence;
  readDrop?: CacheReadDropOccurrence;
};

export function cacheEvidenceLabel(evidence: RequestCacheEvidence, compact = false) {
  if (evidence.kind === "model_change") return compact ? "Reuse drop · model change" : "Cache reuse dropped across a model change";
  return evidence.kind === "refill" ? "Possible full refill" : "Possible refill";
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
    if (occurrence) result.set(request.id, { kind: "refill", event, occurrence });
    else if (readDrop) result.set(request.id, { kind: readDrop.kind === "model_change" ? "model_change" : "possible_refill", readDrop });
  }
  return result;
}
