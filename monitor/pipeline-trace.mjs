const MAX_DURATION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_MAX_OPEN_SPANS = 256;
const DEFAULT_MAX_HANDLES = 256;
const MAX_LANES = 1_024;

export const PIPELINE_TRACE_VERSION = 1;
export const PIPELINE_TRACE_BUILD_VERSION = "0.4.0";
export const PIPELINE_TRACE_CLOCK_QUALITY = "backend_monotonic_renderer_unaligned";
export const PIPELINE_TRACE_SCENARIOS = Object.freeze([
  "live_observation", "synthetic_benchmark", "progressive_activity_withheld_correlation",
  "synthetic_cold_start_history", "synthetic_restored_history", "synthetic_warm_append_history", "synthetic_continuous_burst_history",
]);
export const PIPELINE_TRACE_STAGES = Object.freeze([
  "source_notification", "catalog_discovery", "source_queue", "source_preparation", "acquisition_normalization",
  "catalog_commit_wait", "catalog_projection", "session_commit_wait", "session_derivation", "normalized_store_commit",
  "candidate_to_commit", "history_read", "history_publish", "history_contribution", "checkpoint", "revision_notify",
  "cache_serve", "renderer_event", "renderer_fetch", "renderer_react_commit", "renderer_next_frame", "calibration",
  "benchmark_source", "visible_row",
]);
export const PIPELINE_TRACE_DOMAINS = Object.freeze([
  "acquisition", "normalization", "commit", "derivation", "persistence", "serving", "runtime", "activity",
  "requests", "lifecycle", "presentation",
]);
export const PIPELINE_TRACE_OUTCOMES = Object.freeze([
  "accepted", "unchanged", "rejected", "superseded", "completed", "failed", "cancelled", "incomplete", "observed",
]);
export const PIPELINE_TRACE_COUNTERS = Object.freeze([
  "queue_depth", "oldest_pending_ms", "active", "capacity", "cpu", "memory", "event_loop_ms", "bytes", "records",
]);

const STAGES = new Set(PIPELINE_TRACE_STAGES);
const DOMAINS = new Set(PIPELINE_TRACE_DOMAINS);
const OUTCOMES = new Set(PIPELINE_TRACE_OUTCOMES);
const COUNTERS = new Set(PIPELINE_TRACE_COUNTERS);
const RENDERER_STAGES = new Set(["renderer_event", "renderer_fetch", "renderer_react_commit", "renderer_next_frame"]);
const RENDERER_SURFACES = new Set(["catalog", "activity", "requests"]);

function boundedInteger(value, maximum) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}

function boundedPositiveInteger(value, fallback, maximum) {
  return Number.isInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

function selectedStages(value) {
  if (!Array.isArray(value)) return PIPELINE_TRACE_STAGES;
  return Object.freeze([...new Set(value.filter((stage) => STAGES.has(stage)))].slice(0, PIPELINE_TRACE_STAGES.length));
}

/** Monitor-private Chrome Trace JSON with capture-local opaque handles only. */
export function createPipelineTraceRecorder({
  enabled = false,
  now = () => performance.now(),
  maxEvents = DEFAULT_MAX_EVENTS,
  maxOpenSpans = DEFAULT_MAX_OPEN_SPANS,
  maxHandles = DEFAULT_MAX_HANDLES,
  stages = undefined,
  scenario = "live_observation",
} = {}) {
  if (typeof now !== "function") throw new TypeError("Pipeline trace clock must be a function");
  const eventLimit = boundedPositiveInteger(maxEvents, DEFAULT_MAX_EVENTS, 4_096);
  const openSpanLimit = boundedPositiveInteger(maxOpenSpans, DEFAULT_MAX_OPEN_SPANS, MAX_LANES);
  const handleLimit = boundedPositiveInteger(maxHandles, DEFAULT_MAX_HANDLES, 1_024);
  const stageSet = new Set(selectedStages(stages));
  const traceScenario = PIPELINE_TRACE_SCENARIOS.includes(scenario) ? scenario : "live_observation";
  const flowHandles = new WeakMap();
  const revisionHandles = new WeakMap();
  const flowStates = new Set();
  const openSpans = new Map();
  let active = Boolean(enabled);
  let epoch = active ? 1 : 0;
  let startedAt = active ? Number(now()) || 0 : 0;
  let events = [];
  let observedStages = new Set();
  let flowCount = 0;
  let revisionCount = 0;
  let droppedEvents = 0;
  let droppedSpans = 0;
  let droppedHandles = 0;
  let incomplete = false;
  let calibratedRendererSpans = 0;
  let rejectedRendererCalibrations = 0;
  let maxRendererClockErrorUs = 0;

  function reset() {
    openSpans.clear(); flowStates.clear(); events = []; observedStages = new Set();
    flowCount = 0; revisionCount = 0; droppedEvents = 0; droppedSpans = 0; droppedHandles = 0; incomplete = false;
    calibratedRendererSpans = 0; rejectedRendererCalibrations = 0; maxRendererClockErrorUs = 0;
    startedAt = Number(now()) || 0; epoch += 1;
  }

  function timestamp(value) {
    return boundedInteger((Number(value) - startedAt) * 1_000, MAX_DURATION_MS * 1_000);
  }

  function activeHandle(map, handle) {
    const state = handle && typeof handle === "object" ? map.get(handle) : null;
    return state?.epoch === epoch ? state : null;
  }

  function append(event) {
    if (events.length >= eventLimit) { droppedEvents += 1; return false; }
    events.push(Object.freeze(event));
    return true;
  }

  function laneFor(started, durationMs) {
    const end = started + durationMs;
    const occupied = new Set([...Array.from(openSpans.values(), (span) => span.lane)]);
    for (const event of events) {
      if (event.ph !== "X") continue;
      const eventStart = event.ts / 1_000 + startedAt;
      if (started < eventStart + event.dur / 1_000 && end > eventStart) occupied.add(event.tid);
    }
    for (let lane = 1; lane <= MAX_LANES; lane += 1) if (!occupied.has(lane)) return lane;
    return 1;
  }

  function recordFlow(state, at, lane, outcome, phase) {
    if (!state || !append({ name: "pipeline_flow", cat: "runtime", ph: phase, ts: timestamp(at), pid: 1, tid: lane, id: state.id,
      args: Object.freeze({ outcome }) })) return false;
    state.lastAt = at;
    state.lastLane = lane;
    return true;
  }

  function appendSlice({ stage, domain, startedAt: spanStartedAt, durationMs, lane, flow, revision, outcome, clock = null, clockErrorUs = null, surface = null }) {
    if (!stageSet.has(stage) || !DOMAINS.has(domain)) return false;
    const safeDuration = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
    const flowState = activeHandle(flowHandles, flow);
    const revisionState = activeHandle(revisionHandles, revision);
    const resolvedLane = lane || laneFor(spanStartedAt, safeDuration);
    const resolvedOutcome = OUTCOMES.has(outcome) ? outcome : "observed";
    const args = { outcome: resolvedOutcome };
    if (revisionState) args.revision = revisionState.id;
    const calibratedRenderer = domain === "presentation" && RENDERER_STAGES.has(stage) && clock === "request_interval_bound"
      && Number.isSafeInteger(clockErrorUs) && clockErrorUs >= 1_000 && clockErrorUs <= 1_001_000;
    if (calibratedRenderer) {
      args.clock = clock;
      args.clockErrorUs = clockErrorUs;
    }
    if (RENDERER_SURFACES.has(surface) && (stage === "cache_serve" || RENDERER_STAGES.has(stage))) args.surface = surface;
    if (!append({ name: stage, cat: domain, ph: "X", ts: timestamp(spanStartedAt), dur: Math.round(safeDuration * 1_000),
      pid: 1, tid: resolvedLane, args: Object.freeze(args) })) return false;
    if (calibratedRenderer) {
      calibratedRendererSpans += 1;
      maxRendererClockErrorUs = Math.max(maxRendererClockErrorUs, clockErrorUs);
    }
    observedStages.add(stage);
    if (flowState) {
      if (!flowState.started) {
        recordFlow(flowState, spanStartedAt, resolvedLane, resolvedOutcome, "s");
        flowState.started = true;
      }
      recordFlow(flowState, spanStartedAt + safeDuration, resolvedLane, resolvedOutcome, "t");
    }
    return true;
  }

  function closeOpenSpans() {
    if (!openSpans.size) return;
    incomplete = true;
    const endedAt = Number(now()) || startedAt;
    for (const span of openSpans.values()) {
      appendSlice({ ...span, durationMs: Math.max(0, endedAt - span.startedAt), outcome: "incomplete" });
    }
    openSpans.clear();
  }

  function closeFlows(outcome) {
    for (const state of flowStates) {
      if (!state.started || state.finished) continue;
      state.finished = true;
      recordFlow(state, Number(now()) || state.lastAt || startedAt, state.lastLane || 1, outcome, "f");
    }
  }

  return Object.freeze({
    activate() { reset(); active = true; return true; },
    deactivate({ captureIncomplete = false } = {}) {
      if (!active) return false;
      if (captureIncomplete) incomplete = true;
      closeOpenSpans(); closeFlows(incomplete ? "incomplete" : "completed"); active = false; return true;
    },
    isActive: () => active,
    captureEpoch: () => epoch,
    monotonicNow: () => active ? Number(now()) || startedAt : null,
    noteRendererCalibrationRejected() {
      if (!active) return false;
      rejectedRendererCalibrations = Math.min(Number.MAX_SAFE_INTEGER, rejectedRendererCalibrations + 1);
      return true;
    },
    createFlow() {
      if (!active) return null;
      if (flowCount + revisionCount >= handleLimit) { droppedHandles += 1; return null; }
      const handle = Object.freeze({}); flowCount += 1;
      const state = { epoch, id: flowCount, started: false, finished: false };
      flowHandles.set(handle, state); flowStates.add(state);
      return handle;
    },
    finishFlow(handle, { outcome = "completed" } = {}) {
      const state = active && activeHandle(flowHandles, handle);
      if (!state || !state.started || state.finished) return false;
      state.finished = true;
      const written = recordFlow(state, Number(now()) || state.lastAt || startedAt, state.lastLane || 1,
        OUTCOMES.has(outcome) ? outcome : "observed", "f");
      flowStates.delete(state);
      return written;
    },
    createRevision() {
      if (!active) return null;
      if (flowCount + revisionCount >= handleLimit) { droppedHandles += 1; return null; }
      const handle = Object.freeze({}); revisionCount += 1;
      revisionHandles.set(handle, { epoch, id: revisionCount });
      return handle;
    },
    begin({ stage, domain, flow = null, revision = null } = {}) {
      if (!active || !stageSet.has(stage) || !DOMAINS.has(domain)) return null;
      if (openSpans.size >= openSpanLimit) { droppedSpans += 1; return null; }
      const started = Number(now()) || startedAt;
      const lane = laneFor(started, MAX_DURATION_MS);
      const flowState = activeHandle(flowHandles, flow);
      if (flowState) {
        recordFlow(flowState, started, lane, "observed", flowState.started ? "t" : "s");
        flowState.started = true;
      }
      const handle = Object.freeze({});
      openSpans.set(handle, Object.freeze({ stage, domain, lane, flow, revision, startedAt: started }));
      return handle;
    },
    end(handle, { outcome = "observed" } = {}) {
      if (!active || !openSpans.has(handle)) return false;
      const span = openSpans.get(handle); openSpans.delete(handle);
      return appendSlice({ ...span, durationMs: Math.max(0, (Number(now()) || span.startedAt) - span.startedAt), outcome });
    },
    recordDuration({ stage, domain, durationMs, flow = null, revision = null, outcome = "observed", startedAt: sourceStartedAt = null, clock = null, clockErrorUs = null, surface = null } = {}) {
      if (!active || !stageSet.has(stage) || !DOMAINS.has(domain)) return false;
      const observedAt = Number(now()) || startedAt;
      const safeDuration = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
      const sourceStarted = Number.isFinite(sourceStartedAt) ? Number(sourceStartedAt) : observedAt - safeDuration;
      const sourceEnded = sourceStarted + safeDuration;
      const crossedCaptureStart = sourceStarted < startedAt;
      if (sourceEnded < startedAt || sourceEnded === startedAt && sourceStarted < startedAt) {
        incomplete = true;
        droppedSpans += 1;
        return false;
      }
      const retainedDuration = crossedCaptureStart ? Math.min(safeDuration, Math.max(0, sourceEnded - startedAt)) : safeDuration;
      if (crossedCaptureStart) incomplete = true;
      return appendSlice({ stage, domain, durationMs: retainedDuration, flow, revision,
        outcome: crossedCaptureStart ? "incomplete" : outcome, startedAt: crossedCaptureStart ? startedAt : sourceStarted, clock, clockErrorUs, surface });
    },
    recordCounter({ counter, value } = {}) {
      if (!active || !COUNTERS.has(counter)) return false;
      return append({ name: counter, cat: "runtime", ph: "C", ts: timestamp(Number(now()) || startedAt), pid: 1, tid: 1,
        args: Object.freeze({ value: boundedInteger(value, Number.MAX_SAFE_INTEGER) }) });
    },
    snapshot() {
      return Object.freeze({ traceEvents: Object.freeze([...events]), metadata: Object.freeze({
        version: PIPELINE_TRACE_VERSION,
        capture: Object.freeze({ active, incomplete, eventCount: events.length,
          droppedEvents: boundedInteger(droppedEvents, Number.MAX_SAFE_INTEGER), droppedSpans: boundedInteger(droppedSpans, Number.MAX_SAFE_INTEGER),
          droppedHandles: boundedInteger(droppedHandles, Number.MAX_SAFE_INTEGER),
          openSpanCount: openSpans.size, flowCount, revisionCount }),
        coverage: Object.freeze({ enabledStages: Object.freeze([...stageSet]), observedStages: Object.freeze([...observedStages].sort()) }),
        provenance: Object.freeze({ buildVersion: PIPELINE_TRACE_BUILD_VERSION,
          clockQuality: calibratedRendererSpans ? "backend_monotonic_renderer_interval_bound" : PIPELINE_TRACE_CLOCK_QUALITY, scenario: traceScenario }),
        rendererClock: Object.freeze({ status: calibratedRendererSpans ? "bounded" : "unavailable", calibratedSpans: calibratedRendererSpans,
          rejectedCalibrations: rejectedRendererCalibrations, maxErrorUs: maxRendererClockErrorUs }),
      }) });
    },
  });
}
