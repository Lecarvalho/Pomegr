import type { Agent, ExecutionTask, SessionSummary } from "../shared/monitor-contract";

export function relativeTime(value: string | null, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function minuteRelativeTime(value: string | null, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return "less than a minute ago";
  const minutes = Math.floor(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

export function shortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function sessionListTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function stateEndpoint(sessionId: string | null) {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  return `/api/state${params.size ? `?${params}` : ""}`;
}

export function groupSessionsByProject(sessions: SessionSummary[]) {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const project = session.project || "Unknown project";
    groups.set(project, [...(groups.get(project) || []), session]);
  }
  return [...groups].map(([project, projectSessions]) => ({ project, sessions: projectSessions }));
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10_000 ? 1 : 0,
  }).format(value);
}

export function formatDuration(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours === 0 ? `${minutes}m` : `${hours}h ${minutes}m`;
}

export function formatBucketDuration(milliseconds: number) {
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return hours < 24 ? `${hours}h` : `${hours / 24}d`;
}

export function timelineTime(value: string, includeDate = false) {
  return new Intl.DateTimeFormat(undefined, includeDate
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function gitStatusLabel(status: string) {
  if (status === "??") return "NEW";
  if (status.includes("D")) return "DEL";
  if (status.includes("R")) return "REN";
  if (status.includes("A")) return "ADD";
  if (status.includes("U")) return "CONFLICT";
  return "MOD";
}

export function gitPathParts(filePath: string) {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separator < 0
    ? { directory: "", filename: filePath }
    : { directory: filePath.slice(0, separator + 1), filename: filePath.slice(separator + 1) };
}

export function resetCountdown(value: string | null, now = Date.now()) {
  if (!value) return "Reset unavailable";
  const milliseconds = new Date(value).getTime() - now;
  if (milliseconds <= 0) return "Resetting now";
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `Resets in ${days}d ${hours}h`;
  if (hours) return `Resets in ${hours}h ${minutes}m`;
  return `Resets in ${minutes}m`;
}

export function agentTreeRows(agents: Agent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      children.set(agent.parentId, [...(children.get(agent.parentId) || []), agent]);
    } else roots.push(agent);
  }
  roots.sort((a, b) => (a.id === "primary" ? -1 : b.id === "primary" ? 1 : 0));
  const rows: Array<{ agent: Agent; depth: number }> = [];
  const visited = new Set<string>();
  const visit = (agent: Agent, depth: number) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    rows.push({ agent, depth });
    for (const child of children.get(agent.id) || []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const agent of agents) visit(agent, 0);
  return rows;
}

export function executionTaskDuration(task: ExecutionTask, now = Date.now()) {
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  return Math.max(0, end - new Date(task.startedAt).getTime());
}
