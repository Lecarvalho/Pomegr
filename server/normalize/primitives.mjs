/** Small value normalizers shared across server layers. Each helper keeps one exact behavior. */
/** Provider-qualified session key, for example `claude:<local id>`. */
export function qualifiedSessionId(providerId, localSessionId) { return `${providerId}:${localSessionId}`; }

/** Returns the original string when it parses as a date, otherwise null. */
export function parseableTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

/** Normalizes a parseable date string to ISO 8601; non-strings and invalid dates become null. */
export function isoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

/** Normalizes anything the Date constructor accepts (string, number, Date) to ISO 8601, or null. */
export function isoTimestampFromDateInput(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Replaces control characters, collapses whitespace, trims, and truncates; non-strings become the fallback. */
export function collapsedText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return text || fallback;
}
