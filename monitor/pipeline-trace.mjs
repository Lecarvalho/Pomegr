const MAX_DURATION_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_EVENTS = 2_048;
const DEFAULT_ROLLING_MAX_EVENTS = 16_384;
const DEFAULT_MAX_OPEN_SPANS = 256;
const DEFAULT_MAX_HANDLES = 256;
const DEFAULT_RETENTION_MS = 5 * 60_000;
const DEFAULT_MAX_RETAINED_BYTES = 3 * 1024 * 1024;
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

function eventByteSize(event) {
  // Accepted trace strings are fixed ASCII vocabulary, so string length is an exact byte bound.
  return JSON.stringify(event).length + 1;
}

/** Monitor-private Chrome Trace JSON with capture-local opaque handles only. */
export function createPipelineTraceRecorder({
  enabled = false,
  rolling = false,
  retentionMs = DEFAULT_RETENTION_MS,
  maxRetainedBytes = DEFAULT_MAX_RETAINED_BYTES,
  now = () => performance.now(),
  maxEvents = undefined,
  maxOpenSpans = DEFAULT_MAX_OPEN_SPANS,
  maxHandles = DEFAULT_MAX_HANDLES,
  stages = undefined,
  scenario = "live_observation",
} = {}) {
  if (typeof now !== "function") throw new TypeError("Pipeline trace clock must be a function");
  const rollingMode = Boolean(rolling);
  const eventLimit = boundedPositiveInteger(maxEvents, rollingMode ? DEFAULT_ROLLING_MAX_EVENTS : DEFAULT_MAX_EVENTS, rollingMode ? DEFAULT_ROLLING_MAX_EVENTS : 4_096);
  const openSpanLimit = boundedPositiveInteger(maxOpenSpans, DEFAULT_MAX_OPEN_SPANS, MAX_LANES);
  const handleLimit = boundedPositiveInteger(maxHandles, DEFAULT_MAX_HANDLES, 1_024);
  const retentionLimit = boundedPositiveInteger(retentionMs, DEFAULT_RETENTION_MS, DEFAULT_RETENTION_MS);
  const retainedByteLimit = boundedPositiveInteger(maxRetainedBytes, DEFAULT_MAX_RETAINED_BYTES, 4 * 1024 * 1024 - 1);
  const stageSet = new Set(selectedStages(stages));
  const traceScenario = PIPELINE_TRACE_SCENARIOS.includes(scenario) ? scenario : "live_observation";
  const flowHandles = new WeakMap();
  const revisionHandles = new WeakMap();
  const scopes = new WeakSet();
  const invalidScope = Object.freeze({});
  const flowStates = new Set();
  const liveHandleStates = new Set();
  const openSpans = new Map();
  let active = Boolean(enabled || rollingMode);
  let epoch = active ? 1 : 0;
  let startedAt = active ? safeNow() : 0;
  let events = [];
  let eventHead = 0;
  let retainedBytes = 0;
  let laneEnds = new Array(MAX_LANES + 1).fill(0);
  let observedStages = new Set();
  let flowCount = 0;
  let revisionCount = 0;
  let nextFlowId = 0;
  let nextRevisionId = 0;
  let droppedEvents = 0;
  let droppedSpans = 0;
  let droppedHandles = 0;
  let evictedEvents = 0;
  let capacityLimited = false;
  let incomplete = false;
  let calibratedRendererSpans = 0;
  let rejectedRendererCalibrations = 0;
  let maxRendererClockErrorUs = 0;

  function safeNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : 0;
  }

  function rawOffsetMs(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(Number.MAX_SAFE_INTEGER / 1_000, Math.max(0, numeric - startedAt));
  }

  function offsetMs(value) {
    return boundedInteger(rawOffsetMs(value), Number.MAX_SAFE_INTEGER);
  }

  function timestamp(value) {
    return boundedInteger(rawOffsetMs(value) * 1_000, rollingMode ? Number.MAX_SAFE_INTEGER : MAX_DURATION_MS * 1_000);
  }

  function reset() {
    openSpans.clear(); flowStates.clear(); liveHandleStates.clear(); events = []; eventHead = 0; retainedBytes = 0; laneEnds = new Array(MAX_LANES + 1).fill(0); observedStages = new Set();
    flowCount = 0; revisionCount = 0; nextFlowId = 0; nextRevisionId = 0; droppedEvents = 0; droppedSpans = 0; droppedHandles = 0;
    evictedEvents = 0; capacityLimited = false; incomplete = false; calibratedRendererSpans = 0; rejectedRendererCalibrations = 0; maxRendererClockErrorUs = 0;
    startedAt = safeNow(); epoch += 1;
  }

  function retainedCount() { return events.length - eventHead; }

  function compactEvents() {
    if (eventHead > 1_024 && eventHead * 2 >= events.length) { events = events.slice(eventHead); eventHead = 0; }
  }

  function evictOldest() {
    const entry = events[eventHead];
    if (!entry) return false;
    retainedBytes = Math.max(0, retainedBytes - entry.bytes);
    eventHead += 1;
    evictedEvents = boundedInteger(evictedEvents + 1, Number.MAX_SAFE_INTEGER);
    compactEvents();
    return true;
  }

  function expireRetainedEvents(currentOffset) {
    if (!rollingMode) return;
    const cutoff = Math.max(0, currentOffset - retentionLimit);
    while (cutoff > 0 && eventHead < events.length && events[eventHead].endMs <= cutoff) evictOldest();
  }

  function isExpired(state, current) { return rollingMode && current - state.lastAt > retentionLimit; }

  function expireRollingState(current) {
    if (!rollingMode) return;
    for (const [handle, span] of openSpans) {
      if (current - span.startedAt <= retentionLimit) continue;
      openSpans.delete(handle); laneEnds[span.lane] = span.startedAt; incomplete = true;
      appendSlice({ ...span, durationMs: Math.max(0, current - span.startedAt), outcome: "incomplete" });
    }
    for (const state of [...liveHandleStates]) {
      if (!isExpired(state, current)) continue;
      state.active = false; liveHandleStates.delete(state);
      if (state.type === "flow") flowStates.delete(state);
    }
    expireRetainedEvents(offsetMs(current));
  }

  function prepare(current = safeNow()) { if (rollingMode) expireRollingState(current); return current; }

  function activeHandle(map, handle, current = safeNow()) {
    const state = handle && typeof handle === "object" ? map.get(handle) : null;
    if (!state || state.epoch !== epoch || !state.active || isExpired(state, current)) return null;
    state.lastAt = current;
    return state;
  }

  function resolvedScope(scope, flowState, revisionState) {
    return scopes.has(scope) ? scope : flowState?.scope ?? revisionState?.scope ?? null;
  }

  function append(event, scope = null) {
    const startMs = boundedInteger(event.ts / 1_000, Number.MAX_SAFE_INTEGER);
    const endMs = event.ph === "X" ? boundedInteger(startMs + event.dur / 1_000, Number.MAX_SAFE_INTEGER) : startMs;
    if (rollingMode) expireRetainedEvents(offsetMs(safeNow()));
    const cutoff = Math.max(0, offsetMs(safeNow()) - retentionLimit);
    if (rollingMode && cutoff > 0 && endMs <= cutoff) {
      evictedEvents = boundedInteger(evictedEvents + 1, Number.MAX_SAFE_INTEGER); return false;
    }
    const entry = Object.freeze({ event: Object.freeze(event), scope, startMs, endMs, bytes: eventByteSize(event) });
    if (!rollingMode && retainedCount() >= eventLimit) { droppedEvents += 1; return false; }
    if (rollingMode) {
      while (retainedCount() && (retainedCount() >= eventLimit || retainedBytes + entry.bytes > retainedByteLimit)) { capacityLimited = true; evictOldest(); }
      if (entry.bytes > retainedByteLimit) { capacityLimited = true; evictedEvents = boundedInteger(evictedEvents + 1, Number.MAX_SAFE_INTEGER); return false; }
    }
    events.push(entry); retainedBytes += entry.bytes;
    return true;
  }

  function laneFor(started, durationMs) {
    const cutoff = rollingMode ? Math.max(0, offsetMs(safeNow()) - retentionLimit) + startedAt : 0;
    for (let lane = 1; lane <= MAX_LANES; lane += 1) {
      if (rollingMode && laneEnds[lane] <= cutoff) laneEnds[lane] = 0;
      if (laneEnds[lane] <= started) return lane;
    }
    return 1;
  }

  function recordFlow(state, at, lane, outcome, phase, scope = null) {
    if (!state || !append({ name: "pipeline_flow", cat: "runtime", ph: phase, ts: timestamp(at), pid: 1, tid: lane, id: state.id,
      args: Object.freeze({ outcome }) }, resolvedScope(scope, state, null))) return false;
    state.lastAt = at; state.lastLane = lane;
    return true;
  }

  function appendSlice({ stage, domain, startedAt: spanStartedAt, durationMs, lane, flow, revision, outcome, clock = null, clockErrorUs = null, surface = null, scope = null }) {
    if (!stageSet.has(stage) || !DOMAINS.has(domain)) return false;
    const current = safeNow();
    const safeDuration = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
    const flowState = activeHandle(flowHandles, flow, current);
    const revisionState = activeHandle(revisionHandles, revision, current);
    const resolvedLane = lane || laneFor(spanStartedAt, safeDuration);
    const resolvedOutcome = OUTCOMES.has(outcome) ? outcome : "observed";
    const args = { outcome: resolvedOutcome };
    if (revisionState) args.revision = revisionState.id;
    const calibratedRenderer = domain === "presentation" && RENDERER_STAGES.has(stage) && clock === "request_interval_bound"
      && Number.isSafeInteger(clockErrorUs) && clockErrorUs >= 1_000 && clockErrorUs <= 1_001_000;
    if (calibratedRenderer) { args.clock = clock; args.clockErrorUs = clockErrorUs; }
    if (RENDERER_SURFACES.has(surface) && (stage === "cache_serve" || RENDERER_STAGES.has(stage))) args.surface = surface;
    const inheritedScope = resolvedScope(scope, flowState, revisionState);
    if (!append({ name: stage, cat: domain, ph: "X", ts: timestamp(spanStartedAt), dur: Math.round(safeDuration * 1_000),
      pid: 1, tid: resolvedLane, args: Object.freeze(args) }, inheritedScope)) return false;
    laneEnds[resolvedLane] = Math.max(laneEnds[resolvedLane], spanStartedAt + safeDuration);
    if (calibratedRenderer) { calibratedRendererSpans += 1; maxRendererClockErrorUs = Math.max(maxRendererClockErrorUs, clockErrorUs); }
    observedStages.add(stage);
    if (flowState) {
      if (!flowState.started) { recordFlow(flowState, spanStartedAt, resolvedLane, resolvedOutcome, "s", inheritedScope); flowState.started = true; }
      recordFlow(flowState, spanStartedAt + safeDuration, resolvedLane, resolvedOutcome, "t", inheritedScope);
    }
    return true;
  }

  function closeOpenSpans() {
    if (!openSpans.size) return;
    incomplete = true;
    const endedAt = safeNow();
    for (const span of openSpans.values()) {
      laneEnds[span.lane] = span.startedAt;
      appendSlice({ ...span, durationMs: Math.max(0, endedAt - span.startedAt), outcome: "incomplete" });
    }
    openSpans.clear();
  }

  function closeFlows(outcome) {
    for (const state of flowStates) {
      if (!state.started || state.finished || !state.active) continue;
      state.finished = true; recordFlow(state, safeNow(), state.lastLane || 1, outcome, "f");
      state.active = false; liveHandleStates.delete(state);
    }
    flowStates.clear();
  }

  function snapshotEvents(windowStart, windowEnd, selectedScope) {
    const selected = [];
    for (let index = eventHead; index < events.length; index += 1) {
      const entry = events[index];
      if ((rollingMode ? (windowStart > 0 && entry.endMs <= windowStart && entry.startMs < windowStart) : entry.endMs < windowStart) || entry.startMs > windowEnd) continue;
      if (selectedScope === invalidScope) continue;
      if (selectedScope !== null && entry.scope !== null && entry.scope !== selectedScope) continue;
      let event = entry.event;
      if (event.ph === "X" && entry.startMs < windowStart) {
        event = Object.freeze({ ...event, ts: Math.round(windowStart * 1_000), dur: Math.round((entry.endMs - windowStart) * 1_000),
          args: Object.freeze({ ...event.args, outcome: "incomplete" }) });
      }
      selected.push({ event, startMs: Math.max(entry.startMs, windowStart), scope: entry.scope, preview: false });
    }
    for (const span of openSpans.values()) {
      if (span.startedAt > windowEnd || selectedScope === invalidScope || (selectedScope !== null && span.scope !== null && span.scope !== selectedScope)) continue;
      const started = Math.max(span.startedAt, windowStart);
      const revisionState = span.revision && revisionHandles.get(span.revision);
      const args = { outcome: "incomplete" };
      if (revisionState?.epoch === epoch && revisionState.active) args.revision = revisionState.id;
      selected.push({ event: Object.freeze({ name: span.stage, cat: span.domain, ph: "X", ts: Math.round(started * 1_000),
        dur: Math.round(Math.max(0, windowEnd - started) * 1_000), pid: 1, tid: span.lane, args: Object.freeze(args) }), startMs: started, scope: span.scope, preview: true });
    }
    const previews = selected.filter((entry) => entry.preview);
    const retained = selected.filter((entry) => !entry.preview);
    const previewBytes = previews.reduce((total, entry) => total + eventByteSize(entry.event), 0);
    const kept = [];
    let usedBytes = previewBytes;
    for (const entry of retained) {
      if (kept.length + previews.length >= eventLimit || usedBytes + eventByteSize(entry.event) > retainedByteLimit) continue;
      kept.push(entry); usedBytes += eventByteSize(entry.event);
    }
    const bounded = [...kept, ...previews].slice(0, eventLimit);
    const startedFlows = new Set(bounded.filter(({ event }) => event.name === "pipeline_flow" && event.ph === "s").map(({ event }) => event.id));
    const incompleteFlows = bounded.some(({ event }) => event.name === "pipeline_flow" && event.ph !== "s" && !startedFlows.has(event.id));
    const flowSafe = bounded.filter(({ event }) => event.name !== "pipeline_flow" || event.ph === "s" || startedFlows.has(event.id));
    const exported = flowSafe.map(({ event, startMs }) =>
      Object.freeze({ ...event, ts: Math.max(0, Math.round((startMs - windowStart) * 1_000)) }));
    return Object.freeze({ events: Object.freeze(exported), incompleteFlows,
      matchedEvents: boundedInteger(flowSafe.filter((entry) => selectedScope !== null && entry.scope === selectedScope).length, eventLimit) });
  }

  return Object.freeze({
    activate() { reset(); active = true; return true; },
    deactivate({ captureIncomplete = false } = {}) {
      if (!active) return false;
      if (captureIncomplete) incomplete = true;
      closeOpenSpans(); closeFlows(incomplete ? "incomplete" : "completed"); active = false; return true;
    },
    isActive: () => active,
    isRolling: () => rollingMode,
    captureEpoch: () => epoch,
    monotonicNow: () => active ? safeNow() : null,
    noteRendererCalibrationRejected() {
      if (!active) return false;
      rejectedRendererCalibrations = boundedInteger(rejectedRendererCalibrations + 1, Number.MAX_SAFE_INTEGER); return true;
    },
    createScope() { const scope = Object.freeze({}); scopes.add(scope); return scope; },
    createFlow({ scope = null } = {}) {
      if (!active) return null;
      const current = prepare();
      if (liveHandleStates.size >= handleLimit || nextFlowId >= Number.MAX_SAFE_INTEGER) { droppedHandles += 1; return null; }
      const handle = Object.freeze({}); const state = { epoch, id: ++nextFlowId, type: "flow", scope: resolvedScope(scope, null, null), started: false, finished: false, active: true, lastAt: current, lastLane: 1 };
      flowCount += 1; flowHandles.set(handle, state); flowStates.add(state); liveHandleStates.add(state);
      return handle;
    },
    finishFlow(handle, { outcome = "completed" } = {}) {
      const state = active && activeHandle(flowHandles, handle, prepare());
      if (!state || !state.started || state.finished) return false;
      state.finished = true;
      const written = recordFlow(state, safeNow(), state.lastLane || 1, OUTCOMES.has(outcome) ? outcome : "observed", "f");
      state.active = false; flowStates.delete(state); liveHandleStates.delete(state);
      return written;
    },
    createRevision({ scope = null } = {}) {
      if (!active) return null;
      const current = prepare();
      if (liveHandleStates.size >= handleLimit || nextRevisionId >= Number.MAX_SAFE_INTEGER) { droppedHandles += 1; return null; }
      const handle = Object.freeze({}); const state = { epoch, id: ++nextRevisionId, type: "revision", scope: resolvedScope(scope, null, null), active: true, lastAt: current };
      revisionCount += 1; revisionHandles.set(handle, state); liveHandleStates.add(state);
      return handle;
    },
    begin({ stage, domain, flow = null, revision = null, scope = null } = {}) {
      if (!active || !stageSet.has(stage) || !DOMAINS.has(domain)) return null;
      const started = prepare();
      if (openSpans.size >= openSpanLimit) { droppedSpans += 1; return null; }
      const lane = laneFor(started, MAX_DURATION_MS);
      const flowState = activeHandle(flowHandles, flow, started);
      const revisionState = activeHandle(revisionHandles, revision, started);
      const inheritedScope = resolvedScope(scope, flowState, revisionState);
      if (flowState) { recordFlow(flowState, started, lane, "observed", flowState.started ? "t" : "s", inheritedScope); flowState.started = true; }
      const handle = Object.freeze({});
      laneEnds[lane] = started + MAX_DURATION_MS;
      openSpans.set(handle, Object.freeze({ stage, domain, lane, flow, revision, scope: inheritedScope, startedAt: started }));
      return handle;
    },
    end(handle, { outcome = "observed" } = {}) {
      if (!active || !openSpans.has(handle)) return false;
      const span = openSpans.get(handle); openSpans.delete(handle);
      laneEnds[span.lane] = span.startedAt;
      return appendSlice({ ...span, durationMs: Math.max(0, prepare() - span.startedAt), outcome });
    },
    recordDuration({ stage, domain, durationMs, flow = null, revision = null, scope = null, outcome = "observed", startedAt: sourceStartedAt = null, clock = null, clockErrorUs = null, surface = null } = {}) {
      if (!active || !stageSet.has(stage) || !DOMAINS.has(domain)) return false;
      const observedAt = prepare();
      const safeDuration = Math.min(MAX_DURATION_MS, Math.max(0, Number.isFinite(durationMs) ? durationMs : 0));
      const sourceStarted = Number.isFinite(sourceStartedAt) ? Number(sourceStartedAt) : observedAt - safeDuration;
      const sourceEnded = sourceStarted + safeDuration;
      const crossedCaptureStart = sourceStarted < startedAt;
      if (sourceEnded < startedAt || sourceEnded === startedAt && sourceStarted < startedAt) { incomplete = true; droppedSpans += 1; return false; }
      const retainedDuration = crossedCaptureStart ? Math.min(safeDuration, Math.max(0, sourceEnded - startedAt)) : safeDuration;
      if (crossedCaptureStart) incomplete = true;
      return appendSlice({ stage, domain, durationMs: retainedDuration, flow, revision, scope,
        outcome: crossedCaptureStart ? "incomplete" : outcome, startedAt: crossedCaptureStart ? startedAt : sourceStarted, clock, clockErrorUs, surface });
    },
    recordCounter({ counter, value } = {}) {
      if (!active || !COUNTERS.has(counter)) return false;
      const observedAt = prepare();
      return append({ name: counter, cat: "runtime", ph: "C", ts: timestamp(observedAt), pid: 1, tid: 1,
        args: Object.freeze({ value: boundedInteger(value, Number.MAX_SAFE_INTEGER) }) });
    },
    snapshot({ windowMs = undefined, scope = undefined } = {}) {
      const endMs = offsetMs(safeNow());
      const requestedWindow = rollingMode ? boundedPositiveInteger(windowMs, retentionLimit, retentionLimit) : endMs;
      const requestedStartMs = rollingMode ? Math.max(0, endMs - requestedWindow) : 0;
      const oldestRetained = events[eventHead];
      const capacityTruncated = rollingMode && capacityLimited && oldestRetained && oldestRetained.startMs > requestedStartMs;
      const selectedWindowStartMs = capacityTruncated ? oldestRetained.startMs : requestedStartMs;
      const windowStartMs = Math.min(endMs, Math.max(0, Math.ceil(selectedWindowStartMs)));
      const selectedScope = scope == null ? null : scopes.has(scope) ? scope : invalidScope;
      const selection = snapshotEvents(selectedWindowStartMs, endMs, selectedScope);
      const traceEvents = selection.events;
      const exportedStages = Object.freeze([...new Set(traceEvents.filter((event) => event.ph === "X" && STAGES.has(event.name)).map((event) => event.name))].sort());
      const exportedRenderer = traceEvents.filter((event) => event.ph === "X" && event.cat === "presentation" && RENDERER_STAGES.has(event.name)
        && event.args.clock === "request_interval_bound" && Number.isSafeInteger(event.args.clockErrorUs));
      const exportedClockErrorUs = exportedRenderer.reduce((maximum, event) => Math.max(maximum, event.args.clockErrorUs), 0);
      const rollingMetadata = rollingMode ? Object.freeze({ retentionMs: retentionLimit, windowStartMs, windowEndMs: endMs,
        retainedMs: Math.max(0, endMs - windowStartMs), evictedEvents, capacityLimited: Boolean(capacityTruncated), selection: selectedScope === null ? "all" : "session",
        matchedEvents: boundedInteger(selection.matchedEvents, DEFAULT_ROLLING_MAX_EVENTS) }) : null;
      return Object.freeze({ traceEvents, metadata: Object.freeze({
        version: PIPELINE_TRACE_VERSION,
        capture: Object.freeze({ active: rollingMode ? false : active, incomplete: incomplete || selection.incompleteFlows || (rollingMode && openSpans.size > 0), eventCount: traceEvents.length,
          droppedEvents: boundedInteger(droppedEvents, Number.MAX_SAFE_INTEGER), droppedSpans: boundedInteger(droppedSpans, Number.MAX_SAFE_INTEGER),
          droppedHandles: boundedInteger(droppedHandles, Number.MAX_SAFE_INTEGER), openSpanCount: openSpans.size, flowCount, revisionCount }),
        ...(rollingMetadata ? { rolling: rollingMetadata } : {}),
        coverage: Object.freeze({ enabledStages: Object.freeze([...stageSet]), observedStages: rollingMode ? exportedStages : Object.freeze([...observedStages].sort()) }),
        provenance: Object.freeze({ buildVersion: PIPELINE_TRACE_BUILD_VERSION,
          clockQuality: (rollingMode ? exportedRenderer.length : calibratedRendererSpans) ? "backend_monotonic_renderer_interval_bound" : PIPELINE_TRACE_CLOCK_QUALITY, scenario: traceScenario }),
        rendererClock: Object.freeze({ status: (rollingMode ? exportedRenderer.length : calibratedRendererSpans) ? "bounded" : "unavailable", calibratedSpans: rollingMode ? exportedRenderer.length : calibratedRendererSpans,
          rejectedCalibrations: rejectedRendererCalibrations, maxErrorUs: rollingMode ? exportedClockErrorUs : maxRendererClockErrorUs }),
      }) });
    },
  });
}
