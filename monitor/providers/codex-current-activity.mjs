import { codexTimestamp } from "./codex-session-metadata.mjs";

export const CODEX_CURRENT_ACTIVITY_MAX_LENGTH = 160;

const TERMINAL_EVENT_TYPES = new Set([
  "task_complete",
  "task_completed",
  "task_failed",
  "task_interrupted",
  "turn_aborted",
  "turn_complete",
  "turn_completed",
  "turn_failed",
  "turn_interrupted",
]);

const TERMINAL_AGENT_STATUSES = new Set(["finished", "stopped"]);

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

function terminalRecord(record) {
  const payload = record?.payload;
  if (record?.type === "turn_completed" || record?.type === "turn/completed") return true;
  if (record?.type !== "event_msg") return false;
  return TERMINAL_EVENT_TYPES.has(String(payload?.type || "").toLowerCase());
}

function turnStartRecord(record) {
  return record?.type === "turn_context"
    || record?.type === "turn/started"
    || record?.type === "turn_started";
}

function initialActivityState(value) {
  if (!value || typeof value !== "object") return { currentActivity: null, turnOpen: true };
  const currentActivity = value.currentActivity;
  const observedAt = codexTimestamp(currentActivity?.observedAt);
  return {
    currentActivity: currentActivity && typeof currentActivity.label === "string" && observedAt
      ? { label: currentActivity.label, observedAt }
      : null,
    turnOpen: value.turnOpen !== false,
  };
}

/**
 * Reduce the available rollout records into carry-forward live activity state.
 * Existing state contains only monitor-normalized metadata from an earlier
 * generation of the same append-only rollout.
 */
export function parseCodexCurrentActivityStateRecords(records, options = {}) {
  if (options.historical
    || TERMINAL_AGENT_STATUSES.has(options.agentStatus)
    || (options.agentStatus === "idle" && !options.rolloutHeuristicIdle)) {
    return { currentActivity: null, turnOpen: false };
  }
  let { currentActivity, turnOpen } = initialActivityState(options.existingState);
  for (const record of Array.isArray(records) ? records : []) {
    if (terminalRecord(record)) {
      currentActivity = null;
      turnOpen = false;
      continue;
    }
    if (turnStartRecord(record)) {
      currentActivity = null;
      turnOpen = true;
      continue;
    }
    if (!turnOpen) continue;
    const observedAt = codexTimestamp(record?.timestamp);
    if (!observedAt) continue;
    for (const label of activityLabels(record)) {
      if (currentActivity?.label === label && currentActivity.observedAt === observedAt) continue;
      currentActivity = { label, observedAt };
    }
  }
  return { currentActivity, turnOpen };
}

/**
 * Extract the latest provider-authored UI activity summary for one Codex agent.
 * This intentionally recognizes only the paired rollout shapes Codex uses for
 * its visible one-line reasoning heading. Arbitrary reasoning remains private.
 */
export function parseCodexCurrentActivityRecords(records, options = {}) {
  return parseCodexCurrentActivityStateRecords(records, options).currentActivity;
}
