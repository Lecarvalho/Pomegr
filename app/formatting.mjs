export function formatWallTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function liveWallTimeMs(recordedDurationMs, startedAt, running, now = Date.now()) {
  const recordedDuration = Math.max(0, Number(recordedDurationMs || 0));
  const startedAtMs = typeof startedAt === "string" && startedAt
    ? new Date(startedAt).getTime()
    : Number.NaN;
  const frontendDuration = running && Number.isFinite(startedAtMs) ? now - startedAtMs : 0;
  return Math.max(recordedDuration, frontendDuration);
}

export function formatAgentWallTime(agent, now = Date.now()) {
  const running = agent.status === "active" || agent.status === "waiting";
  return formatWallTime(liveWallTimeMs(agent.durationMs, agent.startedAt, running, now));
}

export function formatAgentRowWallTime(agent, now = Date.now()) {
  const running = agent.status === "active" || agent.status === "waiting";
  const durationMs = liveWallTimeMs(agent.durationMs, agent.startedAt, running, now);
  if (durationMs < 60_000) return "<1m";
  const totalMinutes = Math.floor(durationMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatExecutionTaskWallTime(task, now = Date.now()) {
  const startedAt = new Date(task.startedAt).getTime();
  const finishedAt = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  return formatWallTime(finishedAt - startedAt);
}
