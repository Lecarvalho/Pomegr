import type { CacheReadDropCount, CacheRefillCount, ContextHistoryBoundary } from "../../../../shared/monitor-contract";
import { compactNumber, formatDuration } from "../../../dashboard-utils";
import { AgentHistoryIndicators } from "../AgentHistoryIndicators";
import { RoleGlyph } from "./RoleGlyph";
import type { AgentTreeCluster } from "./topology";

export function ClusterCard({ node, compact, collapsed, cacheRefills, cacheReadDrops, contextBoundaries }: {
  node: AgentTreeCluster; compact: boolean; collapsed: boolean;
  cacheRefills: CacheRefillCount[]; cacheReadDrops: CacheReadDropCount[]; contextBoundaries: ContextHistoryBoundary[];
}) {
  const group = node.groupKind === "workflow" || node.groupKind === "phase";
  const expandedGroup = group && !collapsed;
  const state = node.rollup.needsInput ? `${node.rollup.needsInput} need input` : node.rollup.live ? `${node.rollup.live} live` : node.rollup.finished === node.clusterCount ? `${node.clusterCount} finished` : `${node.clusterCount} agents`;
  const label = group && collapsed ? `${node.groupKind === "workflow" ? "Workflow" : "Phase"} · ${node.label}` : node.label;
  return <article className={`agentTreeCard agentTreeClusterCard ${expandedGroup ? "agentTreeGroupCard" : ""} ${collapsed ? "isCollapsed" : ""}`} title={`${label} · ${node.clusterCount} agents · ${compactNumber(node.rollup.contextSum)} context sum`}>
    {expandedGroup && <span className="agentTreeGroupBadge">{node.groupKind}</span>}
    <div className="agentTreeRole" aria-hidden="true">{expandedGroup ? <RoleGlyph role={node.groupKind === "phase" ? "reviewer" : "workflow-worker"} /> : <svg className="agentTreeRoleGlyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="3" y="7" width="14" height="12" rx="2" /><path d="M7 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" /></svg>}</div>
    <div className="agentTreeIdentity"><strong dir="auto">{label}</strong><span className="agentTreeRoleLabel">{expandedGroup ? `${node.groupPhaseCount ? `${node.groupPhaseCount} phases · ` : ""}${node.clusterCount} agents` : `${state} · ${compactNumber(node.rollup.contextSum)} context`}</span></div>
    <div className="agentTreeContext"><strong>{compact && collapsed ? "expand" : compactNumber(node.rollup.contextSum)}</strong><span>{compact && collapsed ? "" : "context sum"}</span></div>
    {(!compact || !collapsed) && <div className="agentTreeEvidence"><AgentHistoryIndicators agentIds={node.clusterIds} boundaries={contextBoundaries} cacheRefills={cacheRefills} cacheReadDrops={cacheReadDrops} className="agentTreeHistoryIndicators" /><span className="agentTreeStatus">{node.groupStatus || state}</span>{node.groupWallTimeMs != null && <span className="agentTreeWall">{formatDuration(node.groupWallTimeMs)} wall</span>}</div>}
  </article>;
}
