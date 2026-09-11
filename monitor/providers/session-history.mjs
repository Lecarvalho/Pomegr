import crypto from "node:crypto";
import { buildRequestSnapshots } from "../request-snapshots.mjs";
import { shellFailureActivityEvents } from "../activity-events.mjs";

function opaque(prefix, sessionId, agentId, nativeId) {
  return `${prefix}-${crypto.createHash("sha256").update(`${sessionId}|${agentId || ""}|${nativeId}`).digest("hex").slice(0, 16)}`;
}

/**
 * Convert complete provider-owned activity acquisition into rows that can be
 * served before request evidence has settled.  The row identity deliberately
 * does not include request correlation or a terminal result, so later
 * enrichment replaces the same row instead of making a second activity item.
 */
export function normalizedSessionActivity(providerId, sessionId, evidence) {
  const labels = new Map(); for (const agent of evidence?.agents || []) labels.set(agent.label, [...(labels.get(agent.label) || []), agent.id]);
  const failures = (evidence?.agents || []).flatMap((agent) => shellFailureActivityEvents(agent.executionTasks, agent.label).map((item) => ({ ...item, _historyAgentId: agent.id })));
  const rows = [...(evidence?.activity || []), ...(evidence?.toolCalls || []), ...failures].flatMap((item, index) => {
    const agentId = item.actor?.id || item._historyAgentId || (labels.get(item.actor)?.length === 1 ? labels.get(item.actor)[0] : null);
    const actor = item.actor?.label || item.actor || "System";
    if (!item?.timestamp || !item?.tool || typeof item.detail !== "string") return [];
    return [{
      id: opaque("history", `${providerId}:${sessionId}`, agentId, item.id || `${item.timestamp}:${index}`),
      timestamp: item.timestamp, actor, tool: item.tool, workKind: item.workKind || "generic", detail: item.detail,
      status: item.status === "failed" ? "failed" : null,
      durationMs: Number.isSafeInteger(item.durationMs) ? item.durationMs : null,
      requestId: typeof item.requestId === "string" ? item.requestId : null, agentId,
    }];
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...byId.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
}

/** Convert a complete adapter-private evidence replay into history-safe rows. */
export function normalizedSessionHistory(providerId, sessionId, evidence) {
  if (!evidence) return { requests: [], activity: [], complete: false };
  const requestIdByOldId = new Map();
  const requests = buildRequestSnapshots({ sessionId: `${providerId}:${sessionId}`, agents: evidence.agents, usageSnapshots: evidence.usageSnapshots, unlimited: true }).items;
  for (const request of requests) requestIdByOldId.set(request.id, request.id);
  const activity = normalizedSessionActivity(providerId, sessionId, evidence)
    .map((item) => ({ ...item, requestId: requestIdByOldId.get(item.requestId) || null }));
  return { requests, activity, complete: true };
}

/** Keep adapter callback failures isolated from complete source normalization. */
export function publishNormalizedHistoryActivity(callback, providerId, sessionId, evidence) {
  if (typeof callback !== "function") return false;
  try { callback(normalizedSessionActivity(providerId, sessionId, evidence)); return true; } catch { return false; }
}

/** Publish strict request correlation and Activity enrichment from shared U1 evidence. */
export function publishNormalizedHistoryRequests(callback, providerId, sessionId, evidence) {
  if (typeof callback !== "function") return false;
  try { callback(normalizedSessionHistory(providerId, sessionId, evidence)); return true; } catch { return false; }
}
