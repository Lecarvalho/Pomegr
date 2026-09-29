import { normalizeSchemaValidationSummary, summarizeSchemaValidationFailure } from "./pipeline-operations-validation.mjs";

// These are operational classifications, never exception text or source identity.
const FAILURE_STAGES = Object.freeze({
  acquisitionFailures: ["acquire_normalize", "source_preparation", "worker_yield", "session_publication"],
  catalogReadFailures: ["catalog_discovery"],
  catalogEntriesRejected: ["catalog_validation"],
  readinessProbeFailures: ["readiness_probe"],
  sessionReadFailures: ["session_read"],
  sessionEvidenceRejected: ["evidence_validation"],
  observerStartFailures: ["observer_start"],
  observerHydrationFailures: ["explicit_hydration"],
  observerPublicationRejected: ["publication", "catalog_publication", "session_publication", "invalidation", "checkpoint_read"],
});

export const PROVIDER_FAILURE_COUNTERS = Object.freeze(Object.keys(FAILURE_STAGES)
  .filter((category) => category !== "acquisitionFailures"));

const ERROR_CODES = new Set([
  "ENOENT", "EACCES", "EPERM", "EBUSY", "EMFILE", "ENFILE", "ENOMEM", "ENOSPC",
  "EIO", "ENOTDIR", "EISDIR", "ETIMEDOUT", "ECONNRESET", "ABORT_ERR",
]);
const FAILURE_REASONS = new Set([...ERROR_CODES, "SyntaxError", "TypeError", "RangeError", "schema_validation", "unknown"]);

function failureReason(error) {
  // Never inspect messages, stacks, causes, paths, or arbitrary error names.
  try {
    const code = error?.code;
    if (ERROR_CODES.has(code)) return code;
    if (error instanceof SyntaxError) return "SyntaxError";
    if (error instanceof TypeError) return "TypeError";
    if (error instanceof RangeError) return "RangeError";
  } catch { /* Even a throwing code accessor must not break failure isolation. */ }
  return "unknown";
}

/** At most one latest observation per fixed counter; this is not an event log. */
export function normalizePipelineFailureDetails(value) {
  const result = {};
  for (const [category, stages] of Object.entries(FAILURE_STAGES)) {
    const detail = value?.[category];
    if (!detail || !stages.includes(detail.stage)) continue;
    const timestamp = typeof detail.observedAt === "string" && detail.observedAt.length <= 32
      ? Date.parse(detail.observedAt) : NaN;
    result[category] = Object.freeze({
      stage: detail.stage,
      reason: FAILURE_REASONS.has(detail.reason) ? detail.reason : "unknown",
      observedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
      ...(detail.reason === "schema_validation" ? { validation: normalizeSchemaValidationSummary(detail.validation) } : {}),
    });
  }
  return Object.freeze(result);
}

export function createPipelineFailureRecorder({ now = Date.now } = {}) {
  const details = {};
  return Object.freeze({
    record(category, error, stage = FAILURE_STAGES[category]?.[0]) {
      if (!Object.hasOwn(FAILURE_STAGES, category) || !FAILURE_STAGES[category].includes(stage)) return;
      const time = now();
      const validation = summarizeSchemaValidationFailure(error);
      details[category] = Object.freeze({
        stage,
        reason: validation ? "schema_validation" : failureReason(error),
        observedAt: Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null,
        ...(validation ? { validation } : {}),
      });
    },
    snapshot: () => normalizePipelineFailureDetails(details),
  });
}
