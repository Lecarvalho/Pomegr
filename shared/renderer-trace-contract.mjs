export const RENDERER_TRACE_VERSION = 1;
export const RENDERER_TRACE_STAGES = Object.freeze([
  "renderer_event", "renderer_fetch", "renderer_react_commit", "renderer_next_frame",
]);
export const RENDERER_TRACE_DOMAINS = Object.freeze(["catalog", "activity", "requests"]);

const STAGES = new Set(RENDERER_TRACE_STAGES);
const DOMAINS = new Set(RENDERER_TRACE_DOMAINS);
const MAX_RECORDS = 16;
const MAX_DURATION_MS = 60_000;
export const RENDERER_TRACE_MAX_CALIBRATION_RTT_MS = 1_000;
export const RENDERER_TRACE_MAX_MONOTONIC_MS = 86_400_000;
const TOKEN = /^r[a-f0-9]{16}_[1-9][0-9]{0,15}$/u;

function finiteMonotonic(value) {
  return Number.isFinite(value) && value >= 0 && value <= RENDERER_TRACE_MAX_MONOTONIC_MS;
}

/** Strictly normalize fixed browser timings and one request-bound calibration interval. */
export function normalizeRendererTracePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.records)
    || value.records.length > MAX_RECORDS || Object.keys(value).some((key) => !["records", "calibration"].includes(key))) return null;
  const calibration = value.calibration;
  if (!calibration || typeof calibration !== "object" || Array.isArray(calibration)
    || Object.keys(calibration).some((key) => !["requestStartedMs", "responseReceivedMs"].includes(key))
    || !finiteMonotonic(calibration.requestStartedMs) || !finiteMonotonic(calibration.responseReceivedMs)
    || calibration.responseReceivedMs < calibration.requestStartedMs
    || calibration.responseReceivedMs - calibration.requestStartedMs > RENDERER_TRACE_MAX_CALIBRATION_RTT_MS) return null;
  const records = [];
  for (const record of value.records) {
    if (!record || typeof record !== "object" || Array.isArray(record)
      || Object.keys(record).some((key) => !["stage", "domain", "token", "durationMs", "startedAtMs", "endedAtMs"].includes(key))
      || !STAGES.has(record.stage) || !DOMAINS.has(record.domain) || !TOKEN.test(record.token)
      || !Number.isFinite(record.durationMs) || record.durationMs < 0 || record.durationMs > MAX_DURATION_MS
      || !finiteMonotonic(record.startedAtMs) || !finiteMonotonic(record.endedAtMs)
      || record.endedAtMs < record.startedAtMs || record.endedAtMs - record.startedAtMs > MAX_DURATION_MS
      || Math.round(record.endedAtMs - record.startedAtMs) !== Math.round(record.durationMs)) return null;
    records.push(Object.freeze({ stage: record.stage, domain: record.domain, token: record.token,
      durationMs: Math.round(record.durationMs), startedAtMs: record.startedAtMs, endedAtMs: record.endedAtMs }));
  }
  return Object.freeze({ calibration: Object.freeze({ requestStartedMs: calibration.requestStartedMs, responseReceivedMs: calibration.responseReceivedMs }), records: Object.freeze(records) });
}
