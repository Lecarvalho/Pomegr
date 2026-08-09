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
  const ringStyle = { background: `conic-gradient(var(--green) ${state.score * 3.6}deg, var(--line) 0deg)` };

  return (
    <section className="summaryGrid" aria-label="Session summary">
      <article className="scoreCard panel">
        <div className="scoreRing" style={ringStyle}><div><strong>{state.score}</strong><span>/100</span></div></div>
        <div><span className="label">FLOW SCORE</span><h2>{state.score >= 85 ? "Running cleanly" : state.score >= 65 ? "Worth a look" : "Friction detected"}</h2><p>Based on repeated calls, agent overlap, and waiting patterns.</p></div>
      </article>
      <article className="metric panel">
        <span className="metricIcon agentsIcon">⌁</span>
        <div><span className="label">AGENTS</span><strong>{historical ? state.metrics.agents : state.metrics.activeAgents}{!historical && <small> / {state.metrics.agents}</small>}</strong></div>
        <p>{historical ? "observed in session" : "running now"}</p>
      </article>
      <article className="metric panel toolMetric" ref={toolMetricRef}>
        <span className="metricIcon toolIcon">⌘</span>
        <div><span className="label">TOOL CALLS</span><strong>{state.metrics.toolCalls}</strong></div>
        <div className="metricFooter">
          <span>across {toolPatterns.length} grouped {toolPatterns.length === 1 ? "pattern" : "patterns"}</span>
          <button type="button" onClick={() => setToolsOpen((open) => !open)} disabled={toolPatterns.length === 0} aria-expanded={toolsOpen} aria-controls="tool-calls-popover">View list</button>
        </div>
        {toolsOpen && (
          <PopoverFrame id="tool-calls-popover" ariaLabel="Tool call breakdown" eyebrow="TOOL CALL BREAKDOWN" title={`${toolPatterns.length} grouped patterns`} closeLabel="Close tool call breakdown" onClose={closeTools} summary={`${state.metrics.toolCalls} calls grouped by agent, tool, and sanitized target.`} className="metricPopover">
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
