import type { Agent } from "../../../../shared/monitor-contract";
import { agentDisplayName, agentRoleLabel } from "../../../dashboard-utils";
import { roleFamilyPresentation, type RoleFamily } from "../../../role-family";
import { requestMarker, type RequestRow } from "./model";

const FAMILY_ORDER: readonly RoleFamily[] = ["neutral", "reading", "planning", "writing", "reviewing", "generic", "system"];

type RequestAgentRole = { name: string; role: string; family: RoleFamily; className: string };

/** The agent a request belongs to, as name, role label and role family; roster misses read as unknown. */
export function requestAgentRole(row: RequestRow, agents: Agent[]): RequestAgentRole {
  const agent = agents.find((candidate) => candidate.id === row.agentId);
  const { family, className } = roleFamilyPresentation(agent?.role ?? "unknown");
  return { name: agent ? agentDisplayName(agent) : "Unknown agent", role: agent ? agentRoleLabel(agent) : "unknown", family, className };
}

/**
 * Single-chart agent track: one segment under each visible bar, tinted by its agent's role family.
 * Same-role agents share a tint; the bars' accessible names carry the agent, so the track is decorative.
 */
export function RequestRoleTrack({ rows, agents, barX, width, y, height }: {
  rows: RequestRow[]; agents: Agent[]; barX: (index: number) => number; width: number; y: number; height: number;
}) {
  return <g className="requestRoleTrack" aria-hidden="true">
    {rows.map((row, index) => <rect key={row.id} className={`requestRoleSegment ${requestAgentRole(row, agents).className}`} x={barX(index)} y={y} width={width} height={height} />)}
  </g>;
}

/**
 * Legend for the track: roles present among the visible requests with distinct agent counts
 * ("explore ×3"), then the agent of the hovered or focused bar, else of the selected one.
 */
export function RequestRoleLegend({ rows, agents, named }: { rows: RequestRow[]; agents: Agent[]; named: RequestRow | undefined }) {
  const roles = new Map<string, { family: RoleFamily; className: string; agents: Set<string> }>();
  for (const row of rows) {
    const { role, family, className } = requestAgentRole(row, agents);
    const entry = roles.get(role) ?? { family, className, agents: new Set<string>() };
    entry.agents.add(row.agentId);
    roles.set(role, entry);
  }
  const entries = [...roles].sort(([leftRole, left], [rightRole, right]) => FAMILY_ORDER.indexOf(left.family) - FAMILY_ORDER.indexOf(right.family) || leftRole.localeCompare(rightRole));
  const agent = named && requestAgentRole(named, agents);
  return <div className="requestRoleLegendRow">
    <div className="sessionRoleLegend requestRoleLegend" aria-label="Agent roles in view">
      {entries.map(([role, entry]) => <span key={role}><i className={entry.className} aria-hidden="true" />{role} ×{entry.agents.size}</span>)}
    </div>
    {named && agent && <p className="requestRoleNamed"><span className="requestsActionsNumber">{requestMarker(named)}</span><strong>{agent.name}</strong><span>{agent.role}</span></p>}
  </div>;
}
