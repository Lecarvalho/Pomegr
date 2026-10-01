import { boundedActivityDuration } from "../../normalize/activity-events.mjs";

/** The provider status vocabulary reduced to running, completed, or failed. */
export function normalizedStatus(value, fallback = "running") {
  const status = String(value ?? "").toLowerCase().replace(/[_ -]/g, "");
  if (["completed", "complete", "success", "succeeded"].includes(status)) return "completed";
  if (["failed", "failure", "declined", "incomplete", "interrupted", "cancelled", "canceled"].includes(status)) return "failed";
  if (["inprogress", "running", "pending", "started"].includes(status)) return "running";
  return fallback;
}

const ROLLOUT_EXECUTION_ITEMS = new Set(["filechange", "commandexecution", "mcptoolcall"]);

/**
 * The kind of a completed rollout item that records one executed action: a file change, a shell
 * command, or an MCP tool call. A code-mode `exec` cell runs these inside its wrapper call, and
 * they are the only structured record of what the cell did.
 */
export function rolloutExecutionItemKind(payload) {
  const type = String(payload?.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const itemType = String(payload?.item?.type || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return type === "itemcompleted" && ROLLOUT_EXECUTION_ITEMS.has(itemType) ? itemType : null;
}

export function rolloutExecutionStatus(kind, item) {
  const exitCode = item.exit_code ?? item.exitCode;
  if (kind === "commandexecution" && Number.isInteger(exitCode) && exitCode !== 0) return "failed";
  if (kind === "mcptoolcall" && (item.result?.isError === true || item.result?.is_error === true || item.error)) return "failed";
  return normalizedStatus(item.status, "completed");
}

/** Recorded start time and bounded wall duration of a completed rollout item, when both are valid. */
export function rolloutExecutionTiming(payload) {
  const started = payload.started_at_ms ?? payload.startedAtMs;
  const completed = payload.completed_at_ms ?? payload.completedAtMs;
  if (!Number.isSafeInteger(started) || !Number.isSafeInteger(completed) || started <= 0 || completed < started) return null;
  const startedAt = new Date(started).toISOString();
  return { startedAt, durationMs: boundedActivityDuration(startedAt, new Date(completed).toISOString()) };
}

/** A code-mode cell: the `exec` custom tool whose input is a program, not one tool's arguments. */
export function isCodeModeWrapper(payload) {
  return payload?.type === "custom_tool_call" && String(payload.name || "").toLowerCase() === "exec"
    && typeof (payload.input ?? payload.arguments) === "string";
}
