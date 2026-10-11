export function qualifiedSessionId(providerId, localSessionId) { return `${providerId}:${localSessionId}`; }

// Returns the original string when it parses as a date, otherwise null.
export function parseableTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

export function isoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

export function isoTimestampFromDateInput(value) {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function collapsedText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
  return text || fallback;
}
