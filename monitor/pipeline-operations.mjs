const MAX_DURATION_MS = 24 * 60 * 60_000;
const DEFAULT_WINDOW_SIZE = 256;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const PIPELINE_OPERATIONS_VERSION = 1;

function boundedInteger(value, maximum = MAX_COUNTER) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

/** Bounded, value-only duration window. It never retains source or session identity. */
export function createDurationSeries({ windowSize = DEFAULT_WINDOW_SIZE } = {}) {
  const limit = Number.isInteger(windowSize) && windowSize > 0 && windowSize <= 4_096
    ? windowSize
    : DEFAULT_WINDOW_SIZE;
  const values = [];
  let sampleCount = 0;

  return Object.freeze({
    record(value) {
      const durationMs = boundedInteger(value, MAX_DURATION_MS);
      sampleCount = Math.min(MAX_COUNTER, sampleCount + 1);
      values.push(durationMs);
      if (values.length > limit) values.splice(0, values.length - limit);
      return durationMs;
    },
    snapshot() {
      const sorted = [...values].sort((left, right) => left - right);
      const total = values.reduce((sum, value) => sum + value, 0);
      return Object.freeze({
        sampleCount,
        windowCount: values.length,
        lastMs: values.at(-1) || 0,
        averageMs: values.length ? Math.round(total / values.length) : 0,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) || 0,
      });
    },
  });
}

function durationSnapshot(value) {
  return Object.freeze({
    sampleCount: boundedInteger(value?.sampleCount),
    windowCount: boundedInteger(value?.windowCount, 4_096),
    lastMs: boundedInteger(value?.lastMs, MAX_DURATION_MS),
    averageMs: boundedInteger(value?.averageMs, MAX_DURATION_MS),
    p50Ms: boundedInteger(value?.p50Ms, MAX_DURATION_MS),
    p95Ms: boundedInteger(value?.p95Ms, MAX_DURATION_MS),
    maxMs: boundedInteger(value?.maxMs, MAX_DURATION_MS),
  });
}

function counters(source, keys) {
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, boundedInteger(source?.[key])])));
}

const OBSERVER_COUNTERS = Object.freeze([
  "reconciliationRuns",
  "watcherWakeups",
  "routedSourceEvents",
  "unresolvedSourceEvents",
  "hydrationAttempts",
  "hydrationsQueued",
  "hydrationsCoalesced",
  "hydrationDirtyAgain",
  "candidatesPublished",
  "acquisitionFailures",
]);

const PROVIDER_FAILURE_COUNTERS = Object.freeze([
  "catalogReadFailures",
  "catalogEntriesRejected",
  "readinessProbeFailures",
  "sessionReadFailures",
  "sessionEvidenceRejected",
  "observerStartFailures",
  "observerHydrationFailures",
  "observerPublicationRejected",
]);

/** Build the fixed monitor-private payload consumed by the terminal operations client. */
export function createPipelineOperationsSnapshot(diagnostics, observedAt = new Date().toISOString()) {
  const coordinator = diagnostics?.coordinator || {};
  const observers = coordinator.observers && typeof coordinator.observers === "object"
    ? coordinator.observers
    : {};
  const providerFailures = diagnostics?.providers && typeof diagnostics.providers === "object"
    ? diagnostics.providers
    : {};
  const providerIds = [...new Set([...Object.keys(observers), ...Object.keys(providerFailures)])]
    .filter((providerId) => PROVIDER_ID_PATTERN.test(providerId))
    .sort()
    .slice(0, 16);
  const timestamp = Number.isFinite(Date.parse(observedAt)) ? new Date(observedAt).toISOString() : null;

  return Object.freeze({
    version: PIPELINE_OPERATIONS_VERSION,
    observedAt: timestamp,
    revisions: counters(diagnostics?.responseRevisions, ["catalog", "home", "usageLimits"]),
    catalog: Object.freeze({
      counters: counters(coordinator, ["catalogStructuralFastPaths"]),
      timings: Object.freeze({
        commitWait: durationSnapshot(coordinator.timings?.catalogCommitWait),
        projectionCommit: durationSnapshot(coordinator.timings?.catalogProjectionCommit),
      }),
    }),
    session: Object.freeze({
      counters: counters(coordinator, [
        "sessionCandidates",
        "sessionCommits",
        "unchangedCandidates",
        "rejectedCandidates",
        "cacheHits",
        "cacheMisses",
        "invalidations",
      ]),
      timings: Object.freeze({
        commitWait: durationSnapshot(coordinator.timings?.sessionCommitWait),
        derivation: durationSnapshot(coordinator.timings?.sessionDerivation),
        storeCommit: durationSnapshot(coordinator.timings?.sessionStoreCommit),
        candidateToCommit: durationSnapshot(coordinator.timings?.sessionCandidateToCommit),
      }),
    }),
    providers: Object.freeze(providerIds.map((providerId) => {
      const observer = observers[providerId] || {};
      return Object.freeze({
        id: providerId,
        workers: Object.freeze({
          capacity: boundedInteger(observer.hydrationConcurrency, 16),
          active: boundedInteger(observer.activeHydrations, 16),
          pending: boundedInteger(observer.pendingHydrations, 100_000),
        }),
        counters: counters(observer, OBSERVER_COUNTERS),
        failures: counters(providerFailures[providerId], PROVIDER_FAILURE_COUNTERS),
        timings: Object.freeze({
          catalogDiscovery: durationSnapshot(observer.timings?.catalogDiscovery),
          queueWait: durationSnapshot(observer.timings?.queueWait),
          preparation: durationSnapshot(observer.timings?.preparation),
          acquisitionNormalization: durationSnapshot(observer.timings?.acquisitionNormalization),
        }),
      });
    })),
  });
}

/** Re-allowlist an IPC payload so a local endpoint collision cannot widen CLI output. */
export function normalizePipelineOperationsSnapshot(value) {
  if (value?.version !== PIPELINE_OPERATIONS_VERSION || !Array.isArray(value.providers)) {
    throw new TypeError("Pipeline operations snapshot is unavailable");
  }
  const observedAt = Number.isFinite(Date.parse(value.observedAt)) ? new Date(value.observedAt).toISOString() : null;
  return Object.freeze({
    version: PIPELINE_OPERATIONS_VERSION,
    observedAt,
    revisions: counters(value.revisions, ["catalog", "home", "usageLimits"]),
    catalog: Object.freeze({
      counters: counters(value.catalog?.counters, ["catalogStructuralFastPaths"]),
      timings: Object.freeze({
        commitWait: durationSnapshot(value.catalog?.timings?.commitWait),
        projectionCommit: durationSnapshot(value.catalog?.timings?.projectionCommit),
      }),
    }),
    session: Object.freeze({
      counters: counters(value.session?.counters, [
        "sessionCandidates",
        "sessionCommits",
        "unchangedCandidates",
        "rejectedCandidates",
        "cacheHits",
        "cacheMisses",
        "invalidations",
      ]),
      timings: Object.freeze({
        commitWait: durationSnapshot(value.session?.timings?.commitWait),
        derivation: durationSnapshot(value.session?.timings?.derivation),
        storeCommit: durationSnapshot(value.session?.timings?.storeCommit),
        candidateToCommit: durationSnapshot(value.session?.timings?.candidateToCommit),
      }),
    }),
    providers: Object.freeze(value.providers
      .filter((entry) => PROVIDER_ID_PATTERN.test(entry?.id || ""))
      .slice(0, 16)
      .map((entry) => Object.freeze({
        id: entry.id,
        workers: Object.freeze({
          capacity: boundedInteger(entry.workers?.capacity, 16),
          active: boundedInteger(entry.workers?.active, 16),
          pending: boundedInteger(entry.workers?.pending, 100_000),
        }),
        counters: counters(entry.counters, OBSERVER_COUNTERS),
        failures: counters(entry.failures, PROVIDER_FAILURE_COUNTERS),
        timings: Object.freeze({
          catalogDiscovery: durationSnapshot(entry.timings?.catalogDiscovery),
          queueWait: durationSnapshot(entry.timings?.queueWait),
          preparation: durationSnapshot(entry.timings?.preparation),
          acquisitionNormalization: durationSnapshot(entry.timings?.acquisitionNormalization),
        }),
      }))),
  });
}
