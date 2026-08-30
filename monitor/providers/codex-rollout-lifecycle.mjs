import fs from "node:fs";
import { codexTimestamp } from "./codex-session-metadata.mjs";
import { reduceCodexTurnLifecycle } from "./codex-turn-lifecycle.mjs";
import { CODEX_ACTIVE_WINDOW_MS, CODEX_ROLLOUT_LIVE_WINDOW_MS, CODEX_NEEDS_INPUT_MAX_MS, CODEX_LIVENESS_MAX_TAIL_RECORDS } from "./codex-lifecycle-constants.mjs";
function timestampValue(value) { return Date.parse(value || "") || 0; }
function safeTurnId(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value) ? value : null; }
function normalizedToolName(value) { return typeof value === "string" ? value.split(/[.:/]/).at(-1).trim().toLowerCase() : ""; }
export function readCodexLivenessTail(file, maximumBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return { key: null, records: [], complete: false }; }
  if (!stat.isFile() || stat.size <= 0) return { key: `${stat.size}:${stat.mtimeMs}`, records: [], complete: stat.isFile() };
  const bytes = Math.min(stat.size, maximumBytes);
  const buffer = Buffer.alloc(bytes);
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    if (fs.readSync(descriptor, buffer, 0, bytes, Math.max(0, stat.size - bytes)) !== bytes) {
      return { key: null, records: [], complete: false };
    }
  } catch {
    return { key: null, records: [], complete: false };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  let text = buffer.toString("utf8");
  let startOffset = stat.size - bytes;
  if (stat.size > bytes) {
    const newline = text.indexOf("\n");
    startOffset += Buffer.byteLength(newline >= 0 ? text.slice(0, newline + 1) : text);
    text = newline >= 0 ? text.slice(newline + 1) : "";
  }
  // Never accept a provider record until its framing newline has arrived.
  let complete = text.endsWith("\n");
  const completeEnd = text.lastIndexOf("\n");
  text = completeEnd >= 0 ? text.slice(0, completeEnd + 1) : "";
  const records = [];
  const lines = text.split("\n");
  if (lines.length > CODEX_LIVENESS_MAX_TAIL_RECORDS) {
    startOffset += Buffer.byteLength(lines.slice(0, -CODEX_LIVENESS_MAX_TAIL_RECORDS).join("\n")) + 1;
  }
  for (const line of lines.slice(-CODEX_LIVENESS_MAX_TAIL_RECORDS)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) records.push(record);
      else complete = false;
    } catch {
      // A malformed record could hide a lifecycle transition; retain evidence
      // without claiming that the current lifecycle is known.
      complete = false;
    }
  }
  return { key: `${stat.size}:${stat.mtimeMs}`, records, complete, startOffset };
}

function recordTimestamp(record) {
  return codexTimestamp(record?.timestamp ?? record?.payload?.timestamp ?? record?.message?.timestamp);
}

function recordTurnId(record) {
  return safeTurnId(record?.turn_id ?? record?.turnId ?? record?.payload?.turn_id ?? record?.payload?.turnId);
}

function callId(payload) {
  const value = payload?.call_id ?? payload?.callId ?? payload?.id;
  return typeof value === "string" && value.length <= 192 ? value : null;
}

function isAssistantFinalMessage(payload) {
  return payload?.type === "message" && payload.role === "assistant" && payload.phase === "final_answer";
}

function isWrappedProposedPlan(payload) {
  if (!isAssistantFinalMessage(payload)) return false;
  const output = Array.isArray(payload.content)
    ? payload.content.filter((item) => item?.type === "output_text" && typeof item.text === "string")
    : [];
  return output.some((item) => /<proposed_plan>[\s\S]*<\/proposed_plan>/i.test(item.text));
}

function isPlanModeTurn(payload) {
  return (payload?.collaboration_mode?.mode ?? payload?.collaborationMode?.mode) === "plan";
}

function rolloutTerminalStatus(record) {
  const type = String(record?.type || "").toLowerCase().replaceAll("_", "");
  const payloadType = String(record?.payload?.type || "").toLowerCase().replaceAll("_", "");
  const status = String(record?.payload?.turn?.status ?? record?.payload?.status ?? "").toLowerCase();
  if (["turncompleted", "turn/completed"].includes(type)) {
    if (status === "interrupted") return "interrupted";
    if (["failed", "systemerror", "error"].includes(status)) return "system_error";
    if (status === "completed") return "idle";
  }
  if (["turnaborted", "turninterrupted"].includes(payloadType)) return "interrupted";
  if (["turnerror", "streamerror"].includes(payloadType)) return "system_error";
  if (["turncomplete", "taskcomplete"].includes(payloadType)) return "idle";
  return null;
}

export function parseCodexRolloutLiveness(records, options = {}) {
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const pending = new Map();
  let planModeTurn = false;
  let planConfirmation = null;
  let latest = null;
  let terminal = null;
  let turn = null;
  for (const record of Array.isArray(records) ? records : []) {
    const timestamp = recordTimestamp(record);
    if (!timestamp) continue;
    const payload = record?.payload;
    const recognized = ["session_meta", "turn_context", "response_item", "event_msg", "turn_started", "turn_completed", "turn/started", "turn/completed"].includes(record.type);
    if (!recognized) continue;
    if (!latest || timestampValue(timestamp) >= timestampValue(latest.timestamp)) latest = { timestamp, turnId: recordTurnId(record) };
    const nextTurn = reduceCodexTurnLifecycle([record], turn);
    const turnChanged = nextTurn !== turn;
    turn = nextTurn;
    const observedTerminal = turnChanged && turn?.kind === "end"
      ? turn.status : !turn ? rolloutTerminalStatus(record) : null;
    if (observedTerminal) {
      terminal = { status: observedTerminal, timestamp };
      pending.clear();
    }
    if (turnChanged && turn?.kind === "start") {
      pending.clear();
      planConfirmation = null;
      terminal = null;
    }
    if (record.type === "turn_context") {
      if (!recordTurnId(record) || turnChanged) {
        planConfirmation = null;
        pending.clear();
      }
      planModeTurn = isPlanModeTurn(payload);
    } else if (record.type === "event_msg" && ["user_message", "user_prompt"].includes(payload?.type)) {
      planConfirmation = null;
      pending.clear();
    }
    if (record.type !== "response_item" || !payload || typeof payload !== "object") continue;
    if (payload.type === "message" && payload.role === "user") {
      planConfirmation = null;
      pending.clear();
    }
    if (isAssistantFinalMessage(payload) && (planModeTurn || isWrappedProposedPlan(payload))) {
      planConfirmation = { timestamp, turnId: recordTurnId(record) };
    }
    if (["function_call", "custom_tool_call"].includes(payload.type)
      && normalizedToolName(payload.name) === "request_user_input") {
      const id = callId(payload);
      if (id) pending.set(id, { timestamp, turnId: recordTurnId(record) });
    }
    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const id = callId(payload);
      if (id) {
        pending.delete(id);
      }
    }
  }
  if (!latest) return null;
  const waiting = [...pending.values()].sort((left, right) => timestampValue(right.timestamp) - timestampValue(left.timestamp))[0];
  const waitingAge = waiting ? nowMs - timestampValue(waiting.timestamp) : null;
  if (waitingAge !== null && waitingAge >= 0 && waitingAge <= CODEX_ROLLOUT_LIVE_WINDOW_MS) {
    return { live: true, status: "needs_input", needsInput: true, needsInputKind: "user_input", source: "rollout_activity_heuristic", observedAt: waiting.timestamp };
  }
  const planConfirmationAge = planConfirmation ? nowMs - timestampValue(planConfirmation.timestamp) : null;
  if (planConfirmationAge !== null && planConfirmationAge >= 0 && planConfirmationAge <= CODEX_NEEDS_INPUT_MAX_MS) {
    return { live: true, status: "needs_input", needsInput: true, needsInputKind: "plan_confirmation", source: "rollout_activity_heuristic", observedAt: planConfirmation.timestamp };
  }
  const age = nowMs - timestampValue(latest.timestamp);
  if (age < 0 || age > CODEX_ROLLOUT_LIVE_WINDOW_MS) return null;
  const status = terminal && timestampValue(terminal.timestamp) >= timestampValue(latest.timestamp)
    ? (["interrupted", "system_error"].includes(terminal.status) ? "stopped" : terminal.status)
    : age <= CODEX_ACTIVE_WINDOW_MS ? "active" : "idle";
  return {
    live: true,
    status,
    needsInput: false,
    source: "rollout_activity_heuristic",
    observedAt: latest.timestamp,
  };
}


/** Structured boundaries prove an observed state, never that a silent process is still running. */
export function observedCodexRolloutLifecycle(records, { now = Date.now(), previous = null } = {}) {
  const boundary = reduceCodexTurnLifecycle(records, previous);
  if (!boundary) return { boundary: null, liveness: null };
  const age = now - Date.parse(boundary.observedAt);
  if (age < 0) return { boundary, liveness: null };
  const stale = age > CODEX_ROLLOUT_LIVE_WINDOW_MS;
  return { boundary, liveness: {
    live: !stale,
    status: stale ? "unknown" : boundary.status,
    needsInput: false,
    source: "structured_lifecycle",
    observedAt: boundary.observedAt,
    evidence: stale ? "unavailable" : "observed",
    freshness: stale ? "stale" : "current",
    ...(stale ? { reason: "observation_gap" } : {}),
  } };
}
