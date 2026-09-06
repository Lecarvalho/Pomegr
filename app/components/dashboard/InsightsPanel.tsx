import type { Insight } from "../../../shared/monitor-contract";
import { EmptyState } from "../EmptyState";
import { PanelHeader } from "../PanelHeader";
import { useState } from "react";

function InsightGlyph({ warning }: { warning: boolean }) {
  return (
    <span className="insightGlyph" aria-hidden="true">
      {warning
        ? <svg className="insightWarningIcon" viewBox="0 0 24 24"><path d="M12 3 22 20H2L12 3Z" /><path d="M12 9v5M12 17.5v.01" /></svg>
        : <svg className="insightCheckIcon" viewBox="0 0 24 24"><path d="m6 12 4 4 8-9" /></svg>}
    </span>
  );
}

function insightAgentId(insight: Insight) {
  return "agentId" in insight && typeof insight.agentId === "string" ? insight.agentId : null;
}

export function InsightsPanel({ insights, variant = "panel", onShowAgent }: {
  insights: Insight[];
  variant?: "panel" | "compact";
  onShowAgent?: (agentId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const warningCount = insights.filter((insight) => insight.level === "warning").length;
  const visibleInsights = variant === "compact" && !expanded ? insights.slice(0, 2) : insights;

  if (variant === "compact") {
    const countLabel = insights.length === 0
      ? "No signals"
      : warningCount > 0
        ? `${warningCount} attention`
        : `${insights.length} signals`;
    return <article className="sessionSummaryCard sessionSignalsCard panel">
      <div className="sessionSummaryCardHeader">
        <span className="sessionEyebrow">Efficiency signals</span>
        <span className={`sessionSignalCount${warningCount > 0 ? " sessionSignalCount-warning" : ""}`}>{countLabel}</span>
      </div>
      <div className="insightList">
        {insights.length === 0 && <EmptyState text="No rule-based efficiency signals for this session." />}
        {visibleInsights.map((insight) => <InsightRow insight={insight} key={insight.id} onShowAgent={onShowAgent} />)}
      </div>
      {insights.length > 2 && <a className="insightExpandLink" href="#efficiency-signals" onClick={(event) => { event.preventDefault(); setExpanded((value) => !value); }}>{expanded ? "Show fewer" : `Show all ${insights.length}`}</a>}
    </article>;
  }

  return (
    <article className="panel insightPanel">
      <PanelHeader title="Efficiency signals" trailing={<span className="quiet">{insights.length}</span>} />
      <div className="insightList">
        {insights.length === 0 && <EmptyState text="No rule-based efficiency signals for this session." />}
        {insights.map((insight) => <InsightRow insight={insight} key={insight.id} onShowAgent={onShowAgent} />)}
      </div>
    </article>
  );
}

function InsightRow({ insight, onShowAgent }: { insight: Insight; onShowAgent?: (agentId: string) => void }) {
  const agentId = insightAgentId(insight);
  const showAgent = insight.level === "warning" && agentId;
  return <div className={`insight ${insight.level}`}>
    <InsightGlyph warning={insight.level === "warning"} />
    <div>
      <strong>{insight.title}</strong>
      <p>{insight.detail}</p>
      {showAgent && <a className="insightAgentLink" href="#agent-activity" onClick={() => onShowAgent?.(agentId!)}>Show agent</a>}
    </div>
  </div>;
}
