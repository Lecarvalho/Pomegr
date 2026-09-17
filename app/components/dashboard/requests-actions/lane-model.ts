import type { Agent } from "../../../../shared/monitor-contract";
import { agentTreeRows } from "../../../dashboard-utils";
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
