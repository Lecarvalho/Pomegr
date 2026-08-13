export const SIGNAL_MAX_LABEL_LENGTH = 20;
export const SIGNAL_MAX_DESCRIPTION_LENGTH = 160;
export const SIGNAL_TONES = ["neutral", "info", "positive", "warning", "negative"];

const toneSet = new Set(SIGNAL_TONES);
const describedKeys = new Set(["label", "tone", "description"]);
const taskKeys = new Set(["task_id", "label", "tone"]);
const safeTaskId = /^[a-zA-Z0-9_-]{1,128}$/;

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
