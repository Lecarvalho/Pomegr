// The start gates: what must hold before Pomegr starts a session for a task. This module is pure. It reads no
// store, route, runtime, Git, or provider data; the entry point hands it facts the monitor already committed.
//
// A start needs four things: the step before the task's own is done, the task's provider has usage capacity,
// that provider reports no incident, and the repository's working tree is clean. A fact that is missing is
// unknown, and unknown holds a start exactly like a failed gate: it never counts as passed. The entry point
// supplies only fresh and complete observations and null for everything else; every value is validated again
// here, so a value of the wrong type is unknown too.

import { isTaskId, TASK_PROVIDERS } from "./task-record.mjs";

/** The usage a provider may have reached, in percent of its five-hour window, before no new session starts on it. */
export const TASK_GATE_THRESHOLDS = Object.freeze([70, 85, 95]);
export const DEFAULT_TASK_GATE_THRESHOLD = 85;
/** Why a start is held, in the order they are reported. */
export const TASK_GATE_REASONS = Object.freeze([
  "previous_step", "usage_over", "usage_unknown", "provider_incident", "provider_status_unknown", "tree_dirty", "tree_unknown",
]);
/** What a provider-status fact may say. Anything but `operational` on a fresh observation is `incident`. */
export const TASK_GATE_PROVIDER_FACTS = Object.freeze(["operational", "incident"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** One of the fixed thresholds, or undefined. */
export function normalizeGateThreshold(value) {
  return TASK_GATE_THRESHOLDS.includes(value) ? value : undefined;
}

// A whole percentage as Usage limits shows it, or null.
const percent = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null);

// Capacity is judged on the five-hour window alone; the seven-day reading is shown beside it and decides nothing.
function usageReading(fact, threshold) {
  const fiveHourPercent = isRecord(fact) ? percent(fact.fiveHourPercent) : null;
  const sevenDayPercent = isRecord(fact) ? percent(fact.sevenDayPercent) : null;
  const status = fiveHourPercent === null ? "unknown" : fiveHourPercent < threshold ? "ok" : "over";
  return { status, fiveHourPercent, sevenDayPercent };
}

const providerReading = (fact) => (fact === "operational" ? "ok" : fact === "incident" ? "incident" : "unknown");

/**
 * The gates that do not depend on a task. `facts` is
 * `{ usage: { claude, codex }, providerStatus: { claude, codex }, treeClean }`: each usage entry
 * `{ fiveHourPercent, sevenDayPercent }` or null, each provider status `operational`, `incident`, or null, and
 * `treeClean` true, false, or null. `settings` is `{ threshold }`; anything but a fixed threshold is the default.
 * Returns `{ threshold, usage, providerStatus, workingTree }` in the board contract's shape.
 */
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

/**
 * Whether one task may start. `task` is `{ provider, blockedBy }`: the provider its session runs on, and the ID of
 * the task of an earlier step of its feature that is not done, or null. A task with no recognized provider is held
 * on unknown usage and status. Returns `{ ok, reasons }`, `reasons` in the fixed order of `TASK_GATE_REASONS`.
 */
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

/**
 * The board's `queue.gates`: the readings, and for the task the queue would start next its provider, the earlier
 * task it waits on, and the gates that hold it. `next` is `{ taskId, provider, blockedBy }` or null when no task is
 * queued; a `blockedBy` that is not a task ID is served as null and still holds.
 */
export function queueGates(next, facts, settings) {
  const readings = gateReadings(facts, settings);
  if (!isRecord(next) || !isTaskId(next.taskId) || !TASK_PROVIDERS.includes(next.provider)) return { ...readings, next: null };
  const { reasons } = evaluateGates(next, facts, settings);
  return { ...readings, next: { taskId: next.taskId, provider: next.provider, blockedBy: isTaskId(next.blockedBy) ? next.blockedBy : null, reasons } };
}
