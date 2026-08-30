import { codexTimestamp } from "./codex-session-metadata.mjs";
import { reduceCodexTurnLifecycle } from "./codex-turn-lifecycle.mjs";
import { CODEX_ROLLOUT_LIVE_WINDOW_MS } from "./codex-lifecycle-constants.mjs";

const RECOGNIZED_RECORD_TYPES = new Set([
  "turn_context", "response_item", "event_msg",
  "turn_started", "turn_completed", "turn/started", "turn/completed",
]);
const RESPONSE_ACTIVITY_TYPES = new Set(["reasoning", "function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);
const EVENT_ACTIVITY_TYPES = new Set([
  "agent_reasoning", "agent_message", "token_count", "task_started", "task_complete", "task_completed", "task_failed", "task_interrupted",
  "turn_started", "turn_completed", "turn_complete", "turn_failed", "turn_interrupted", "turn_aborted", "user_message", "user_prompt",
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const MAX_PENDING_INPUTS = 16;

function timestampValue(value) {
  return Date.parse(value || "") || 0;
}

function recordTimestamp(record) {
  return codexTimestamp(record?.timestamp ?? record?.payload?.timestamp ?? record?.message?.timestamp);
}

function recordTurnId(record) {
  const value = record?.turn_id ?? record?.turnId ?? record?.payload?.turn_id ?? record?.payload?.turnId ?? record?.payload?.turn?.id;
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function callId(payload) {
  const value = payload?.call_id ?? payload?.callId ?? payload?.id;
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function normalizedToolName(value) {
  return typeof value === "string" ? value.split(/[.:/]/).at(-1).trim().toLowerCase() : "";
}

function isPendingInput(payload) {
  return ["function_call", "custom_tool_call"].includes(payload?.type)
    && normalizedToolName(payload.name) === "request_user_input";
}

function isCallOutput(payload) {
  return ["function_call_output", "custom_tool_call_output"].includes(payload?.type);
}

function normalizedTurn(value) {
  if (!value || typeof value !== "object") return null;
  const observedAt = codexTimestamp(value.observedAt);
  if (!observedAt || !["start", "end"].includes(value.kind)) return null;
  const turnId = typeof value.turnId === "string" && SAFE_ID.test(value.turnId) ? value.turnId : null;
  const status = value.kind === "start" ? "active" : ["idle", "stopped"].includes(value.status) ? value.status : null;
  return status ? { kind: value.kind, turnId, observedAt, status } : null;
}

function isProviderActivity(record, payload, { acceptedBoundary, turnId, currentTurn }) {
  if (acceptedBoundary) return true;
  if (currentTurn?.kind === "end" || (turnId && currentTurn?.turnId && turnId !== currentTurn.turnId)) return false;
  if (record.type === "turn_context") return Boolean(turnId && currentTurn?.turnId === turnId);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  if (record.type === "response_item") {
    return RESPONSE_ACTIVITY_TYPES.has(payload.type) || (payload.type === "message" && payload.role === "assistant");
  }
  return record.type === "event_msg" && EVENT_ACTIVITY_TYPES.has(payload.type);
}

function validState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return initialCodexRecordedLifecycle();
  return {
    turn: normalizedTurn(state.turn),
    latestActivityAt: codexTimestamp(state.latestActivityAt),
    pendingInputs: Array.isArray(state.pendingInputs) ? state.pendingInputs
      .filter((item) => item && SAFE_ID.test(item.callId || "") && codexTimestamp(item.observedAt))
      .slice(-MAX_PENDING_INPUTS)
      .map((item) => ({ callId: item.callId, turnId: typeof item.turnId === "string" && SAFE_ID.test(item.turnId) ? item.turnId : null, observedAt: codexTimestamp(item.observedAt) })) : [],
  };
}

/** Bounded provider-private state suitable for retained complete-record observation. */
export function initialCodexRecordedLifecycle() {
  return { turn: null, latestActivityAt: null, pendingInputs: [] };
}

/** Reduce one complete provider record without retaining provider text or payloads. */
export function reduceCodexRecordedLifecycle(previous, record) {
  const state = validState(previous);
  if (!record || typeof record !== "object" || Array.isArray(record) || !RECOGNIZED_RECORD_TYPES.has(record.type)) return state;
  const timestamp = recordTimestamp(record);
  if (!timestamp) return state;

  const nextTurn = reduceCodexTurnLifecycle([record], state.turn);
  const turnChanged = nextTurn !== state.turn;
  const payload = record.payload;
  const turnId = recordTurnId(record);
  const currentTurnId = nextTurn?.turnId ?? null;
  const belongsToCurrentTurn = !turnId || !currentTurnId || turnId === currentTurnId;
  const currentOrNewer = !state.latestActivityAt || timestampValue(timestamp) >= timestampValue(state.latestActivityAt);
  const acceptedActivity = currentOrNewer && isProviderActivity(record, payload, {
    acceptedBoundary: turnChanged,
    turnId,
    currentTurn: nextTurn,
  });
  const latestActivityAt = acceptedActivity ? timestamp : state.latestActivityAt;
  let pendingInputs = state.pendingInputs;
  if (turnChanged && nextTurn?.kind === "start") {
    pendingInputs = [];
  } else if (turnChanged && nextTurn?.kind === "end") {
    pendingInputs = [];
  } else if (acceptedActivity && belongsToCurrentTurn) {
    if (nextTurn?.kind !== "end" && isPendingInput(payload)) {
      const id = callId(payload);
      if (id) {
        pendingInputs = [...pendingInputs.filter((item) => item.callId !== id), {
          callId: id,
          turnId: turnId ?? currentTurnId,
          observedAt: timestamp,
        }].slice(-MAX_PENDING_INPUTS);
      }
    } else if (isCallOutput(payload)) {
      const id = callId(payload);
      if (id && pendingInputs.some((item) => item.callId === id)) {
        pendingInputs = pendingInputs.filter((item) => item.callId !== id);
      }
    }
  }
  if (nextTurn === state.turn && latestActivityAt === state.latestActivityAt && pendingInputs === state.pendingInputs) return state;
  return { turn: nextTurn, latestActivityAt, pendingInputs };
}

function unknownLiveness(state, nowMs, { freshness = "stale" } = {}) {
  const observedAt = state.latestActivityAt ?? state.turn?.observedAt ?? null;
  if (!observedAt) return null;
  const age = nowMs - timestampValue(observedAt);
  return {
    live: age >= 0 && age <= CODEX_ROLLOUT_LIVE_WINDOW_MS,
    status: "unknown",
    needsInput: false,
    source: "structured_lifecycle",
    observedAt,
    evidence: "unavailable",
    freshness,
    reason: "observation_gap",
  };
}

/** Convert retained complete-record lifecycle state into normalized liveness evidence. */
export function codexRecordedLiveness(previous, { now = Date.now(), complete = true } = {}) {
  const state = validState(previous);
  const nowMs = Number.isFinite(now) ? now : Number.NaN;
  if (!Number.isFinite(nowMs)) return null;
  if (!complete) return unknownLiveness(state, nowMs);
  if (state.turn?.kind === "end") {
    const terminalAge = nowMs - timestampValue(state.turn.observedAt);
    if (terminalAge < 0 || terminalAge > CODEX_ROLLOUT_LIVE_WINDOW_MS) return unknownLiveness({ ...state, latestActivityAt: state.turn.observedAt }, nowMs);
    return {
      live: true,
      status: state.turn.status,
      needsInput: false,
      source: "structured_lifecycle",
      observedAt: state.turn.observedAt,
      evidence: "observed",
      freshness: "current",
    };
  }
  const activityAt = state.latestActivityAt;
  const activityAge = nowMs - timestampValue(activityAt);
  if (!activityAt || activityAge < 0 || activityAge > CODEX_ROLLOUT_LIVE_WINDOW_MS) return unknownLiveness(state, nowMs);
  const pending = state.pendingInputs.at(-1);
  if (pending) return {
    live: true,
    status: "needs_input",
    needsInput: true,
    needsInputKind: "user_input",
    source: "structured_lifecycle",
    observedAt: pending.observedAt,
    evidence: "observed",
    freshness: "current",
  };
  if (!state.turn) return unknownLiveness(state, nowMs, { freshness: "current" });
  return {
    live: true,
    status: "active",
    needsInput: false,
    source: "structured_lifecycle",
    observedAt: activityAt,
    evidence: "observed",
    freshness: "current",
  };
}
