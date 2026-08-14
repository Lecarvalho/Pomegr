import { useState, type CSSProperties } from "react";
import type { MonitorState } from "../../../shared/monitor-contract";
import { compactNumber, formatBucketDuration, timelineTime } from "../../dashboard-utils";
import { EmptyState } from "../EmptyState";
import { TooltipPopover } from "../TooltipPopover";

type SessionCost = NonNullable<NonNullable<MonitorState["session"]>["cost"]>;
type Point = { x: number; y: number };
type CubicSegment = { start: Point; firstControl: Point; secondControl: Point; end: Point };
type ContextSeries = "input" | "cacheWrite" | "cacheRead" | "output";

const CONTEXT_SERIES: ContextSeries[] = ["input", "cacheWrite", "cacheRead", "output"];
const CONTEXT_SERIES_LABELS: Record<ContextSeries, { accessible: string; short: string }> = {
  input: { accessible: "uncached input", short: "input" },
  cacheWrite: { accessible: "cache write", short: "write" },
  cacheRead: { accessible: "cache read", short: "read" },
  output: { accessible: "generated output", short: "output" },
};

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 140;

function finiteNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function seriesPoints(values: number[]): Point[] {
  if (values.length === 0) return [];
  const bucketPoints = values.map((value, index) => ({ x: (index + .5) * CHART_WIDTH / values.length, y: finiteNonNegative(value) }));
  return [{ x: 0, y: bucketPoints[0].y }, ...bucketPoints, { x: CHART_WIDTH, y: bucketPoints.at(-1)?.y ?? CHART_HEIGHT }];
}

/** A monotone cubic Hermite spline. Harmonic-mean tangents keep every segment inside its data bounds. */
function monotoneSegments(points: Point[]): CubicSegment[] {
  if (points.length < 2) return [];
  const slopes = points.slice(0, -1).map((point, index) => {
    const width = points[index + 1].x - point.x;
    return width > 0 ? (points[index + 1].y - point.y) / width : 0;
  });
  const tangents = points.map((_, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes.at(-1) || 0;
    const before = slopes[index - 1];
    const after = slopes[index];
    return before === 0 || after === 0 || Math.sign(before) !== Math.sign(after)
      ? 0
      : 2 / (1 / before + 1 / after);
  });

  return points.slice(0, -1).map((point, index) => {
    const next = points[index + 1];
    const width = next.x - point.x;
    return {
      start: point,
      firstControl: { x: point.x + width / 3, y: point.y + tangents[index] * width / 3 },
      secondControl: { x: next.x - width / 3, y: next.y - tangents[index + 1] * width / 3 },
      end: next,
    };
  });
}

export function monotonePath(points: Point[]) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  return monotoneSegments(points).reduce((path, segment) => (
    `${path} C ${segment.firstControl.x} ${segment.firstControl.y}, ${segment.secondControl.x} ${segment.secondControl.y}, ${segment.end.x} ${segment.end.y}`
  ), `M ${points[0].x} ${points[0].y}`);
}

function chartY(value: number, maximum: number) {
  return CHART_HEIGHT - (maximum > 0 ? finiteNonNegative(value) / maximum * CHART_HEIGHT : 0);
}

// Each component is interpolated as a bounded non-negative curve. Summing matching
// Bezier controls produces smooth cumulative boundaries whose layers cannot cross.
function stackedPath(componentSeries: Point[][], maximum: number) {
  const firstSeries = componentSeries[0];
  if (!firstSeries?.length) return "";
  const geometries = componentSeries.map(monotoneSegments);
  const initial = componentSeries.reduce((total, series) => total + series[0].y, 0);
  if (firstSeries.length === 1) return `M ${firstSeries[0].x} ${chartY(initial, maximum)}`;
  return geometries[0].reduce((path, segment, index) => {
    const firstControl = geometries.reduce((total, geometry) => total + geometry[index].firstControl.y, 0);
    const secondControl = geometries.reduce((total, geometry) => total + geometry[index].secondControl.y, 0);
    const end = geometries.reduce((total, geometry) => total + geometry[index].end.y, 0);
    return `${path} C ${segment.firstControl.x} ${chartY(firstControl, maximum)}, ${segment.secondControl.x} ${chartY(secondControl, maximum)}, ${segment.end.x} ${chartY(end, maximum)}`;
  }, `M ${firstSeries[0].x} ${chartY(initial, maximum)}`);
}

function stackedAreaPath(componentSeries: Point[][], maximum: number) {
  const firstSeries = componentSeries[0];
  if (!firstSeries?.length) return "";
  return `${stackedPath(componentSeries, maximum)} L ${firstSeries.at(-1)?.x || 0} ${CHART_HEIGHT} L ${firstSeries[0].x} ${CHART_HEIGHT} Z`;
}

function HistogramLegendItem({ swatch, label, value, enabled, onToggle }: {
  swatch: string;
  label: string;
  value: number;
  enabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button className="histogramLegendItem" type="button" role="switch" aria-checked={enabled} onClick={onToggle}>
      <i className={swatch} aria-hidden="true" />
      <span><small>{label}</small><strong>{compactNumber(value)}</strong></span>
    </button>
  );
}

function estimatedCostLabel(cost: SessionCost) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
    maximumFractionDigits: cost.amount > 0 && cost.amount < 0.01 ? 4 : 2,
  }).format(cost.amount);
}

export function ContextGrowthTimeline({ timeline, currentTokens, cost, estimatedCostSupported, historical }: {
  timeline: MonitorState["metrics"]["tokens"]["contextGrowthTimeline"];
  currentTokens: MonitorState["metrics"]["tokens"];
  cost: SessionCost | null;
  estimatedCostSupported: boolean;
  historical: boolean;
}) {
  const [visibleSeries, setVisibleSeries] = useState<Record<ContextSeries, boolean>>({
    input: true,
    cacheWrite: true,
    cacheRead: true,
    output: true,
  });
  const toggleSeries = (series: ContextSeries) => {
    setVisibleSeries((current) => ({ ...current, [series]: !current[series] }));
  };
  const areaClass = (series: ContextSeries, className: string) => (
    `contextArea ${className}${visibleSeries[series] ? "" : " isHidden"}`
  );
  const lineClass = (series: ContextSeries, className: string) => (
    `contextSeriesLine ${className}${visibleSeries[series] ? "" : " isHidden"}`
  );
  const pointClass = (series: ContextSeries, className: string) => (
    `contextChartPoint ${className}${visibleSeries[series] ? "" : " isHidden"}`
  );
  const buckets = timeline?.buckets || [];
  const components = buckets.map((bucket) => {
    const input = finiteNonNegative(bucket.input);
    const cacheWrite = finiteNonNegative(bucket.cacheWrite);
    const cacheRead = finiteNonNegative(bucket.cacheRead);
    const output = finiteNonNegative(bucket.output);
    return { input, cacheWrite, cacheRead, output, stackTotal: input + cacheWrite + cacheRead + output, total: finiteNonNegative(bucket.total) };
  });
  const selectedSeries = CONTEXT_SERIES.filter((series) => visibleSeries[series]);
  const maximum = Math.max(0, ...components.flatMap((bucket) => selectedSeries.map((series) => bucket[series])));
  const componentSeries = [
    seriesPoints(components.map((bucket) => bucket.input)),
    seriesPoints(components.map((bucket) => bucket.cacheWrite)),
    seriesPoints(components.map((bucket) => bucket.cacheRead)),
    seriesPoints(components.map((bucket) => bucket.output)),
  ];
  const areaPaths = {
    input: stackedAreaPath(componentSeries.slice(0, 1), maximum),
    cacheWrite: stackedAreaPath(componentSeries.slice(1, 2), maximum),
    cacheRead: stackedAreaPath(componentSeries.slice(2, 3), maximum),
    output: stackedAreaPath(componentSeries.slice(3, 4), maximum),
  };
  const linePaths = {
    input: stackedPath(componentSeries.slice(0, 1), maximum),
    cacheWrite: stackedPath(componentSeries.slice(1, 2), maximum),
    cacheRead: stackedPath(componentSeries.slice(2, 3), maximum),
    output: stackedPath(componentSeries.slice(3, 4), maximum),
  };
  const spansMultipleDays = buckets.length > 0
    && new Date(buckets.at(-1)?.end || 0).getTime() - new Date(buckets[0].start).getTime() >= 24 * 60 * 60_000;
  const middle = buckets[Math.floor((buckets.length - 1) / 2)];

  return (
    <section className={`panel tokenHistogramPanel ${historical ? "historical" : ""}`} aria-label="All-agent context growth timeline">
      <div className="panelHeader tokenHistogramHeader">
        <div className="tokenHistogramTitle">
          <h2>Context added over time</h2>
        </div>
        <div className="histogramSummary">
          <strong>{compactNumber(currentTokens.allAgents)}</strong>
          <span>{historical ? "recorded context" : "context"}</span>
          {estimatedCostSupported && cost && <small className="histogramCost" title="Claude Code's client-side session estimate at standard API list rates; it may differ from the actual bill.">Claude Code estimate {estimatedCostLabel(cost)}</small>}
        </div>
      </div>
      {buckets.length === 0 ? <EmptyState text="Context growth will appear here after the first model response." /> : (
        <div className="histogramContent">
          <div className="histogramScale" aria-hidden="true"><span>{compactNumber(maximum)}</span><span>{compactNumber(Math.round(maximum / 2))}</span><span>0</span></div>
          <div className="histogramChart">
            <div className="histogramGrid" aria-hidden="true"><i /><i /><i /></div>
            <svg className="contextAreaChart" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
              <path className={areaClass("output", "outputArea")} data-series="output" d={areaPaths.output} />
              <path className={areaClass("cacheRead", "cacheReadArea")} data-series="cacheRead" d={areaPaths.cacheRead} />
              <path className={areaClass("cacheWrite", "cacheWriteArea")} data-series="cacheWrite" d={areaPaths.cacheWrite} />
              <path className={areaClass("input", "inputArea")} data-series="input" d={areaPaths.input} />
              <path className={lineClass("output", "outputLine")} data-series-line="output" d={linePaths.output} />
              <path className={lineClass("cacheRead", "cacheReadLine")} data-series-line="cacheRead" d={linePaths.cacheRead} />
              <path className={lineClass("cacheWrite", "cacheWriteLine")} data-series-line="cacheWrite" d={linePaths.cacheWrite} />
              <path className={lineClass("input", "inputLine")} data-series-line="input" d={linePaths.input} />
            </svg>
            <div className="activityBars" role="list" aria-label={`${buckets.length} chronological context-growth buckets`}>
              {buckets.map((bucket, index) => {
                const pointValues: Record<ContextSeries, number> = {
                  input: components[index].input,
                  cacheWrite: components[index].cacheWrite,
                  cacheRead: components[index].cacheRead,
                  output: components[index].output,
                };
                const selectedTotal = selectedSeries.reduce((total, series) => total + pointValues[series], 0);
                const selectedBreakdown = selectedSeries.map((series) => (
                  `${pointValues[series].toLocaleString()} attributed to ${CONTEXT_SERIES_LABELS[series].accessible}`
                ));
                const selectedSummary = selectedSeries.length === 1
                  ? `${compactNumber(selectedTotal)} ${CONTEXT_SERIES_LABELS[selectedSeries[0]].accessible}`
                  : selectedSeries.length === CONTEXT_SERIES.length
                    ? `${compactNumber(selectedTotal)} context added`
                    : selectedSeries.length > 0
                      ? `${compactNumber(selectedTotal)} selected context added`
                      : "No metrics selected";
                const label = `${timelineTime(bucket.start, spansMultipleDays)} to ${timelineTime(bucket.end, spansMultipleDays)}: ${selectedSeries.length > 0 ? selectedBreakdown.join(", ") : "no context metrics selected"}`;
                return (
                  <div className={`activityBar ${bucket.total === 0 ? "emptyBar" : ""}`} key={bucket.start} role="listitem" tabIndex={0} aria-label={label}>
                    {([
                      ["output", "outputChartPoint"],
                      ["cacheRead", "cacheReadChartPoint"],
                      ["cacheWrite", "cacheWriteChartPoint"],
                      ["input", "inputChartPoint"],
                    ] as const).map(([series, className]) => (
                      <svg className={pointClass(series, className)} data-series-point={series} key={series} style={{ "--point-y": `${maximum > 0 ? 100 - pointValues[series] / maximum * 100 : 100}%` } as CSSProperties} viewBox="0 0 8.7 8.7" preserveAspectRatio="none" aria-hidden="true">
                        <circle cx="4.35" cy="4.35" r="3.5" />
                      </svg>
                    ))}
                    <TooltipPopover className="histogramTooltip">
                      <strong>{selectedSummary}</strong>
                      <small>{timelineTime(bucket.start, spansMultipleDays)}–{timelineTime(bucket.end, spansMultipleDays)}</small>
                      {selectedSeries.length > 0 && <em>{selectedSeries.map((series) => `${compactNumber(pointValues[series])} ${CONTEXT_SERIES_LABELS[series].short}`).join(" · ")}</em>}
                    </TooltipPopover>
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
            <HistogramLegendItem swatch="inputSwatch" label="Uncached input" value={currentTokens.input} enabled={visibleSeries.input} onToggle={() => toggleSeries("input")} />
            <HistogramLegendItem swatch="cacheWriteSwatch" label="Cache write" value={currentTokens.cacheWrite} enabled={visibleSeries.cacheWrite} onToggle={() => toggleSeries("cacheWrite")} />
            <HistogramLegendItem swatch="cacheReadSwatch" label="Cache read" value={currentTokens.cacheRead} enabled={visibleSeries.cacheRead} onToggle={() => toggleSeries("cacheRead")} />
            <HistogramLegendItem swatch="outputSwatch" label="Generated output" value={currentTokens.output} enabled={visibleSeries.output} onToggle={() => toggleSeries("output")} />
          </div>
          <span className="histogramMethod">{formatBucketDuration(timeline.bucketMs)} per bar · positive change in latest snapshots</span>
        </div>
      )}
    </section>
  );
}
