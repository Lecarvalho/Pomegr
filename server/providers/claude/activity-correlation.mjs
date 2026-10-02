import { requestSnapshotIdsByEvidence } from "../../normalize/request-snapshots.mjs";
import { normalizedRequestWork } from "../../normalize/request-work.mjs";

/** Usage is the latest snapshot; issued calls span every fragment of that request. */
export function mergeClaudeRequestFragments(previous, next) {
  if (!previous) return next;
  const latest = Date.parse(previous.timestamp) > Date.parse(next.timestamp) ? previous : next;
  const tools = new Map([...(previous.issuedToolUseKinds || []), ...(next.issuedToolUseKinds || [])].map(({ id, kind }) => [id, kind]));
  const retained = [...tools].slice(-4_096);
  const counts = new Map();
  for (const [, kind] of retained) counts.set(kind, (counts.get(kind) || 0) + 1);
  // Calls without a recorded ID cannot be deduplicated across fragments.
  for (const { kind, count } of [...(previous.issuedWork || []), ...(next.issuedWork || [])]) counts.set(kind, Math.max(counts.get(kind) || 0, count));
  const merged = {
    ...latest,
    precedingWork: previous.precedingWork?.length ? previous.precedingWork : next.precedingWork,
    issuedWork: normalizedRequestWork([...counts].map(([kind, count]) => ({ kind, count }))),
    issuedToolUseIds: retained.map(([id]) => id),
    issuedToolUseKinds: retained.map(([id, kind]) => ({ id, kind })),
    precedingUserInputIds: [...new Set([...(previous.precedingUserInputIds || []), ...(next.precedingUserInputIds || [])])].slice(-64),
  };
  // The first fragment recorded when the request was sent; a later fragment's preceding record is
  // not that time, so its value (or absence) never replaces it, including in a live-tail merge.
  if (previous.requestSentAt) merged.requestSentAt = previous.requestSentAt;
  else delete merged.requestSentAt;
  return merged;
}

/** Keep request correlation indexes inside the Claude adapter. */
export function splitClaudeRequestCorrelationEvidence(snapshots) {
  const toolUseIdsByRequest = new Map();
  const replyIdsByRequest = new Map();
  const userInputIdsByRequest = new Map();
  const normalizedSnapshots = [];
  for (const snapshot of snapshots) {
    if (snapshot.replyActivityId) replyIdsByRequest.set(`${snapshot.actorId}\u0000${snapshot.dedupeId}`, snapshot.replyActivityId);
    if (snapshot.precedingUserInputIds?.length) userInputIdsByRequest.set(`${snapshot.actorId}\u0000${snapshot.dedupeId}`, snapshot.precedingUserInputIds);
    if (Array.isArray(snapshot.issuedToolUseIds)) {
      toolUseIdsByRequest.set(`${snapshot.actorId}\u0000${snapshot.dedupeId}`, snapshot.issuedToolUseIds);
    }
    const normalized = { ...snapshot };
    delete normalized.issuedToolUseIds;
    delete normalized.issuedToolUseKinds;
    delete normalized.replyActivityId;
    delete normalized.precedingUserInputIds;
    normalizedSnapshots.push(normalized);
  }
  return { normalizedSnapshots, toolUseIdsByRequest, replyIdsByRequest, userInputIdsByRequest };
}

/** Stamp only opaque served request ids after all valid request evidence is known. */
export function stampClaudeActivityRequestIds({ sessionId, agents, usageSnapshots, toolCalls, activity, toolUseIdsByRequest, replyIdsByRequest, userInputIdsByRequest = new Map(), unlimited = false }) {
  const requestIds = requestSnapshotIdsByEvidence({ sessionId: `claude:${sessionId}`, agents, usageSnapshots, unlimited });
  const requestIdByToolUseId = new Map();
  for (const [key, toolUseIds] of toolUseIdsByRequest) {
    const requestId = requestIds.get(key);
    if (!requestId) continue;
    for (const toolUseId of toolUseIds) requestIdByToolUseId.set(toolUseId, requestId);
  }
  for (const toolCall of toolCalls) toolCall.requestId = requestIdByToolUseId.get(toolCall.id) || null;
  const requestIdByReplyId = new Map();
  for (const [key, replyId] of replyIdsByRequest) {
    const requestId = requestIds.get(key);
    if (requestId) requestIdByReplyId.set(replyId, requestId);
  }
  // A user input belongs to the first request recorded as answering it; a retry never moves it.
  const requestIdByUserInputId = new Map();
  for (const [key, userInputIds] of userInputIdsByRequest) {
    const requestId = requestIds.get(key);
    if (!requestId) continue;
    for (const userInputId of userInputIds) if (!requestIdByUserInputId.has(userInputId)) requestIdByUserInputId.set(userInputId, requestId);
  }
  for (const event of activity) {
    if (event.tool === "Assistant replied") event.requestId = requestIdByReplyId.get(event.id) || null;
    else if (event.tool === "User input" && event.actor === "User") event.requestId = requestIdByUserInputId.get(event.id) || null;
  }
}

export function claudeToolResultTimestamps(records) {
  const results = new Map();
  for (const record of records) {
    if (record?.type !== "user") continue;
    const rawTimestamp = record.timestamp ?? record.message?.timestamp;
    const time = typeof rawTimestamp === "string" ? Date.parse(rawTimestamp) : NaN;
    if (!Number.isFinite(time)) continue;
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      if (part?.type !== "tool_result" || typeof part.tool_use_id !== "string" || !part.tool_use_id) continue;
      const times = results.get(part.tool_use_id) || [];
      times.push(new Date(time).toISOString());
      results.set(part.tool_use_id, times);
    }
  }
  return results;
}

export function firstClaudeToolResultAfter(resultTimes, toolUseId, startedAt) {
  const start = Date.parse(startedAt || "");
  if (!Number.isFinite(start)) return null;
  return (resultTimes.get(toolUseId) || []).find((timestamp) => Date.parse(timestamp) >= start) || null;
}
