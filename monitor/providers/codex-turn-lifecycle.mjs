import { codexTimestamp } from "./codex-session-metadata.mjs";

const STARTS = new Set(["task_started", "turn_started", "turn/started"]);
const ENDS = new Set(["task_complete", "task_completed", "task_failed", "task_interrupted", "turn_complete", "turn_completed", "turn/completed", "turn_failed", "turn_interrupted", "turn_aborted"]);
const SAFE_TURN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

/** Provider-private boundary decoder. Context identifies a turn, not a same-turn restart. */
export function codexTurnBoundary(record) {
  const payload = record?.payload;
  const type = record?.type === "event_msg" ? payload?.type : record?.type;
  if (!STARTS.has(type) && !ENDS.has(type) && type !== "turn_context") return null;
  const observedAt = codexTimestamp(record?.timestamp ?? payload?.timestamp);
  if (!observedAt) return null;
  const nativeId = record?.turn_id ?? record?.turnId ?? payload?.turn_id ?? payload?.turnId ?? payload?.turn?.id;
  const turnId = typeof nativeId === "string" && SAFE_TURN.test(nativeId) ? nativeId : null;
  if (type === "turn_context" && !turnId) return null;
  const starts = STARTS.has(type) || type === "turn_context";
  const status = payload?.turn?.status ?? payload?.status;
  return {
    kind: starts ? "start" : "end",
    turnId,
    observedAt,
    status: starts ? "active"
      : /failed|interrupted|aborted/.test(type) || ["failed", "interrupted"].includes(status) ? "stopped" : "idle",
  };
}

/** Reduce only explicit turn boundaries; retain identity/order across incremental batches. */
export function reduceCodexTurnLifecycle(records, previous = null) {
  let state = previous;
  for (const record of records || []) {
    const next = codexTurnBoundary(record);
    if (!next || (state && next.observedAt < state.observedAt)) continue;
    if (next.kind === "end" && next.turnId && state?.turnId && next.turnId !== state.turnId) continue;
    // A delayed duplicate start cannot resurrect the same completed turn.
    if (next.kind === "start" && next.turnId && next.turnId === state?.turnId && state.kind === "end") continue;
    if (next.kind === "start" && next.turnId && next.turnId === state?.turnId && state.kind === "start") continue;
    state = next;
  }
  return state;
}
