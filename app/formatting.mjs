export function formatWallTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatAgentWallTime(agent, now = Date.now()) {
  const startedAt = new Date(agent.startedAt).getTime();
  const running = agent.status === "active" || agent.status === "waiting";
  const liveDuration = running && Number.isFinite(startedAt) ? now - startedAt : 0;
  return formatWallTime(Math.max(Number(agent.durationMs || 0), liveDuration));
}

export function formatExecutionTaskWallTime(task, now = Date.now()) {
  const startedAt = new Date(task.startedAt).getTime();
  const finishedAt = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  return formatWallTime(finishedAt - startedAt);
}
