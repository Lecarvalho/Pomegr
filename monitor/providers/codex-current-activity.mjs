import { codexTimestamp } from "./codex-session-metadata.mjs";
import { codexTurnBoundary } from "./codex-turn-lifecycle.mjs";

export const CODEX_CURRENT_ACTIVITY_MAX_LENGTH = 160;

function boundedActivityLabel(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return null;
  const match = value.match(/^\*\*([^*](?:.*[^*])?)\*\*$/);
  if (!match) return null;
  const normalized = match[1]
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return [...normalized].slice(0, CODEX_CURRENT_ACTIVITY_MAX_LENGTH).join("");
}

function activityLabels(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return [];
  if (record.type === "event_msg" && payload.type === "agent_reasoning") {
    const label = boundedActivityLabel(payload.text);
    return label ? [label] : [];
  }
  if (record.type !== "response_item" || payload.type !== "reasoning" || !Array.isArray(payload.summary)) return [];
  return payload.summary.flatMap((item) => {
    if (!item || typeof item !== "object" || item.type !== "summary_text") return [];
    const label = boundedActivityLabel(item.text);
    return label ? [label] : [];
  });
}


/** Activity is observed metadata. A liveness guess must never poison its incremental reducer. */
export function parseCodexCurrentActivityStateRecords(records, options = {}) {
  const previous = options.existingState || {};
  let currentActivity = previous.currentActivity || null;
  let turnOpen = previous.turnOpen !== false;
  let turnId = previous.turnId || null;
  let boundaryAt = previous.boundaryAt || null;
  for (const record of Array.isArray(records) ? records : []) {
    const observedAt = codexTimestamp(record?.timestamp);
    if (!observedAt || (boundaryAt && observedAt < boundaryAt)) continue;
    const boundary = codexTurnBoundary(record);
    if (boundary) {
      if (boundary.kind === "end" && boundary.turnId && turnId && boundary.turnId !== turnId) continue;
      if (boundary.kind === "start" && boundary.turnId === turnId && !turnOpen && turnId) continue;
      if (boundary.kind === "start" && turnOpen && boundary.turnId && boundary.turnId === turnId) continue;
      turnId = boundary.turnId || turnId;
      boundaryAt = boundary.observedAt;
      currentActivity = null;
      turnOpen = boundary.kind === "start";
      continue;
    }
    if (!turnOpen) continue;
    for (const label of activityLabels(record)) {
      if (currentActivity && observedAt < currentActivity.observedAt) continue;
      currentActivity = { label, observedAt };
    }
  }
  const lifecycle = options.lifecycle;
  const confirmedIdle = lifecycle?.evidence === "observed" && lifecycle.freshness === "current"
    && ["idle", "finished", "stopped"].includes(options.agentStatus)
    && (!currentActivity || (lifecycle.confirmedAt || lifecycle.observedAt) >= currentActivity.observedAt);
  // Without qualified evidence, an idle/unknown status is not a terminal event.
  // Rendering can label a retained heading as last observed when certainty is lost.
  if (options.historical || confirmedIdle) currentActivity = null;
  return { currentActivity, turnOpen, turnId, boundaryAt };
}

export function parseCodexCurrentActivityRecords(records, options = {}) {
  return parseCodexCurrentActivityStateRecords(records, options).currentActivity;
}
