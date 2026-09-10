import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

const MAX_DURATION_MS = 24 * 60 * 60 * 1_000;

export function boundedActivityDuration(startedAt, finishedAt) {
  const start = Date.parse(startedAt || "");
  const finish = Date.parse(finishedAt || "");
  const duration = finish - start;
  return Number.isFinite(duration) && duration >= 0 && duration <= MAX_DURATION_MS ? duration : null;
}

export function shellFailureActivityEvents(executionTasks, actor = "Primary agent") {
  if (!Array.isArray(executionTasks)) return [];
  return executionTasks.flatMap((task) => {
    if (task?.status !== "failed" || !task.id || !task.finishedAt) return [];
    const exitDetail = Number.isInteger(task.exitCode) ? ` · exit ${task.exitCode}` : "";
    return [{
      id: `${task.id}-failed`,
      timestamp: task.finishedAt,
      actor,
      tool: "Shell failed",
      workKind: normalizedWorkKind(task.workKind),
      detail: `${task.label}${exitDetail}`,
      status: "failed",
      durationMs: boundedActivityDuration(task.startedAt, task.finishedAt),
      requestId: null,
    }];
  });
}

export function recentActivityEvents(events, maximum = 200) {
  const limit = Number.isInteger(maximum) ? Math.max(0, maximum) : 200;
  return [...events]
    .sort((left, right) => (
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || String(left.id).localeCompare(String(right.id))
    ))
    .slice(0, limit)
    .map(({ id, timestamp, actor, tool, workKind, detail, status, durationMs, requestId }) => ({
      id,
      timestamp,
      actor,
      tool,
      workKind: normalizedWorkKind(workKind, toolWorkKind(tool, { detail })),
      detail,
      status: status === "failed" ? "failed" : null,
      durationMs: Number.isSafeInteger(durationMs) && durationMs >= 0 && durationMs <= MAX_DURATION_MS ? durationMs : null,
      requestId: typeof requestId === "string" && /^request-[a-f0-9]{16}$/.test(requestId) ? requestId : null,
    }));
}

function medianDuration(events) {
  const values = events.map((event) => event.durationMs)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((left, right) => left - right);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Build a public activity window plus aggregates over the full retained evidence. */
export function buildActivityFeed({ events = [], toolCalls = [], messages = 0, failed = 0 } = {}) {
  const normalizedTools = recentActivityEvents(toolCalls, 4_096);
  const byKind = new Map();
  for (const event of normalizedTools) {
    const items = byKind.get(event.workKind) || [];
    items.push(event);
    byKind.set(event.workKind, items);
  }
  return {
    items: recentActivityEvents(events, 200),
    total: Array.isArray(events) ? events.length : 0,
    toolCalls: normalizedTools.length,
    byKind: [...byKind.entries()].map(([kind, items]) => ({
      kind,
      count: items.length,
      medianDurationMs: medianDuration(items),
    })).sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
    messages: Number.isSafeInteger(messages) && messages >= 0 ? messages : 0,
    failed: Number.isSafeInteger(failed) && failed >= 0 ? failed : 0,
  };
}
