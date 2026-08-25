import type { Insight } from "../../../shared/monitor-contract";
import { EmptyState } from "../EmptyState";
import { PanelHeader } from "../PanelHeader";

function InsightGlyph({ warning }: { warning: boolean }) {
  return (
    <span className="insightGlyph" aria-hidden="true">
      {warning
        ? <svg className="insightWarningIcon" viewBox="0 0 24 24"><path d="M12 3 22 20H2L12 3Z" /><path d="M12 9v5M12 17.5v.01" /></svg>
        : <svg className="insightCheckIcon" viewBox="0 0 24 24"><path d="m6 12 4 4 8-9" /></svg>}
    </span>
  );
}

export function InsightsPanel({ insights }: { insights: Insight[] }) {
  return (
    <article className="panel insightPanel">
      <PanelHeader title="Efficiency signals" trailing={<span className="quiet">{insights.length}</span>} />
      <div className="insightList">
        {insights.length === 0 && <EmptyState text="No rule-based efficiency signals for this session." />}
        {insights.map((insight) => <div className={`insight ${insight.level}`} key={insight.id}><InsightGlyph warning={insight.level === "warning"} /><div><strong>{insight.title}</strong><p>{insight.detail}</p></div></div>)}
      </div>
    </article>
  );
}
