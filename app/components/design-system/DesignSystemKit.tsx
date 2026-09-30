import type { ReactNode } from "react";
import type { Agent, AgentRole } from "../../../shared/monitor-contract";

// Shared building blocks for the static /design-system samples. The page stays static-data-only:
// nothing here reads a store, a route, or the network. One exception: the agent roster sample's viewer
// choices persist in browser localStorage under the session ID "design-system-roster" (see DSG-9 in
// docs/internal/plans/design-system-gaps.md), so a stored choice can change that sample's initial state.
export function Section({ id, title, lede, children }: { id: string; title: string; lede?: string; children: ReactNode }) {
  const headingId = `design-system-${id}`;
  return <section className="designSystemSection" aria-labelledby={headingId}>
    <h2 id={headingId}>{title}</h2>
    {lede && <p className="designSystemLede">{lede}</p>}
    {children}
  </section>;
}

export function Sample({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return <div className="designSystemSample">
    <span>{label}</span>
    <div className="designSystemSampleBody">{children}</div>
    {note && <small>{note}</small>}
  </div>;
}

export const SAMPLE_TIME = Date.parse("2026-08-09T12:00:00.000Z");

export function sampleAgent(id: string, label: string, role: AgentRole, workflowId: string | null = null): Agent {
  const seen = new Date(SAMPLE_TIME).toISOString();
  return {
    id, parentId: id === "primary" ? null : "primary", workflowId, workflowPhaseId: null, workflowOrder: null, workflowState: workflowId ? "done" : null,
    label, role, model: id === "primary" ? "large-model" : "small-model", effort: "medium", status: "finished", signal: null, toolCalls: 0, skills: [],
    lastSeen: seen, startedAt: seen, updatedAt: seen, durationMs: 0, cacheLifetime: "1h", tokens: { total: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
  };
}
