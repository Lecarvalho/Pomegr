import crypto from "node:crypto";

export const CACHE_EVENT_RULES = Object.freeze({
  minimumPromptInputTokens: 8_000,
  minimumCacheWriteTokens: 8_000,
  minimumReuseReadShare: 0.8,
  maximumMissReadShare: 0.1,
  minimumMissGapMs: 30 * 60 * 1_000,
  maximumSessionEvents: 20,
  maximumAgentRefillCount: 999,
});

const CACHE_REFILL_REASONS = new Set(["model_changed", "system_changed", "tools_changed", "messages_changed"]);
const CACHE_TOOL_CHANGE_CAUSES = new Map([
  ["remote_control_connected", Object.freeze([
    Object.freeze({ tool: "RemoteTrigger", kind: "added" }),
    Object.freeze({ tool: "PushNotification", kind: "added" }),
    Object.freeze({ tool: "ListAgents", kind: "definition_changed" }),
  ])],
]);

function timestampMs(value) {
  const milliseconds = Date.parse(value || "");
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function cacheParts(snapshot) {
  const input = count(snapshot?.input);
  const cacheRead = count(snapshot?.cacheRead);
  const cacheWrite = count(snapshot?.cacheWrite);
  if (input === null || cacheRead === null || cacheWrite === null) return null;
  const promptInputTokens = input + cacheRead + cacheWrite;
  if (!Number.isSafeInteger(promptInputTokens) || promptInputTokens <= 0) return null;
  return { input, cacheRead, cacheWrite, promptInputTokens, cacheReadShare: cacheRead / promptInputTokens };
}

function opaqueId(sessionId, snapshot, kind) {
  return `cache-${crypto.createHash("sha256")
    .update(`${sessionId}|${snapshot.actorId}|${kind}|${snapshot.dedupeId}|${snapshot.timestamp}`)
    .digest("hex").slice(0, 16)}`;
}

function compactionActorId(compaction) {
  const value = compaction?.actorId ?? compaction?.actor?.id;
  return typeof value === "string" ? value : "";
}

function hasCompactionBetween(compactions, actorId, after, through) {
  return compactions.some((compaction) => {
    if (compactionActorId(compaction) !== actorId) return false;
    const observed = timestampMs(compaction.timestamp);
    return observed !== null && observed > after && observed <= through;
  });
}

function eventFrom(snapshot, kind, parts, extra = {}) {
  return {
    id: extra.id,
    agentId: snapshot.actorId,
    kind,
    observedAt: snapshot.timestamp,
    promptInputTokens: parts.promptInputTokens,
    cacheReadPercent: Math.round(parts.cacheReadShare * 100),
    cacheWriteTokens: parts.cacheWrite,
    previousCacheReadPercent: extra.previousCacheReadPercent ?? null,
    gapMs: extra.gapMs ?? null,
    relatedEventId: extra.relatedEventId ?? null,
  };
}

/**
 * Derive a bounded factual cache-event feed. Low cache reuse alone never
 * becomes a miss: miss_refill requires a simultaneously recorded large write.
 */
export function buildCacheEvents({
  sessionId = "session",
  agents = [],
  usageSnapshots = [],
  compactions = [],
  enabled = false,
} = {}) {
  if (!enabled) return { status: "unavailable", items: [], possibleFullRefills: [] };
  const visibleAgentIds = new Set(agents.map((agent) => agent.id));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const unique = new Map();
  for (const snapshot of usageSnapshots) {
    if (!snapshot || typeof snapshot.dedupeId !== "string" || snapshot.cacheComparable !== true) continue;
    if (!visibleAgentIds.has(snapshot.actorId) || timestampMs(snapshot.timestamp) === null || !cacheParts(snapshot)) continue;
    const previous = unique.get(snapshot.dedupeId);
    if (!previous || timestampMs(snapshot.timestamp) >= timestampMs(previous.timestamp)) unique.set(snapshot.dedupeId, snapshot);
  }
  const observations = [...unique.values()].sort((left, right) => (
    timestampMs(left.timestamp) - timestampMs(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)
  ));
  if (!observations.length) return { status: "unavailable", items: [], possibleFullRefills: [] };

  const previousByActor = new Map();
  const trackedRefillByActor = new Map();
  const possibleFullRefillsByActor = new Map();
  const possibleFullRefillOccurrencesByActor = new Map();
  const possibleFullRefillReasonsByActor = new Map();
  const possibleToolChangeAttributionsByActor = new Map();
  const events = [];
  for (const snapshot of observations) {
    const observedAt = timestampMs(snapshot.timestamp);
    const parts = cacheParts(snapshot);
    const previous = previousByActor.get(snapshot.actorId) || null;
    const group = Number.isSafeInteger(snapshot.comparisonGroup) ? snapshot.comparisonGroup : null;
    const model = typeof snapshot.model === "string" ? snapshot.model : "";
    const agent = agentsById.get(snapshot.actorId);
    const comparableToPrevious = previous
      && group !== null
      && group === previous.group
      && model.length > 0
      && model === previous.model
      && !hasCompactionBetween(compactions, snapshot.actorId, previous.observedAt, observedAt);
    const gapMs = comparableToPrevious ? observedAt - previous.observedAt : null;
    const possibleFullRefill = agent?.role !== "fork"
      && comparableToPrevious
      && previous.parts.promptInputTokens >= CACHE_EVENT_RULES.minimumPromptInputTokens
      && parts.promptInputTokens >= CACHE_EVENT_RULES.minimumPromptInputTokens
      && previous.parts.cacheReadShare >= CACHE_EVENT_RULES.minimumReuseReadShare
      && parts.cacheReadShare <= CACHE_EVENT_RULES.maximumMissReadShare
      && parts.cacheWrite >= CACHE_EVENT_RULES.minimumCacheWriteTokens;
    if (possibleFullRefill) {
      const previousRefillCount = possibleFullRefillsByActor.get(snapshot.actorId) || 0;
      possibleFullRefillsByActor.set(snapshot.actorId, Math.min(
        CACHE_EVENT_RULES.maximumAgentRefillCount,
        previousRefillCount + 1,
      ));
      const recognizedReason = typeof snapshot.cacheMissReason === "string"
        && CACHE_REFILL_REASONS.has(snapshot.cacheMissReason)
        ? snapshot.cacheMissReason
        : null;
      const recognizedToolChangeCause = recognizedReason === "tools_changed"
        && typeof snapshot.cacheToolChangeCause === "string"
        && CACHE_TOOL_CHANGE_CAUSES.has(snapshot.cacheToolChangeCause)
        ? snapshot.cacheToolChangeCause
        : null;
      if (previousRefillCount < CACHE_EVENT_RULES.maximumAgentRefillCount) {
        const occurrences = possibleFullRefillOccurrencesByActor.get(snapshot.actorId) || [];
        occurrences.push({
          observedAt: snapshot.timestamp,
          reason: recognizedReason,
          toolChangeAttribution: recognizedToolChangeCause ? {
            cause: recognizedToolChangeCause,
            changes: CACHE_TOOL_CHANGE_CAUSES.get(recognizedToolChangeCause).map((change) => ({ ...change })),
          } : null,
        });
        possibleFullRefillOccurrencesByActor.set(snapshot.actorId, occurrences);
      }
      if (
        previousRefillCount < CACHE_EVENT_RULES.maximumAgentRefillCount
        && recognizedReason
      ) {
        const reasons = possibleFullRefillReasonsByActor.get(snapshot.actorId) || new Map();
        reasons.set(recognizedReason, Math.min(
          CACHE_EVENT_RULES.maximumAgentRefillCount,
          (reasons.get(recognizedReason) || 0) + 1,
        ));
        possibleFullRefillReasonsByActor.set(snapshot.actorId, reasons);
      }
      if (
        previousRefillCount < CACHE_EVENT_RULES.maximumAgentRefillCount
        && recognizedToolChangeCause
      ) {
        const attributions = possibleToolChangeAttributionsByActor.get(snapshot.actorId) || new Map();
        attributions.set(recognizedToolChangeCause, Math.min(
          CACHE_EVENT_RULES.maximumAgentRefillCount,
          (attributions.get(recognizedToolChangeCause) || 0) + 1,
        ));
        possibleToolChangeAttributionsByActor.set(snapshot.actorId, attributions);
      }
    }
    const missRefill = possibleFullRefill && gapMs >= CACHE_EVENT_RULES.minimumMissGapMs;

    let emitted = null;
    if (missRefill) {
      const id = opaqueId(sessionId, snapshot, "miss_refill");
      emitted = eventFrom(snapshot, "miss_refill", parts, {
        id,
        previousCacheReadPercent: Math.round(previous.parts.cacheReadShare * 100),
        gapMs,
      });
      events.push(emitted);
      trackedRefillByActor.set(snapshot.actorId, { id, observedAt, group, model });
    } else if (parts.cacheWrite >= CACHE_EVENT_RULES.minimumCacheWriteTokens) {
      const id = opaqueId(sessionId, snapshot, "refill");
      emitted = eventFrom(snapshot, "refill", parts, { id });
      events.push(emitted);
      trackedRefillByActor.set(snapshot.actorId, { id, observedAt, group, model });
    } else {
      const tracked = trackedRefillByActor.get(snapshot.actorId);
      const trackedComparable = tracked
        && group !== null
        && group === tracked.group
        && model.length > 0
        && model === tracked.model
        && !hasCompactionBetween(compactions, snapshot.actorId, tracked.observedAt, observedAt);
      if (trackedComparable
        && parts.promptInputTokens >= CACHE_EVENT_RULES.minimumPromptInputTokens
        && parts.cacheReadShare >= CACHE_EVENT_RULES.minimumReuseReadShare) {
        const id = opaqueId(sessionId, snapshot, "reuse");
        emitted = eventFrom(snapshot, "reuse", parts, {
          id,
          gapMs: observedAt - tracked.observedAt,
          relatedEventId: tracked.id,
        });
        events.push(emitted);
        trackedRefillByActor.delete(snapshot.actorId);
      } else if (tracked && (!trackedComparable || group !== tracked.group || model !== tracked.model)) {
        trackedRefillByActor.delete(snapshot.actorId);
      }
    }

    previousByActor.set(snapshot.actorId, { observedAt, group, model, parts });
  }

  const capped = events
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt) || left.id.localeCompare(right.id))
    .slice(0, CACHE_EVENT_RULES.maximumSessionEvents);
  const retainedIds = new Set(capped.map((event) => event.id));
  return {
    status: "ready",
    items: capped.filter((event) => (
      event.kind !== "reuse"
      || (event.relatedEventId !== null && retainedIds.has(event.relatedEventId))
    )),
    possibleFullRefills: [...possibleFullRefillsByActor]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([agentId, refillCount]) => ({
        agentId,
        count: refillCount,
        occurrences: (possibleFullRefillOccurrencesByActor.get(agentId) || []).map((occurrence) => ({
          ...occurrence,
          toolChangeAttribution: occurrence.toolChangeAttribution ? {
            ...occurrence.toolChangeAttribution,
            changes: occurrence.toolChangeAttribution.changes.map((change) => ({ ...change })),
          } : null,
        })),
        reasons: [...(possibleFullRefillReasonsByActor.get(agentId) || new Map())]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([reason, count]) => ({ reason, count })),
        toolChangeAttributions: [...(possibleToolChangeAttributionsByActor.get(agentId) || new Map())]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([cause, count]) => ({
            cause,
            count,
            changes: CACHE_TOOL_CHANGE_CAUSES.get(cause).map((change) => ({ ...change })),
          })),
      })),
  };
}
