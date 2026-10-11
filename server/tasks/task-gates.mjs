// The start gates: what must hold before Pomegr starts a session for a task.

import { isTaskId, TASK_PROVIDERS } from "./task-record.mjs";

// The usage a provider may have reached, in percent of its five-hour window, before no new session starts on it.
export const TASK_GATE_THRESHOLDS = Object.freeze([70, 85, 95]);
export const DEFAULT_TASK_GATE_THRESHOLD = 85;
// Why a start is held, in the order they are reported.
export const TASK_GATE_REASONS = Object.freeze([
  "previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown",
  "before_queue_start", "after_queue_stop",
]);
export const TASK_GATE_PROVIDER_FACTS = Object.freeze(["operational", "incident"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeGateThreshold(value) {
  return TASK_GATE_THRESHOLDS.includes(value) ? value : undefined;
}

const percent = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null);

function usageReading(fact, threshold) {
  const fiveHourPercent = isRecord(fact) ? percent(fact.fiveHourPercent) : null;
  const sevenDayPercent = isRecord(fact) ? percent(fact.sevenDayPercent) : null;
  const status = fiveHourPercent === null ? "unknown" : fiveHourPercent < threshold ? "ok" : "over";
  return { status, fiveHourPercent, sevenDayPercent };
}

const providerReading = (fact) => (fact === "operational" ? "ok" : fact === "incident" ? "incident" : "unknown");

// The gates that do not depend on a task.
export function gateReadings(facts, settings) {
  const known = isRecord(facts) ? facts : {};
  const threshold = normalizeGateThreshold(isRecord(settings) ? settings.threshold : undefined) ?? DEFAULT_TASK_GATE_THRESHOLD;
  const usage = isRecord(known.usage) ? known.usage : {};
  const status = isRecord(known.providerStatus) ? known.providerStatus : {};
  return {
    threshold,
    usage: Object.fromEntries(TASK_PROVIDERS.map((provider) => [provider, usageReading(usage[provider], threshold)])),
    providerStatus: Object.fromEntries(TASK_PROVIDERS.map((provider) => [provider, providerReading(status[provider])])),
    workingTree: known.treeClean === true ? "clean" : known.treeClean === false ? "dirty" : "unknown",
  };
}

// Whether one task may start.
export function evaluateGates(task, facts, settings) {
  const readings = gateReadings(facts, settings);
  const record = isRecord(task) ? task : {};
  const provider = TASK_PROVIDERS.includes(record.provider) ? record.provider : null;
  const usage = provider === null ? "unknown" : readings.usage[provider].status;
  const status = provider === null ? "unknown" : readings.providerStatus[provider];
  const reasons = [];
  // A blocker that is not a task ID is still a blocker: the rule never drops a hold it was handed.
  if (record.blockedBy !== null && record.blockedBy !== undefined) reasons.push("previous_step");
  if (usage !== "ok") reasons.push(usage === "over" ? "usage_over" : "usage_unknown");
  if (status !== "ok") reasons.push(status === "incident" ? "provider_incident" : "provider_status_unknown");
  if (readings.workingTree !== "clean") reasons.push(readings.workingTree === "dirty" ? "tree_dirty" : "tree_unknown");
  return { ok: reasons.length === 0, reasons };
}

export function queueGates(next, facts, settings) {
  const readings = gateReadings(facts, settings);
  if (!isRecord(next) || !isTaskId(next.taskId) || !TASK_PROVIDERS.includes(next.provider)) return { ...readings, next: null };
  const { reasons } = evaluateGates(next, facts, settings);
  return { ...readings, next: { taskId: next.taskId, provider: next.provider, blockedBy: isTaskId(next.blockedBy) ? next.blockedBy : null, reasons } };
}
