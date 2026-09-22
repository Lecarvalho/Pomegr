import type { Agent, Workflow } from "../../../../shared/monitor-contract";
import { agentTreeRows } from "../../../dashboard-utils";
import { buildRosterGroups } from "../agent-roster/groups";
import { scaleMax, type ChartMode, type RequestRow } from "./model";

export const COMPACTION_LANE_ID = "compaction";

export type RequestLane = {
  /** `agent:<agentId>`, or `COMPACTION_LANE_ID` for the shared compaction lane. */
  id: string;
  kind: "agent" | "compaction";
  /** Null for the compaction lane, which can hold requests from several compaction agents. */
  agentId: string | null;
  /** The taller main lane: the primary agent, or the first lane when it is absent. */
  primary: boolean;
  /** Loaded rows owned by this lane, in request order. */
  rows: RequestRow[];
  /** Readable per-lane scale over the lane's loaded rows; always at least 1. */
  maximum: number;
};

/**
 * Assigns every loaded request to exactly one lane. Requests issued by compaction agents share
 * one compaction lane; every other request stays in its agent's lane, including agents absent
 * from the roster. Lanes appear only for agents with loaded requests.
 */
export function buildRequestLanes(rows: RequestRow[], agents: Agent[], mode: ChartMode, cacheWriteAvailable: boolean): {
  lanes: RequestLane[];
  laneByRequest: Map<string, string>;
} {
  const roleById = new Map(agents.map((agent) => [agent.id, agent.role]));
  const laneId = (agentId: string) => roleById.get(agentId) === "compaction" ? COMPACTION_LANE_ID : `agent:${agentId}`;
  const rowsByLane = new Map<string, RequestRow[]>();
  const laneByRequest = new Map<string, string>();
  for (const row of rows) {
    const id = laneId(row.agentId);
    const laneRows = rowsByLane.get(id);
    if (laneRows) laneRows.push(row);
    else rowsByLane.set(id, [row]);
    laneByRequest.set(row.id, id);
  }

  // Roster order (primary first), then agents missing from the roster, then compactions.
  const ids = [...new Set([...agentTreeRows(agents).map(({ agent }) => laneId(agent.id)), ...rowsByLane.keys()])]
    .filter((id) => id !== COMPACTION_LANE_ID && rowsByLane.has(id));
  if (rowsByLane.has(COMPACTION_LANE_ID)) ids.push(COMPACTION_LANE_ID);
  const primaryId = ids.includes("agent:primary") ? "agent:primary" : ids[0];

  const lanes = ids.map((id): RequestLane => {
    const laneRows = rowsByLane.get(id) ?? [];
    const compaction = id === COMPACTION_LANE_ID;
    return {
      id,
      kind: compaction ? "compaction" : "agent",
      agentId: compaction ? null : id.slice("agent:".length),
      primary: id === primaryId,
      rows: laneRows,
      maximum: Math.max(1, scaleMax(laneRows, mode, cacheWriteAvailable)),
    };
  });
  return { lanes, laneByRequest };
}

/** More lanes than this collapse by workflow group. */
export const LANE_COLLAPSE_THRESHOLD = 8;

export type RequestLaneGroup = {
  /** The Agents tab roster group id: `direct`, `workflow:<id>` or `workflow:unknown`. */
  id: string;
  title: string;
  kind: "direct" | "workflow";
  /** Non-compaction roster members, so the count does not change while paging. */
  members: number;
  /** Loaded member lanes, in lane order. */
  lanes: RequestLane[];
  /** Loaded rows of every member lane, in request order. */
  rows: RequestRow[];
  maximum: number;
};

export type RequestLaneRow =
  | { kind: "lane"; id: string; lane: RequestLane; member: boolean }
  | { kind: "group"; id: string; group: RequestLaneGroup }
  | { kind: "groupHeader"; id: string; group: RequestLaneGroup };

/**
 * Orders lanes into display rows. With more than eight roster lanes and no agent scope, every
 * non-primary roster group with two or more members becomes one collapsed row drawing all its
 * members' requests, or a header followed by its member lanes when expanded. The primary lane,
 * the compaction lane and agents missing from the roster never collapse. `rowByRequest` names the
 * one row that draws each request.
 */
export function layoutRequestLanes(lanes: RequestLane[], agents: Agent[], workflows: Workflow[], expanded: ReadonlySet<string>, { scoped, mode, cacheWriteAvailable }: {
  scoped: boolean; mode: ChartMode; cacheWriteAvailable: boolean;
}): { rows: RequestLaneRow[]; rowByRequest: Map<string, string> } {
  const agentsOnly = agents.filter((agent) => agent.role !== "compaction");
  const rosterIds = new Set(agentsOnly.map((agent) => `agent:${agent.id}`));
  const laneCount = rosterIds.size + (agents.length > agentsOnly.length ? 1 : 0)
    + lanes.filter((lane) => lane.kind === "agent" && !rosterIds.has(lane.id)).length;
  const plain = (lane: RequestLane, member = false): RequestLaneRow => ({ kind: "lane", id: lane.id, lane, member });
  let rows: RequestLaneRow[] = lanes.map((lane) => plain(lane));
  if (!scoped && laneCount > LANE_COLLAPSE_THRESHOLD) {
    const placed = new Set<string>();
    const primary = lanes.find((lane) => lane.id === "agent:primary");
    rows = primary ? [plain(primary)] : [];
    if (primary) placed.add(primary.id);
    for (const roster of buildRosterGroups(agentsOnly, workflows)) {
      if (roster.kind === "primary") continue;
      const memberIds = new Set(roster.agents.map((agent) => `agent:${agent.id}`));
      const members = lanes.filter((lane) => memberIds.has(lane.id) && !placed.has(lane.id));
      members.forEach((lane) => placed.add(lane.id));
      if (!members.length) continue;
      if (roster.agents.length < 2) {
        rows.push(...members.map((lane) => plain(lane)));
        continue;
      }
      const groupRows = members.flatMap((lane) => lane.rows).sort((left, right) => left.ordinal - right.ordinal);
      const group: RequestLaneGroup = {
        id: roster.id, title: roster.title, kind: roster.kind === "direct" ? "direct" : "workflow", members: roster.agents.length,
        lanes: members, rows: groupRows, maximum: Math.max(1, scaleMax(groupRows, mode, cacheWriteAvailable)),
      };
      if (expanded.has(group.id)) rows.push({ kind: "groupHeader", id: `group:${group.id}`, group }, ...members.map((lane) => plain(lane, true)));
      else rows.push({ kind: "group", id: `group:${group.id}`, group });
    }
    rows.push(...lanes.filter((lane) => !placed.has(lane.id) && lane.kind === "agent").map((lane) => plain(lane)));
    rows.push(...lanes.filter((lane) => lane.kind === "compaction").map((lane) => plain(lane)));
  }
  const rowByRequest = new Map<string, string>();
  for (const row of rows) {
    if (row.kind === "groupHeader") continue;
    for (const request of row.kind === "group" ? row.group.rows : row.lane.rows) rowByRequest.set(request.id, row.id);
  }
  return { rows, rowByRequest };
}
