import crypto from "node:crypto";
import { buildContextBoundaryEvidence } from "./context-history.mjs";

export const CACHE_READ_DROP_RULES = Object.freeze({
  minimumPromptInputTokens: 8_000,
  minimumPreviousReadShare: 0.8,
  maximumCurrentReadShare: 0.2,
  maximumRetainedReadShare: 0.2,
  maximumAgentCount: 999,
});

function timestampMs(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function parts(snapshot) {
  const values = [snapshot.input, snapshot.cacheRead, snapshot.cacheWrite, snapshot.output];
  if (!values.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const prompt = snapshot.input + snapshot.cacheRead + snapshot.cacheWrite;
  if (!Number.isSafeInteger(prompt) || prompt <= 0) return null;
  return { prompt, readShare: snapshot.cacheRead / prompt };
}

function eligible(snapshot) {
  return snapshot.cacheReadComparable === true
    && typeof snapshot.model === "string" && snapshot.model.length > 0
    && Number.isSafeInteger(snapshot.comparisonGroup) && snapshot.comparisonGroup >= 0
    && timestampMs(snapshot.timestamp) !== null && parts(snapshot) !== null;
}

/**
 * Read-only evidence of lost reuse, NOT a provider-recorded cache write.
 * Adapters must explicitly establish both numeric provenance and adjacency.
 * Missing legacy metadata fails closed; capability flags for write-backed
 * classification, report totals and expiry inference remain untouched.
 */
export function buildCacheReadDrops({
  sessionId = "session", agents = [], usageSnapshots = [], compactions = [], boundaries = [],
} = {}) {
  const visible = new Set(agents.map((agent) => agent.id));
  const unique = new Map();
  const invalidTimeActors = new Set();
  for (const snapshot of usageSnapshots) {
    if (!snapshot || !visible.has(snapshot.actorId)) continue;
    if (timestampMs(snapshot.timestamp) === null || typeof snapshot.dedupeId !== "string" || !snapshot.dedupeId) {
      // An unplaceable observation cannot be silently removed from adjacency.
      invalidTimeActors.add(snapshot.actorId);
      continue;
    }
    const identity = `${snapshot.actorId}\0${snapshot.dedupeId}`;
    const previous = unique.get(identity);
    if (!previous || timestampMs(snapshot.timestamp) >= timestampMs(previous.timestamp)) unique.set(identity, snapshot);
  }
  const observations = [...unique.values()].sort((left, right) => (
    timestampMs(left.timestamp) - timestampMs(right.timestamp) || left.dedupeId.localeCompare(right.dedupeId)
  ));
  const byTime = new Map();
  const ambiguousTimes = new Set();
  for (const snapshot of observations) {
    const key = `${snapshot.actorId}\0${timestampMs(snapshot.timestamp)}`;
    const seen = byTime.get(key);
    if (seen && ["input", "cacheRead", "cacheWrite", "output", "model", "comparisonGroup"].some((field) => seen[field] !== snapshot[field])) {
      ambiguousTimes.add(key);
    }
    byTime.set(key, snapshot);
  }
  // Use all retained boundaries, not the presentation feed's newest 100.
  const resets = [...boundaries, ...buildContextBoundaryEvidence(observations, {
    sessionId, agentIds: [...visible], compactions,
  }), ...compactions.map((item) => ({ agentId: item.actorId ?? item.actor?.id, timestamp: item.timestamp }))];
  const previousByAgent = new Map();
  const results = new Map();
  let available = false;
  for (const current of observations) {
    const agentId = current.actorId;
    if (invalidTimeActors.has(agentId) || ambiguousTimes.has(`${agentId}\0${timestampMs(current.timestamp)}`) || !eligible(current)) {
      previousByAgent.delete(agentId);
      continue;
    }
    available = true;
    const previous = previousByAgent.get(agentId);
    previousByAgent.set(agentId, current);
    if (!previous) continue;
    const beforeAt = timestampMs(previous.timestamp);
    const afterAt = timestampMs(current.timestamp);
    if (afterAt <= beforeAt
      || current.cacheReadPreviousAt !== previous.timestamp
      || previous.model !== current.model
      || previous.comparisonGroup !== current.comparisonGroup
      || resets.some((boundary) => boundary.agentId === agentId
        && timestampMs(boundary.timestamp) >= beforeAt && timestampMs(boundary.timestamp) <= afterAt)) continue;
    const before = parts(previous);
    const after = parts(current);
    if (before.prompt < CACHE_READ_DROP_RULES.minimumPromptInputTokens
      || after.prompt < CACHE_READ_DROP_RULES.minimumPromptInputTokens
      || before.readShare < CACHE_READ_DROP_RULES.minimumPreviousReadShare
      || after.readShare > CACHE_READ_DROP_RULES.maximumCurrentReadShare
      || current.cacheRead > previous.cacheRead * CACHE_READ_DROP_RULES.maximumRetainedReadShare
      || current.cacheWrite !== 0) continue;
    const summary = results.get(agentId) || { agentId, count: 0, occurrences: [] };
    if (summary.count >= CACHE_READ_DROP_RULES.maximumAgentCount) continue;
    summary.count += 1;
    summary.occurrences.push({
      id: `cache-read-drop-${crypto.createHash("sha256")
        .update(`${sessionId}|${agentId}|${current.dedupeId}|${current.timestamp}`).digest("hex").slice(0, 16)}`,
      observedAt: new Date(afterAt).toISOString(),
      previousCacheReadPercent: Math.round(before.readShare * 1_000) / 10,
      cacheReadPercent: Math.round(after.readShare * 1_000) / 10,
      gapMs: afterAt - beforeAt,
    });
    results.set(agentId, summary);
  }
  return { status: available ? "ready" : "unavailable", items: [...results.values()].sort((left, right) => left.agentId.localeCompare(right.agentId)) };
}
