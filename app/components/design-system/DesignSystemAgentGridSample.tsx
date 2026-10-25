import type { Agent, Insight } from "../../../shared/monitor-contract";
import { AgentGridFooter, AgentGridToolbar, AgentGridView } from "../dashboard/agent-roster/AgentGridView";
import { buildRosterGroups } from "../dashboard/agent-roster/groups";
import { Sample, SAMPLE_TIME, Section, sampleAgent } from "./DesignSystemKit";

const TILE_STATES = [
  ["finished", "Finished tile", "finished"],
  ["idle", "Idle tile", "idle"],
  ["active", "Active tile", "active"],
  ["stopped", "Stopped tile", "stopped"],
  ["warning", "Warning tile", "idle"],
  ["selected", "Selected tile", "active"],
] as const;
const AGENTS: Agent[] = TILE_STATES.map(([id, label, status], index) => ({
  ...sampleAgent(id, label, "builder"), status, workflowOrder: index,
  toolCalls: (index + 1) * 10, durationMs: (index + 1) * 60_000,
  tokens: { total: (index + 1) * 10_000, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
}));
const GROUPS = buildRosterGroups(AGENTS, [], { now: SAMPLE_TIME });
const INSIGHTS: Insight[] = [{ id: "sample-warning", level: "warning", title: "Repeated reads", detail: "Recorded repeated-call pattern", agentId: "warning" }];
const METRICS = [["context", "Latest context"], ["wall", "Wall time"], ["toolCalls", "Tool calls"]] as const;

export function AgentGridSection() {
  return <Section id="agent-grid" title="Agent grid tile states" lede="The shipped grid shows finished, idle, active, stopped, warning, and selected tiles for each metric. All values are illustrative and fixed.">
    <div className="designSystemRows">
      {METRICS.map(([metric, label]) => <Sample key={metric} label={label}>
        <div className="agentRosterPanel designSystemGridFrame">
          <div className="rosterMain">
            <AgentGridToolbar metric={metric} historical={false} onChange={() => undefined} />
            <AgentGridView groups={GROUPS} agents={AGENTS} selectedAgentId="selected" onSelect={() => undefined} insights={INSIGHTS} metric={metric} historical={false} now={SAMPLE_TIME} />
            <AgentGridFooter />
          </div>
        </div>
      </Sample>)}
    </div>
    <p className="designSystemNote">Idle borders are dashed; active is green, stopped is red, warning is amber, and selected is coral. Lane headers and tile metric labels use the shared grid classes. Each bar is relative to the largest agent. Controls keep these static samples unchanged.</p>
  </Section>;
}
