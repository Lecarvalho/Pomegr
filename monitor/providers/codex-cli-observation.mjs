import fs from "node:fs";
import { parseCodexRolloutLiveness } from "./codex-rollout-lifecycle.mjs";
import { codexTurnBoundary } from "./codex-turn-lifecycle.mjs";
import { CODEX_ROLLOUT_APPROVAL_GRACE_MS, CODEX_NEEDS_INPUT_MAX_MS } from "./codex-lifecycle-constants.mjs";
function normalizedToolName(value) { return typeof value === "string" ? value.split(/[.:/]/).at(-1).trim().toLowerCase() : ""; }
function isPendingFileEditCall(payload) {
  if (!["function_call", "custom_tool_call"].includes(payload?.type)) return false;
  const name = normalizedToolName(payload.name);
  if (name === "apply_patch") return true;
  if (name !== "exec" || typeof payload.input !== "string") return false;
  return /(?:^|[^\w$])tools\s*\.\s*apply_patch\s*\(/.test(payload.input);
}


export function isActiveCodexWriterLock(file, options = {}) {
  if ((options.platform || process.platform) !== "win32") return false;
  const statFileSync = options.statFileSync || fs.statSync;
  const openFileSync = options.openFileSync || fs.openSync;
  const readSync = options.readSync || fs.readSync;
  const closeFileSync = options.closeFileSync || fs.closeSync;
  try {
    if (!statFileSync(file).isFile()) return false;
  } catch {
    return false;
  }
  let descriptor;
  try {
    descriptor = openFileSync(file, "r");
    // Windows can let the read-only open succeed while a writer lock blocks the
    // one-byte read at offset zero, including the beyond-EOF range. A false
    // result means the lock was not confirmed, not that the writer is idle.
    readSync(descriptor, Buffer.alloc(1), 0, 1, 0);
    return false;
  } catch (error) {
    return error?.code === "EBUSY";
  } finally {
    if (descriptor !== undefined) {
      try { closeFileSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
  }
}


/** CLI cold discovery requires its own writer lock; other surfaces do not inherit it. */
export function createCliObservation(maximum = 16) {
  let coldReads = 0;
  return {
    coldCandidate(thread, hasWriterLock) {
      if (thread.parentThreadId || coldReads >= maximum || !hasWriterLock(thread)) return false;
      coldReads += 1;
      return true;
    },
    infer: parseCodexCliRolloutLiveness,
  };
}



/** Only the interactive CLI treats an unmatched edit as a possible approval wait. */
export function parseCodexCliRolloutLiveness(records, options = {}) {
  const common = parseCodexRolloutLiveness(records, options);
  if (common?.needsInput) return common;
  const pending = new Map();
  let turnId = null;
  for (const record of records || []) {
    const payload = record?.payload;
    const boundary = codexTurnBoundary(record);
    if (boundary && (boundary.kind === "end" || boundary.turnId !== turnId)) pending.clear();
    if (boundary?.kind === "start") turnId = boundary.turnId;
    if (record?.type === "event_msg" && ["user_message", "user_prompt"].includes(payload?.type)) pending.clear();
    if (record?.type !== "response_item") continue;
    if (payload?.type === "message" && payload.role === "user") pending.clear();
    const id = payload?.call_id ?? payload?.callId ?? payload?.id;
    if (typeof id !== "string" || id.length > 192) continue;
    if (isPendingFileEditCall(payload)) pending.set(id, record.timestamp);
    if (["function_call_output", "custom_tool_call_output"].includes(payload?.type)) pending.delete(id);
  }
  const observedAt = [...pending.values()].filter((value) => Number.isFinite(Date.parse(value))).sort().at(-1);
  const age = (options.now ?? Date.now()) - Date.parse(observedAt);
  return age >= CODEX_ROLLOUT_APPROVAL_GRACE_MS && age <= CODEX_NEEDS_INPUT_MAX_MS
    ? { live: true, status: "needs_input", needsInput: true, needsInputKind: "pending_file_edit", source: "rollout_activity_heuristic", observedAt }
    : common;
}
