"use client";

import { useState } from "react";
import type { Agent, AgentRole, LoopPattern, PlanTask, Workflow } from "../../../shared/monitor-contract";
import { LiveClockProvider } from "../../hooks/LiveClockContext";
import { AgentActivityPanel, type AgentActivityViewMode } from "../dashboard/AgentActivityPanel";
import { AgentInspector } from "../dashboard/agent-roster/AgentInspector";
import { Sample, Section, sampleAgent } from "./DesignSystemKit";

// Static roster sample. Every status is non-advancing (no active or waiting agent), so wall times
// stay frozen and the server and client render the same text; nothing here reads session state.
const WORKFLOW_ID = "sample-test-sweep";
const context = (total: number) => ({ total, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function rosterAgent(id: string, label: string, role: AgentRole, extra: Partial<Agent> = {}, workflowId: string | null = null): Agent {
  return { ...sampleAgent(id, label, role, workflowId), ...extra };
}

const worker = (id: string, label: string, role: AgentRole, order: number, phase: string, extra: Partial<Agent>) =>
  rosterAgent(id, label, role, { workflowOrder: order, workflowPhaseId: phase, toolCalls: 18 + order * 7, durationMs: 420_000 + order * 60_000, tokens: context(21_000 + order * 3_800), ...extra }, WORKFLOW_ID);

const ROSTER_AGENTS: Agent[] = [
  rosterAgent("primary", "Primary agent", "orchestrator", { status: "idle", toolCalls: 212, durationMs: 4_320_000, tokens: context(142_300), cacheLifetime: "1h" }),
  rosterAgent("explore", "Map the request feed", "explore", { toolCalls: 41, durationMs: 780_000, tokens: context(38_400), cacheLifetime: "5m" }),
  rosterAgent("plan", "Plan lane collapse", "plan", { toolCalls: 12, durationMs: 300_000, tokens: context(24_900), assignment: "Decide when lanes collapse into groups", cacheLifetime: "mixed" }),
  rosterAgent("review", "Review the chart diff", "reviewer", { status: "needs_input", toolCalls: 29, durationMs: 960_000, tokens: context(51_700) }),
  worker("wk-1a3f01", "Lane model tests", "builder", 1, "write", {}),
  worker("wk-2b4e02", "Label geometry tests", "builder", 2, "write", {}),
  worker("wk-3c5d03", "Collapse tests", "tester", 3, "verify", { status: "idle", skills: [{ name: "verify-ui", calls: 3, lastUsed: null }, { name: "capture-shot", calls: 1, lastUsed: null }], assignment: "Verify collapse at eight lanes" }),
  worker("wk-4d6c04", "Focus tests", "tester", 4, "verify", { status: "stopped" }),
];

const ROSTER_WORKFLOWS: Workflow[] = [{
  id: WORKFLOW_ID, name: "Test sweep", summary: null, status: "running", metadataStatus: "ready", startedAt: null, updatedAt: null, durationMs: 0,
  agentIds: ["wk-1a3f01", "wk-2b4e02", "wk-3c5d03", "wk-4d6c04"],
  phases: [{ id: "write", label: "Write", agentIds: ["wk-1a3f01", "wk-2b4e02"] }, { id: "verify", label: "Verify", agentIds: ["wk-3c5d03", "wk-4d6c04"] }],
}];

const ROSTER_LOOPS: LoopPattern[] = [{ id: "loop-review", agent: "Review the chart diff", agentId: "review", tool: "Read", detail: "Repeated reads", calls: 6, repeats: 3 }];

const ROSTER_PLAN: PlanTask[] = [
  { id: "1", subject: "Map the request feed", status: "completed", blocks: ["2"], blockedBy: [] },
  { id: "2", subject: "Collapse lanes past eight", status: "in_progress", blocks: ["3"], blockedBy: ["1"] },
  { id: "3", subject: "Verify the phone layout", status: "pending", blocks: [], blockedBy: ["2"] },
];

export function AgentRosterSection() {
  const [viewMode, setViewMode] = useState<AgentActivityViewMode>("list");
  return <Section id="agent-roster" title="Agent roster" lede="AgentActivityPanel renders the session roster from static agents: a pinned, selected primary row, an open workflow group with phase progress, a collapsed Direct subagents group with its rollup, the status distribution strip, filters, and the inline inspector column. The List / Grid switch also draws the tile grid.">
    <LiveClockProvider running={false}>
      <AgentActivityPanel agents={ROSTER_AGENTS} executionTasks={[]} planTasks={ROSTER_PLAN} historical={false} workflows={ROSTER_WORKFLOWS} loops={ROSTER_LOOPS}
        workflowNavigation={{ id: WORKFLOW_ID, request: 1 }} sessionId="design-system-roster" viewMode={viewMode} onViewModeChange={setViewMode} />
    </LiveClockProvider>
    <p className="designSystemNote">Status pills and the distribution strip keep lifecycle meaning: neutral for idle and finished, amber for needs input, red for stopped. The repeat chip marks a recorded repeated-call pattern, never a judgment. The primary row and group headers stay sticky while the region scrolls; columns omit Calls and Cache TTL from 761 to 1250px, and the inspector keeps them. At 760px and narrower the inspector column is replaced by the full-screen InspectorSheet, which opens when a row is tapped.</p>
  </Section>;
}

const INSPECTED = ROSTER_AGENTS[6];

export function AgentInspectorSection() {
  return <Section id="agent-inspector" title="Agent inspector" lede="AgentInspector is the 340px inline column: status, role, workflow and phase, the lineage rail with context snapshots, facts, skills, signals, and full-width exits. This sample inspects a workflow worker so the lineage shows its workflow and phase rows.">
    <LiveClockProvider running={false}>
      <Sample label="Inline column" note="Lineage contexts are latest snapshots or sums of them. The same stack is the body of InspectorSheet on phone, with 44px targets.">
        <div className="designSystemInspectorFrame">
          <AgentInspector agent={INSPECTED} agents={ROSTER_AGENTS} workflows={ROSTER_WORKFLOWS} onOpenTree={() => undefined} onOpenActivities={() => undefined} />
        </div>
      </Sample>
    </LiveClockProvider>
  </Section>;
}
