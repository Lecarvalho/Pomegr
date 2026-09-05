import type { Agent, Insight } from "../../../../shared/monitor-contract";
import { agentDisplayName, compactNumber, formatDuration } from "../../../dashboard-utils";
import { liveWallTimeMs } from "../../../formatting.mjs";
import { EmptyState } from "../../EmptyState";
import type { RosterGroup } from "./groups";

export type AgentGridMetric = "context" | "wall" | "toolCalls";

export function readGridMetric(sessionId: string): AgentGridMetric {
  try {
    const stored = window.localStorage.getItem(`pomegr-agent-grid-metric-${sessionId}`);
    if (stored === "wall" || stored === "toolCalls") return stored;
  } catch { /* Local preferences are optional. */ }
  return "context";
}

export function AgentGridToolbar({ metric, onChange, historical }: { metric: AgentGridMetric; onChange: (metric: AgentGridMetric) => void; historical: boolean }) {
  const choices = [["context", historical ? "Final context" : "Latest context"], ["wall", "Wall time"], ["toolCalls", "Tool calls"]] as const;
  return <div className="agentGridToolbar" role="group" aria-label="Tile bar metric">
    <span className="sessionEyebrow">Tile bar</span>
    {choices.map(([value, label]) => <button type="button" key={value} aria-pressed={metric === value} onClick={() => onChange(value)}>{label}</button>)}
  </div>;
}

function metricValue(agent: Agent, metric: AgentGridMetric, historical: boolean, now: number) {
  const value = metric === "context" ? agent.tokens.total : metric === "toolCalls" ? agent.toolCalls
    : liveWallTimeMs(agent.durationMs, agent.startedAt, !historical && ["active", "waiting"].includes(agent.status), now);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function metricText(value: number, metric: AgentGridMetric) {
  return metric === "wall" ? formatDuration(value) : metric === "toolCalls" ? `${compactNumber(value)} calls` : compactNumber(value);
}

function statusSummary(group: RosterGroup) {
  return Object.entries(group.rollup.statuses).filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(" · ");
}

/** Filters only affect the tiles. Every metric shares one scale across the whole session. */
function GridTreeGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="19" r="2" /><path d="M12 7v5m0 0-6 5m6-5 6 5" /></svg>; }

export function AgentGridView({ groups, agents, selectedAgentId, onSelect, onOpenTree, insights, metric, historical, now, tileRef }: {
  groups: RosterGroup[]; agents: Agent[]; selectedAgentId: string | null; onSelect: (id: string) => void; onOpenTree?: (id: string) => void;
  insights: Insight[]; metric: AgentGridMetric; historical: boolean; now: number;
  tileRef?: (id: string, element: HTMLButtonElement | null) => void;
}) {
  const values = new Map(agents.map((agent) => [agent.id, metricValue(agent, metric, historical, now)]));
  const maximum = Math.max(0, ...values.values());
  const warnings = new Set(insights.filter((insight) => insight.level === "warning" && insight.agentId).map((insight) => insight.agentId));
  const visibleGroups = groups.filter((group) => group.agents.length > 0);
  return <div className={`agentGridView agentGridMetric-${metric}`}>
    {visibleGroups.length === 0 && <EmptyState text={agents.length ? "No agents match these filters." : "No agents have appeared in this session yet."} />}
    {visibleGroups.map((group) => <section className="agentGridLane" key={group.id} aria-label={group.title}>
      <header>
        <div className="agentGridLaneTitle"><strong>{group.kind === "workflow" ? "Workflow · " : ""}{group.title}</strong>{group.agents[0] && onOpenTree && <button type="button" className="agentGridOpenTree" aria-label="Open in tree" title={`Open ${group.title} in tree`} onClick={() => onOpenTree(group.agents[0].id)}><GridTreeGlyph /></button>}</div>
        <span>{group.kind === "primary" ? group.agents[0].role : `${group.agents.length} agents`} · {statusSummary(group)}</span>
        <span className="agentGridRollup"><b>{compactNumber(group.rollup.context)}</b> context · <b>{formatDuration(group.rollup.wallMs)}</b> wall · <b>{compactNumber(group.rollup.toolCalls)}</b> calls</span>
      </header>
      <div className="agentGridTiles">{group.agents.map((agent) => {
        const value = values.get(agent.id) || 0;
        const name = agentDisplayName(agent);
        const warning = warnings.has(agent.id);
        const status = agent.status.replaceAll("_", " ");
        const description = `${name} · ${status}${warning ? " · warning signal" : ""} · ${metricText(value, metric)}${metric === "context" ? " context" : metric === "wall" ? " wall time" : ""}`;
        return <button type="button" key={agent.id} ref={(element) => tileRef?.(agent.id, element)} aria-label={`Select ${name}`} aria-pressed={selectedAgentId === agent.id} title={description}
          className={`agentGridTile agentGridStatus-${agent.status}${warning ? " agentGridWarning" : ""}${selectedAgentId === agent.id ? " agentGridSelected" : ""}`} onClick={() => onSelect(agent.id)}>
          <strong dir="auto">{name}</strong>
          <span className="agentGridTileMetrics"><span>{metric === "toolCalls" ? status : `${compactNumber(agent.toolCalls)} calls`}</span><b>{metricText(value, metric)}</b></span>
          <span className="srOnly">{status}{warning ? ", warning signal" : ""}</span>
          <i className="agentGridBar" aria-hidden="true" style={{ width: `${maximum > 0 ? value / maximum * 100 : 0}%` }} />
        </button>;
      })}</div>
    </section>)}
  </div>;
}

export function AgentGridFooter() {
  return <footer className="rosterFooter agentGridFooter"><span>Click a tile to open it in the inspector · bar length is the tile metric relative to the largest agent in the session</span><span>Latest snapshots only, never cumulative spend</span></footer>;
}
