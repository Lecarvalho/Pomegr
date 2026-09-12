import { normalizePipelineOperationsSnapshot } from "./pipeline-operations.mjs";
import { PIPELINE_TRACE_STAGES, PIPELINE_TRACE_DOMAINS, PIPELINE_TRACE_OUTCOMES, PIPELINE_TRACE_COUNTERS } from "./pipeline-trace.mjs";

const stages = new Set(PIPELINE_TRACE_STAGES), domains = new Set(PIPELINE_TRACE_DOMAINS);
const outcomes = new Set(PIPELINE_TRACE_OUTCOMES), counters = new Set(PIPELINE_TRACE_COUNTERS);
const surfaces = new Set(["catalog", "activity", "requests"]);
const finite = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const identifier = (value) => Number.isSafeInteger(value) && value > 0;
const timestamp = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));

/** Rebuild the fixed diagnostic vocabulary before writing or reporting a log record. */
export function normalizePipelineLogRecord(value) {
  if (!value || value.version !== 1 || !timestamp(value.at)
    || typeof value.run !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.run)) return null;
  const result = { version: 1, run: value.run, at: value.at, kind: value.kind };
  const optionalIds = () => {
    for (const key of ["flow", "revision", "scope"]) {
      if (value[key] !== undefined) { if (!identifier(value[key])) return false; result[key] = value[key]; }
    }
    return true;
  };
  switch (value.kind) {
    case "span_start":
    case "span": {
      if (!stages.has(value.stage) || !domains.has(value.domain) || !finite(value.startMs)
        || !identifier(value.lane) || value.lane > 1_024 || !optionalIds()) return null;
      Object.assign(result, { stage: value.stage, domain: value.domain, startMs: value.startMs, lane: value.lane });
      if (value.kind === "span") {
        if (!finite(value.durationMs) || value.durationMs > 86_400_000 || !outcomes.has(value.outcome)) return null;
        Object.assign(result, { durationMs: value.durationMs, outcome: value.outcome });
        if (value.surface !== undefined) { if (!surfaces.has(value.surface)) return null; result.surface = value.surface; }
        if (value.clockErrorMs !== undefined) {
          if (!finite(value.clockErrorMs) || value.clockErrorMs > 1_001) return null;
          result.clockErrorMs = value.clockErrorMs;
        }
      }
      break;
    }
    case "flow":
      if (!["start", "step", "end"].includes(value.phase) || !identifier(value.flow) || !finite(value.startMs)
        || !identifier(value.lane) || value.lane > 1_024 || !outcomes.has(value.outcome) || !optionalIds()) return null;
      Object.assign(result, { phase: value.phase, flow: value.flow, startMs: value.startMs, lane: value.lane, outcome: value.outcome });
      break;
    case "counter":
      if (!counters.has(value.counter) || !finite(value.value) || !finite(value.startMs)) return null;
      Object.assign(result, { counter: value.counter, value: value.value, startMs: value.startMs });
      break;
    case "health":
      try { result.snapshot = normalizePipelineOperationsSnapshot(value.snapshot); } catch { return null; }
      break;
    case "gap":
      if (!["backpressure", "disk_error", "instrumentation_limit"].includes(value.reason)
        || !Number.isSafeInteger(value.droppedRecords) || value.droppedRecords < 0
        || !Number.isSafeInteger(value.rejectedRecords) || value.rejectedRecords < 0) return null;
      Object.assign(result, { reason: value.reason, droppedRecords: value.droppedRecords, rejectedRecords: value.rejectedRecords });
      break;
    case "lifecycle":
      if (!["started", "stopped"].includes(value.event)) return null;
      result.event = value.event;
      break;
    default: return null;
  }
  if (Object.keys(value).some((key) => !Object.hasOwn(result, key))) return null;
  return Object.freeze(result);
}
