import { normalizedWorkKind, toolWorkKind } from "./work-kind.mjs";

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
    }];
  });
}

export function recentActivityEvents(events, maximum = 30) {
  const limit = Number.isInteger(maximum) ? Math.max(0, maximum) : 30;
  return [...events]
    .sort((left, right) => (
      Date.parse(right.timestamp) - Date.parse(left.timestamp)
      || String(left.id).localeCompare(String(right.id))
    ))
    .slice(0, limit)
    .map(({ id, timestamp, actor, tool, workKind, detail, status }) => ({
      id,
      timestamp,
      actor,
      tool,
      workKind: normalizedWorkKind(workKind, toolWorkKind(tool, { detail })),
      detail,
      status: status === "failed" ? "failed" : null,
    }));
}
