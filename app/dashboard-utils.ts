import type { Agent, CacheLifetime, ExecutionTask, SessionSummary } from "../shared/monitor-contract";

export function relativeTime(value: string | null, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((now - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "just now";
  // Relative timestamps stay minute-granular so the dashboard never counts seconds.
  if (seconds < 60) return "<1m ago";
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

export function coarseRelativeTime(value: string | null, now = Date.now()) {
  if (!value) return "â€”";
  const minutes = Math.max(0, Math.floor((now - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function sessionRelativeTime(value: string | null, now = Date.now()) {
  if (!value) return "—";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return "<1m";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function shortTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function sessionListTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function stateEndpoint(sessionId: string | null, revision: number | string | null = null) {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (revision !== null && revision !== undefined) params.set("revision", String(revision));
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

export function newestSessionsFirst<T extends SessionSummary>(sessions: T[]) {
  const timestamp = (session: T) => {
    const value = Date.parse(session.createdAt || session.updatedAt || "");
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  };
  return [...sessions].sort((left, right) => timestamp(right) - timestamp(left) || left.id.localeCompare(right.id));
}

export function sessionNeedingAttention(sessions: SessionSummary[], currentSessionId: string | null, viewingHistory: boolean) {
  if (!currentSessionId || viewingHistory) return null;
  return sessions.find((session) => session.id === currentSessionId && session.isLive && session.needsInput) || null;
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

export function retryCountdown(value: string | null, now = Date.now()) {
  if (!value) return "Retry timing unavailable";
  const milliseconds = new Date(value).getTime() - now;
  if (!Number.isFinite(milliseconds)) return "Retry timing unavailable";
  if (milliseconds <= 0) return "Retry queued";
  const totalMinutes = Math.ceil(milliseconds / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `Next retry in ${hours}h ${minutes}m`;
  return `Next retry in ${totalMinutes}m`;
}

export function agentTreeRows(agents: Agent[]) {
  const compareCreation = (left: Agent, right: Agent) => {
    const leftStartedAt = Date.parse(left.startedAt || "");
    const rightStartedAt = Date.parse(right.startedAt || "");
    const leftTimestamp = Number.isFinite(leftStartedAt) ? leftStartedAt : Number.NEGATIVE_INFINITY;
    const rightTimestamp = Number.isFinite(rightStartedAt) ? rightStartedAt : Number.NEGATIVE_INFINITY;
    return rightTimestamp - leftTimestamp || left.id.localeCompare(right.id);
  };
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  const roots: Agent[] = [];
  for (const agent of agents) {
    if (agent.parentId && agent.parentId !== agent.id && byId.has(agent.parentId)) {
      children.set(agent.parentId, [...(children.get(agent.parentId) || []), agent]);
    } else roots.push(agent);
  }
  for (const siblings of children.values()) siblings.sort(compareCreation);
  roots.sort((left, right) => (
    left.id === "primary" ? -1 : right.id === "primary" ? 1 : compareCreation(left, right)
  ));
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

export function cacheLifetimeLabel(value: CacheLifetime | null | undefined) {
  return `cache TTL ${value || "unavailable"}`;
}

export function agentAssignment(agent: Pick<Agent, "assignment" | "label">) {
  const assignment = typeof agent.assignment === "string" ? agent.assignment.trim() : "";
  if (!assignment || assignment.toLocaleLowerCase() === agent.label.trim().toLocaleLowerCase()) return null;
  return assignment;
}

export function agentDisplayName(agent: Pick<Agent, "assignment" | "label">) {
  return agentAssignment(agent) || agent.label;
}

export function agentDisplayLabel(agent: Pick<Agent, "assignment" | "label">) {
  const assignment = agentAssignment(agent);
  return assignment ? `${assignment} — ${agent.label}` : agent.label;
}

const FINISHED_AGENT_STATUSES = new Set<Agent["status"]>(["finished", "stopped"]);

export function agentsWithFinishedVisibility(agents: Agent[], showFinished: boolean) {
  if (showFinished) return agents;

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const visibleIds = new Set(
    agents
      .filter((agent) => agent.id === "primary" || !FINISHED_AGENT_STATUSES.has(agent.status))
      .map((agent) => agent.id),
  );

  for (const agent of agents) {
    if (!visibleIds.has(agent.id)) continue;
    const visited = new Set<string>([agent.id]);
    let parentId = agent.parentId;
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      visibleIds.add(parent.id);
      parentId = parent.parentId;
    }
  }

  return agents.filter((agent) => visibleIds.has(agent.id));
}

export function executionTaskDuration(task: ExecutionTask, now = Date.now()) {
  const end = task.finishedAt ? new Date(task.finishedAt).getTime() : now;
  return Math.max(0, end - new Date(task.startedAt).getTime());
}
