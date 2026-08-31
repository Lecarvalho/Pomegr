import { buildContextBoundaryEvidence } from "./context-history.mjs";
import { normalizedRequestEvidence, requestSnapshotFromEvidence } from "./request-snapshots.mjs";

const LIMITS = Object.freeze({ refillTransitions: 100, contextBoundaries: 100 });

// Exact private observation identity, including its versioned measurements.
// These keys never enter report evidence or browser state.
function requestIdentity(snapshot) {
  return JSON.stringify([
    snapshot.actorId, snapshot.dedupeId, snapshot.timestamp,
    snapshot.input, snapshot.cacheRead, snapshot.cacheWrite, snapshot.output,
  ]);
}

/**
 * D Derivation only: select bounded public report evidence from committed
 * normalized observations. Never publish the private cache classifier result.
 */
export function buildSessionReportEvidence({
  sessionId, agents, usageSnapshots, compactions, cacheEvidence, capabilities,
}) {
  const normalized = normalizedRequestEvidence(agents, usageSnapshots, Infinity);
  const byIdentity = new Map();
  const byAgent = new Map();
  const byTime = new Map();
  for (const item of normalized) {
    const request = requestSnapshotFromEvidence(sessionId, item);
    byIdentity.set(requestIdentity(item.snapshot), request);
    const items = byAgent.get(request.agentId) || [];
    items.push(request);
    byAgent.set(request.agentId, items);
    const key = JSON.stringify([request.agentId, request.observedAt]);
    byTime.set(key, [...(byTime.get(key) || []), request]);
  }
  const nextById = new Map();
  for (const requests of byAgent.values()) {
    for (let index = 0; index < requests.length - 1; index += 1) {
      // Equal timestamp order is ambiguous; never invent a next request.
      if (requests[index].observedAt === requests[index + 1].observedAt) continue;
      const following = requests[index + 1];
      if (byTime.get(JSON.stringify([following.agentId, following.observedAt])).length !== 1) continue;
      nextById.set(requests[index].id, following);
    }
  }
  const transitions = cacheEvidence.refillRequests
    .slice(-LIMITS.refillTransitions)
    .map(({ snapshot, previous, observation }) => {
      const current = byIdentity.get(requestIdentity(snapshot)) || null;
      return {
        id: observation.id,
        agentId: observation.agentId,
        observedAt: observation.observedAt,
        promptInputTokens: observation.promptInputTokens,
        cacheWriteTokens: observation.cacheWriteTokens,
        cacheReadPercent: observation.cacheReadPercent,
        previousCacheReadPercent: observation.previousCacheReadPercent,
        gapMs: observation.gapMs,
        previousCacheLifetime: observation.previousCacheLifetime,
        reason: observation.reason,
        providerStatus: observation.providerStatus,
        messageChangeSequence: observation.messageChangeSequence,
        requests: {
          previous: byIdentity.get(requestIdentity(previous)) || null,
          current,
          next: current ? nextById.get(current.id) || null : null,
        },
      };
    });
  const allBoundaries = buildContextBoundaryEvidence(normalized.map(({ snapshot }) => snapshot), {
    sessionId, agentIds: agents.map((agent) => agent.id), compactions,
  });
  const contextAvailable = normalized.length > 0 || allBoundaries.length > 0;
  const compactionsAvailable = contextAvailable && capabilities.automaticCompactions === true;
  const cacheAvailable = cacheEvidence.feed.status === "ready";
  const countKind = (kind) => allBoundaries.filter((boundary) => boundary.kind === kind).length;
  return {
    version: 1,
    requestCount: normalized.length,
    cache: {
      status: cacheAvailable ? "ready" : "unavailable",
      refills: cacheAvailable ? cacheEvidence.events.filter((event) => event.kind !== "reuse").length : null,
      reuses: cacheAvailable ? cacheEvidence.events.filter((event) => event.kind === "reuse").length : null,
      possibleFullRefills: cacheAvailable ? cacheEvidence.refillRequests.length : null,
      missRefills: cacheAvailable ? cacheEvidence.events.filter((event) => event.kind === "miss_refill").length : null,
      transitions,
    },
    context: {
      status: contextAvailable ? "ready" : "unavailable",
      automaticCompactions: compactionsAvailable ? countKind("automatic_compaction") : null,
      manualCompactions: compactionsAvailable ? countKind("manual_compaction") : null,
      snapshotDrops: contextAvailable ? countKind("snapshot_drop") : null,
      boundaries: allBoundaries.slice(-LIMITS.contextBoundaries).map((boundary) => {
        const matches = byTime.get(JSON.stringify([boundary.agentId, boundary.timestamp])) || [];
        return {
          ...boundary,
          current: boundary.kind === "snapshot_drop" && matches.length === 1 ? matches[0] : null,
        };
      }),
    },
    limits: { ...LIMITS },
  };
}
