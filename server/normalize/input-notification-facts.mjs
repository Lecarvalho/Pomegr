// The question clock is a private catalog fact, separate from last activity.
// It cannot enter JSON, disk catalogs, provider schemas or browser responses.
const questionTimes = new WeakMap();
/** @template T @param {T} value @param {unknown} observedAt @returns {T} */
export function withInputNotificationTime(value, observedAt) {
  if (value && typeof value === "object" && typeof observedAt === "string"
    && Number.isFinite(Date.parse(observedAt)) && new Date(observedAt).toISOString() === observedAt) {
    questionTimes.set(value, observedAt);
  }
  return value;
}
/** @param {unknown} value @returns {string | null} */
export function inputNotificationTime(value) {
  return value && typeof value === "object" ? questionTimes.get(value) ?? null : null;
}
/** @template T @param {unknown} source @param {T} target @returns {T} */
export function copyInputNotificationTime(source, target) {
  return withInputNotificationTime(target, inputNotificationTime(source));
}
