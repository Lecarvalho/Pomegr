import type { CSSProperties } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { compactNumber, formatBucketDuration, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";

type SessionCost = NonNullable<NonNullable<MonitorState["session"]>["cost"]>;

function HistogramLegendItem({ swatch, label, value }: { swatch: string; label: string; value: number }) {
  return <div className="histogramLegendItem"><i className={swatch} /><span><small>{label}</small><strong>{compactNumber(value)}</strong></span></div>;
}

function estimatedCostLabel(cost: SessionCost) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
    maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
  }).format(cost.amount);
}

export function ContextGrowthTimeline({ timeline, currentTokens, cost, historical }: {
  timeline: MonitorState["metrics"]["tokens"]["contextGrowthTimeline"];
  currentTokens: MonitorState["metrics"]["tokens"];
  cost: SessionCost | null;
  historical: boolean;
}) {
  const buckets = timeline?.buckets || [];
  const maximum = Math.max(0, ...buckets.map((bucket) => bucket.total));
  const spansMultipleDays = buckets.length > 0
    && new Date(buckets.at(-1)?.end || 0).getTime() - new Date(buckets[0].start).getTime() >= 24 * 60 * 60_000;
  const middle = buckets[Math.floor((buckets.length - 1) / 2)];

  return (
    <section className={`panel tokenHistogramPanel ${historical ? "historical" : ""}`} aria-label="All-agent context growth timeline">
      <div className="panelHeader tokenHistogramHeader">
        <div className="tokenHistogramTitle">
          <div className="pulseBars" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          <div><span className="label">CONTEXT GROWTH</span><h2>Context added over time</h2></div>
        </div>
        <div className="histogramSummary">
          <strong>{compactNumber(currentTokens.allAgents)}</strong>
          <span>{historical ? "recorded context" : "current context"}</span>
          {cost && <small className="histogramCost" title="Claude Code's client-side session estimate at standard API list rates; it may differ from the actual bill.">Est. cost {estimatedCostLabel(cost)}</small>}
        </div>
      </div>
      {buckets.length === 0 ? <EmptyState text="Context growth will appear here after the first model response." /> : (
        <div className="histogramContent">
          <div className="histogramScale" aria-hidden="true"><span>{compactNumber(maximum)}</span><span>{compactNumber(Math.round(maximum / 2))}</span><span>0</span></div>
          <div className="histogramChart">
            <div className="histogramGrid" aria-hidden="true"><i /><i /><i /></div>
            <div className="activityBars" role="list" aria-label={`${buckets.length} chronological context-growth buckets`}>
              {buckets.map((bucket) => {
                const height = maximum > 0 ? (bucket.total / maximum) * 100 : 0;
                const segmentSize = (value: number) => bucket.total > 0 ? `${(value / bucket.total) * 100}%` : "0%";
                const label = `${timelineTime(bucket.start, spansMultipleDays)} to ${timelineTime(bucket.end, spansMultipleDays)}: ${bucket.total.toLocaleString()} net context added; ${bucket.input.toLocaleString()} attributed to uncached input, ${bucket.cacheWrite.toLocaleString()} to cache write, ${bucket.cacheRead.toLocaleString()} to cache read, ${bucket.output.toLocaleString()} to generated output`;
                return (
                  <div className={`activityBar ${bucket.total === 0 ? "emptyBar" : ""}`} key={bucket.start} role="listitem" tabIndex={0} aria-label={label} style={{ "--bar-height": `${height}%` } as CSSProperties}>
                    <i className="activityStack" aria-hidden="true">
                      <b className="activitySegment inputSegment" style={{ "--segment-size": segmentSize(bucket.input) } as CSSProperties} />
                      <b className="activitySegment cacheWriteSegment" style={{ "--segment-size": segmentSize(bucket.cacheWrite) } as CSSProperties} />
                      <b className="activitySegment cacheReadSegment" style={{ "--segment-size": segmentSize(bucket.cacheRead) } as CSSProperties} />
                      <b className="activitySegment outputSegment" style={{ "--segment-size": segmentSize(bucket.output) } as CSSProperties} />
                    </i>
                    <span className="histogramTooltip">
                      <strong>{compactNumber(bucket.total)} context added</strong>
                      <small>{timelineTime(bucket.start, spansMultipleDays)}–{timelineTime(bucket.end, spansMultipleDays)}</small>
                      <em>{compactNumber(bucket.input)} input · {compactNumber(bucket.cacheWrite)} write · {compactNumber(bucket.cacheRead)} read · {compactNumber(bucket.output)} output</em>
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="histogramAxis" aria-hidden="true">
              <span>{timelineTime(buckets[0].start, spansMultipleDays)}</span>
              <span>{middle ? timelineTime(middle.start, spansMultipleDays) : ""}</span>
              <span>{timelineTime(buckets.at(-1)?.end || buckets[0].end, spansMultipleDays)}</span>
            </div>
          </div>
        </div>
      )}
      {buckets.length > 0 && (
        <div className="histogramFooter">
          <div className="histogramLegend" aria-label="Context growth composition legend">
            <HistogramLegendItem swatch="inputSwatch" label="Uncached input" value={currentTokens.input} />
            <HistogramLegendItem swatch="cacheWriteSwatch" label="Cache write" value={currentTokens.cacheWrite} />
            <HistogramLegendItem swatch="cacheReadSwatch" label="Cache read" value={currentTokens.cacheRead} />
            <HistogramLegendItem swatch="outputSwatch" label="Generated output" value={currentTokens.output} />
          </div>
          <span className="histogramMethod">{formatBucketDuration(timeline.bucketMs)} per bar · positive change in latest snapshots</span>
        </div>
      )}
    </section>
  );
}
