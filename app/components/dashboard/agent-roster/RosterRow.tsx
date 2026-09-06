import type { CSSProperties, Ref } from "react";
import type { Agent, CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary, ExecutionTask, Insight, LoopPattern } from "../../../../shared/monitor-contract";
import { agentAssignment, agentDisplayLabel, agentDisplayName, cacheLifetimeLabel, compactNumber } from "../../../dashboard-utils";
import { AgentWallTimeText } from "../../LiveTime";
import { AgentChip } from "../../AgentChip";
import { AgentHistoryIndicators } from "../AgentHistoryIndicators";
import { RoleGlyph } from "../agent-tree/RoleGlyph";

export function RosterCaret() { return <svg className="rosterCaret" aria-hidden="true" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" /></svg>; }

export function RosterRow({ agent, depth, selected, onSelect, insights, loops, executionTasks, cacheRefills, cacheReadDrops, contextBoundaries, rowRef }: {
  agent: Agent; depth: number; selected: boolean; onSelect: (id: string) => void; insights: Insight[]; loops: LoopPattern[]; executionTasks: ExecutionTask[]; cacheRefills: CacheRefillCount[]; cacheReadDrops: CacheReadDropCount[]; contextBoundaries: ContextHistoryBoundary[]; rowRef?: Ref<HTMLDivElement>;
}) {
  const loop = loops.find((item) => item.agentId === agent.id);
  const repeated = loop || insights.some((item) => item.agentId === agent.id && item.id.startsWith("loop-"));
  const shellCount = (agent.executionTasks || (agent.id === "primary" ? executionTasks : [])).length;
  const status = <span className={`statusPill ${agent.status}`}>{agent.status === "needs_input" ? "needs input" : agent.status}</span>;
  return <div ref={rowRef} role="row" aria-label={`${agentDisplayLabel(agent)} agent, ${cacheLifetimeLabel(agent.cacheLifetime)}`} aria-selected={selected} className={`rosterRow ${agent.id === "primary" ? "rosterPrimary" : ""} ${selected ? "rosterSelected" : ""}`} style={{ "--agent-indent": `${Math.min(depth, 8) * 12}px` } as CSSProperties}>
    <span className="rosterRole"><RoleGlyph role={agent.role || "unknown"} /></span>
    <div className="rosterIdentity">
      <div className="rosterNameLine"><button className="rosterSelectAgent" type="button" aria-label={`Select ${agentDisplayName(agent)}`} aria-pressed={selected} onClick={() => onSelect(agent.id)}><strong dir="auto">{agentDisplayName(agent)}</strong></button>
        {repeated && <span className="rosterRepeat">repeat{loop ? ` ×${loop.repeats}` : ""}</span>}
        <AgentHistoryIndicators agentIds={[agent.id]} boundaries={contextBoundaries} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} />
        {agent.signal && <AgentChip className={`agentSignal ${agent.signal.tone}`} title={agent.signal.description || "Reported by this agent through the Pomegr MCP tool"}>{agent.signal.label}</AgentChip>}
      </div>
      <span className="rosterMeta rosterDesktop">{agentAssignment(agent) && <span className="agentMetaIdentity">{agent.label} · </span>}{agent.role} · {agent.model} · {agent.effort} · {agent.skills.length > 0 ? `${agent.skills.length} skills · ` : ""}{shellCount} shell tasks</span>
      <span className="rosterMeta rosterPhone">{agentAssignment(agent) ? `${agent.label} · ` : ""}{agent.role} · {agent.model} · {agent.toolCalls} calls</span>
    </div>
    <div className="rosterContext" title="Latest non-zero provider usage snapshot; not cumulative token use."><strong>{compactNumber(agent.tokens.total)}</strong><span className="rosterPhone rosterPhoneState"><AgentWallTimeText agent={agent} /> · {status}</span></div>
    <span className="rosterNumber rosterDesktop"><AgentWallTimeText agent={agent} /></span>
    <span className="rosterNumber rosterDesktop">{agent.toolCalls.toLocaleString()}</span>
    <span className="rosterNumber rosterDesktop rosterTtl">{cacheLifetimeLabel(agent.cacheLifetime).replace("cache TTL ", "")}</span>
    <span className="rosterDesktop rosterStatus">{status}</span>
    <RosterCaret />
  </div>;
}
