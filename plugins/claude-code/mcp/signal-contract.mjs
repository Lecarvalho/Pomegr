export const SIGNAL_MAX_LABEL_LENGTH = 20;
export const SIGNAL_MAX_DESCRIPTION_LENGTH = 160;
export const SIGNAL_TONES = ["neutral", "info", "positive", "warning", "negative"];
export const SESSION_PROGRESS_PHASES = ["planning", "implementing", "verifying", "blocked", "complete"];
export const SESSION_PROGRESS_CONFIDENCES = ["low", "medium", "high"];

const toneSet = new Set(SIGNAL_TONES);
const describedKeys = new Set(["label", "tone", "description"]);
const taskKeys = new Set(["task_id", "label", "tone"]);
const safeTaskId = /^[a-zA-Z0-9_-]{1,128}$/;
const progressKeys = new Set(["phase", "percent", "remaining_minutes_min", "remaining_minutes_max", "confidence"]);
const progressPhases = new Set(SESSION_PROGRESS_PHASES);
const progressConfidences = new Set(SESSION_PROGRESS_CONFIDENCES);

function normalizeSignal(input, allowedKeys) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return null;
  const rawLabel = typeof input.label === "string" ? input.label.trim() : "";
  if (!rawLabel || rawLabel.length > SIGNAL_MAX_LABEL_LENGTH || /[\u0000-\u001f\u007f]/.test(rawLabel)) return null;
  const tone = input.tone === undefined ? "neutral" : input.tone;
  if (!toneSet.has(tone)) return null;
  return { label: rawLabel.replace(/ {2,}/g, " "), tone };
}

export function normalizeDescribedSignal(input) {
  const signal = normalizeSignal(input, describedKeys);
  if (!signal || input.description === undefined) return signal;
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if (!description || description.length > SIGNAL_MAX_DESCRIPTION_LENGTH || /[\u0000-\u001f\u007f]/.test(description)) return null;
  return { ...signal, description: description.replace(/ {2,}/g, " ") };
}

export function normalizeTaskSignal(input) {
  const signal = normalizeSignal(input, taskKeys);
  return signal && typeof input.task_id === "string" && safeTaskId.test(input.task_id)
    ? { taskId: input.task_id, ...signal }
    : null;
}

export function normalizeSessionProgress(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some((key) => !progressKeys.has(key))
    || !progressPhases.has(input.phase)
    || !progressConfidences.has(input.confidence)
    || !Number.isInteger(input.percent) || input.percent < 0 || input.percent > 100) return null;
  const hasMin = input.remaining_minutes_min !== undefined;
  const hasMax = input.remaining_minutes_max !== undefined;
  if (hasMin !== hasMax) return null;
  if (hasMin && (!Number.isInteger(input.remaining_minutes_min) || !Number.isInteger(input.remaining_minutes_max)
    || input.remaining_minutes_min < 0 || input.remaining_minutes_max > 10080
    || input.remaining_minutes_min > input.remaining_minutes_max)) return null;
  if (["blocked", "complete"].includes(input.phase) && (hasMin || hasMax)) return null;
  if (input.phase === "complete" && input.percent !== 100) return null;
  return {
    phase: input.phase,
    percent: input.percent,
    ...(hasMin ? { remainingMinutesMin: input.remaining_minutes_min, remainingMinutesMax: input.remaining_minutes_max } : {}),
    confidence: input.confidence,
    reportedAt: null,
  };
}
