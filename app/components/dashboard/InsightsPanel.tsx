import type { Insight } from "../../../shared/monitor-contract";
import { EmptyState } from "../EmptyState";
import { PanelHeader } from "../PanelHeader";

export function InsightsPanel({ insights }: { insights: Insight[] }) {
  return (
    <article className="panel insightPanel">
      <PanelHeader title="Efficiency signals" trailing={<span className="quiet">{insights.length}</span>} />
      <div className="insightList">
        {insights.length === 0 && <EmptyState text="No rule-based efficiency signals for this session." />}
        {insights.map((insight) => <div className={`insight ${insight.level}`} key={insight.id}><span className="insightGlyph">{insight.level === "warning" ? "↻" : "✓"}</span><div><strong>{insight.title}</strong><p>{insight.detail}</p></div></div>)}
      </div>
    </article>
  );
}
