"use client";

import { useCallback, useRef, useState } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { useDismissibleLayer } from "../../hooks/useDismissibleLayer";
import { PopoverFrame } from "../PopoverFrame";

export function SummaryMetrics({ state, historical }: { state: MonitorState; historical: boolean }) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolMetricRef = useRef<HTMLElement | null>(null);
  const closeTools = useCallback(() => setToolsOpen(false), []);
  useDismissibleLayer(toolsOpen, toolMetricRef, closeTools);
  const toolPatterns = state.toolPatterns || [];

  return (
    <section className="summaryStrip panel" aria-label="Session summary">
      <article className="summaryItem scoreSummary" title="Deterministic attention heuristic based on repeated tool calls and overlapping edit targets; not a quality assessment.">
        <span>Flow score</span>
        <strong>{state.score}<small>/100</small></strong>
        <p>{state.score >= 85 ? "No friction signals" : state.score >= 65 ? "Review suggested" : "Friction signals found"}</p>
      </article>
      <article className="summaryItem">
        <span>Agents</span>
        <strong>{historical ? state.metrics.agents : state.metrics.activeAgents}{!historical && <small>/{state.metrics.agents}</small>}</strong>
        <p>{historical ? "Observed" : "Active now"}</p>
      </article>
      <article className="summaryItem toolMetric" ref={toolMetricRef}>
        <span>Tool calls</span>
        <strong>{state.metrics.toolCalls}</strong>
        <div className="metricFooter">
          <span>{toolPatterns.length} {toolPatterns.length === 1 ? "pattern" : "patterns"}</span>
          <button type="button" onClick={() => setToolsOpen((open) => !open)} disabled={toolPatterns.length === 0} aria-expanded={toolsOpen} aria-controls="tool-calls-popover">View list</button>
        </div>
        {toolsOpen && (
          <PopoverFrame id="tool-calls-popover" ariaLabel="Tool call breakdown" eyebrow="TOOL CALL BREAKDOWN" title={`${toolPatterns.length} tool ${toolPatterns.length === 1 ? "pattern" : "patterns"}`} closeLabel="Close tool call breakdown" onClose={closeTools} summary={`${state.metrics.toolCalls} calls grouped by agent, tool, and safe target metadata.`} className="metricPopover">
            <div className="metricPopoverList">{toolPatterns.map((pattern) => (
              <div className="metricPopoverRow" key={pattern.id}>
                <div><strong>{pattern.agent}</strong><span>{pattern.tool}{pattern.detail ? ` · ${pattern.detail}` : ""}</span></div>
                <div><strong>{pattern.calls}</strong><span>{pattern.calls === 1 ? "call" : "calls"}</span></div>
              </div>
            ))}</div>
          </PopoverFrame>
        )}
      </article>
    </section>
  );
}
