"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { MonitorState, ResourceUsageSample, ResourceUsageUnavailableReason } from "../../../shared/monitor-contract";
import { DashboardDisclosurePanel } from "./DashboardDisclosurePanel";

type ResourceUsage = MonitorState["metrics"]["resources"];
type TimedSample = ResourceUsageSample & { time: number };
type MetricReader = (sample: TimedSample) => number | null;

const STORAGE_KEY = "pomegr-resource-panel-open";
const WINDOW_MS = 15 * 60_000;
const CHART_WIDTH = 1000;
const CHART_HEIGHT = 96;
const CHART_INSET = 4;

const unavailableMessages: Record<ResourceUsageUnavailableReason, string> = {
  unsupported_platform: "Resource monitoring is not available on this platform.",
  missing_owner: "Exact process ownership is unavailable for this session.",
  shared_owner: "This session shares a process owner, so usage cannot be attributed safely.",
  owner_not_found: "The owning process is no longer available.",
  owner_identity_mismatch: "The process owner changed before usage could be verified.",
  collection_failed: "Resource collection is temporarily unavailable.",
};

function finiteMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function formatCores(value: number | null | undefined) {
  const finite = finiteMetric(value);
  if (finite === null) return "Unavailable";
  return `${finite.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} cores`;
}

function formatPercent(value: number | null | undefined) {
  const finite = finiteMetric(value);
  if (finite === null) return "Machine share unavailable";
  return `${finite.toLocaleString(undefined, { maximumFractionDigits: finite < 10 ? 1 : 0 })}% of machine`;
}

function formatBytes(value: number | null | undefined) {
  const finite = finiteMetric(value);
  if (finite === null) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let scaled = finite;
  let unitIndex = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled.toLocaleString(undefined, {
    minimumFractionDigits: unitIndex > 0 && scaled < 10 ? 1 : 0,
    maximumFractionDigits: scaled < 10 ? 1 : 0,
  })} ${units[unitIndex]}`;
}

function formatRate(value: number | null | undefined) {
  const formatted = formatBytes(value);
  return formatted === "Unavailable" ? formatted : `${formatted}/s`;
}

function totalIo(read: number | null | undefined, write: number | null | undefined) {
  const finiteRead = finiteMetric(read);
  const finiteWrite = finiteMetric(write);
  if (finiteRead === null && finiteWrite === null) return null;
  return (finiteRead || 0) + (finiteWrite || 0);
}

function sampleTimeLabel(timestamp: string) {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(parsed);
}

function axisTimeLabel(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
}

function visibleSamples(samples: ResourceUsageSample[]) {
  const timed = samples.flatMap<TimedSample>((sample) => {
    const time = Date.parse(sample.timestamp);
    return Number.isFinite(time) ? [{ ...sample, time }] : [];
  }).sort((left, right) => left.time - right.time);
  const end = timed.at(-1)?.time;
  return end === undefined ? [] : timed.filter((sample) => sample.time >= end - WINDOW_MS);
}

function metricMaximum(samples: TimedSample[], readers: MetricReader[]) {
  const values = samples.flatMap((sample) => readers.map((reader) => finiteMetric(reader(sample))).filter((value): value is number => value !== null));
  const maximum = Math.max(0, ...values);
  return maximum > 0 ? maximum * 1.08 : 1;
}

function chartX(time: number, windowStart: number, windowEnd: number) {
  const progress = windowEnd > windowStart ? (time - windowStart) / (windowEnd - windowStart) : 1;
  return CHART_INSET + Math.max(0, Math.min(1, progress)) * (CHART_WIDTH - CHART_INSET * 2);
}

function chartY(value: number, maximum: number) {
  const progress = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
  return CHART_HEIGHT - CHART_INSET - progress * (CHART_HEIGHT - CHART_INSET * 2);
}

function straightPath(samples: TimedSample[], reader: MetricReader, maximum: number, windowStart: number, windowEnd: number) {
  let drawing = false;
  return samples.reduce((path, sample) => {
    const value = finiteMetric(reader(sample));
    if (value === null) {
      drawing = false;
      return path;
    }
    const point = `${chartX(sample.time, windowStart, windowEnd).toFixed(2)} ${chartY(value, maximum).toFixed(2)}`;
    const next = `${path}${drawing ? " L" : path ? " M" : "M"} ${point}`;
    drawing = true;
    return next;
  }, "");
}

function ResourceStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="resourceStat">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function ChartLane({ label, maximumLabel, legend, paths, activeX, activeValues }: {
  label: string;
  maximumLabel: string;
  legend?: ReactNode;
  paths: Array<{ className: string; path: string }>;
  activeX: number | null;
  activeValues: Array<{ className: string; value: number | null; maximum: number }>;
}) {
  return (
    <div className="resourceChartLane">
      <div className="resourceChartLaneLabel" aria-hidden="true"><strong>{label}</strong>{legend}</div>
      <div className="resourceChartScale" aria-hidden="true"><span>{maximumLabel}</span><span>0</span></div>
      <svg className="resourceChartSvg" viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <g className="resourceChartGrid">
          <line x1="0" y1={CHART_INSET} x2={CHART_WIDTH} y2={CHART_INSET} />
          <line x1="0" y1={CHART_HEIGHT / 2} x2={CHART_WIDTH} y2={CHART_HEIGHT / 2} />
          <line x1="0" y1={CHART_HEIGHT - CHART_INSET} x2={CHART_WIDTH} y2={CHART_HEIGHT - CHART_INSET} />
        </g>
        {paths.map((series) => <path className={`resourceChartLine ${series.className}`} d={series.path} key={series.className} fill="none" />)}
        {activeX !== null && <line className="resourceChartCursor" x1={activeX} y1="0" x2={activeX} y2={CHART_HEIGHT} />}
        {activeX !== null && activeValues.map((point) => point.value === null ? null : (
          <circle className={`resourceChartCursorPoint ${point.className}`} cx={activeX} cy={chartY(point.value, point.maximum)} r="4" key={point.className} />
        ))}
      </svg>
    </div>
  );
}

function currentSummary(resources: ResourceUsage | undefined) {
  if (resources?.status === "unavailable") return <span className="disclosureSummaryUnavailable">Unavailable</span>;
  const current = resources?.current;
  return (
    <span className="disclosureSummaryMetrics">
      <span><b>CPU</b> {formatCores(current?.cpuCores)}</span>
      <span><b>Memory</b> {formatBytes(current?.memoryBytes)}</span>
      <span><b>I/O</b> {formatRate(totalIo(current?.readBytesPerSecond, current?.writeBytesPerSecond))}</span>
    </span>
  );
}

function inaccessibleSampleSummary(sample: TimedSample | undefined) {
  if (!sample) return "No resource sample selected.";
  return [
    `${sampleTimeLabel(sample.timestamp)}.`,
    `CPU ${formatCores(sample.cpuCores)}, ${formatPercent(sample.cpuMachinePercent)}.`,
    `Memory ${formatBytes(sample.memoryBytes)}.`,
    `Disk read ${formatRate(sample.readBytesPerSecond)} and write ${formatRate(sample.writeBytesPerSecond)}.`,
  ].join(" ");
}

export function ResourceUsagePanel({ resources }: { resources: ResourceUsage | undefined }) {
  const [activeTimestamp, setActiveTimestamp] = useState<string | null>(null);
  const announcementId = useId();

  const samples = visibleSamples(resources?.samples || []);
  const windowEnd = samples.at(-1)?.time ?? 0;
  const windowStart = windowEnd - WINDOW_MS;
  const selectedIndex = activeTimestamp ? samples.findIndex((sample) => sample.timestamp === activeTimestamp) : samples.length - 1;
  const activeIndex = selectedIndex >= 0 ? selectedIndex : samples.length - 1;
  const activeSample = samples[activeIndex];
  const activeX = activeSample ? chartX(activeSample.time, windowStart, windowEnd) : null;

  const cpuMaximum = metricMaximum(samples, [(sample) => sample.cpuCores]);
  const memoryMaximum = metricMaximum(samples, [(sample) => sample.memoryBytes]);
  const ioMaximum = metricMaximum(samples, [(sample) => sample.readBytesPerSecond, (sample) => sample.writeBytesPerSecond]);
  const cpuPath = straightPath(samples, (sample) => sample.cpuCores, cpuMaximum, windowStart, windowEnd);
  const memoryPath = straightPath(samples, (sample) => sample.memoryBytes, memoryMaximum, windowStart, windowEnd);
  const readPath = straightPath(samples, (sample) => sample.readBytesPerSecond, ioMaximum, windowStart, windowEnd);
  const writePath = straightPath(samples, (sample) => sample.writeBytesPerSecond, ioMaximum, windowStart, windowEnd);
  const ready = resources?.status === "ready" && samples.length > 0;
  const current = resources?.current;

  const handleChartKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (samples.length === 0) return;
    let nextIndex = activeIndex;
    if (event.key === "ArrowLeft") nextIndex = Math.max(0, activeIndex - 1);
    else if (event.key === "ArrowRight") nextIndex = Math.min(samples.length - 1, activeIndex + 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = samples.length - 1;
    else return;
    event.preventDefault();
    setActiveTimestamp(nextIndex === samples.length - 1 ? null : samples[nextIndex].timestamp);
  };

  const handleChartPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target.closest("svg.resourceChartSvg") : null;
    if (!(target instanceof SVGSVGElement) || samples.length === 0) return;
    const bounds = target.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const targetTime = windowStart + progress * WINDOW_MS;
    const nearest = samples.reduce((best, sample) => (
      Math.abs(sample.time - targetTime) < Math.abs(best.time - targetTime) ? sample : best
    ));
    setActiveTimestamp(nearest.timestamp === samples.at(-1)?.timestamp ? null : nearest.timestamp);
  };

  const handleChartPointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (document.activeElement !== event.currentTarget) setActiveTimestamp(null);
  };

  return (
    <DashboardDisclosurePanel
      bodyClassName="resourceUsageBody"
      className="resourceUsagePanel"
      defaultOpen
      storageKey={STORAGE_KEY}
      summary={currentSummary(resources)}
      title="Resource use"
    >
      {resources?.status === "unavailable" ? (
          <div className="resourceUsageState" role="status">
            <strong>Resource use unavailable</strong>
            <p>{resources.reason ? unavailableMessages[resources.reason] : "Resource collection is unavailable for this session."}</p>
          </div>
        ) : !ready ? (
          <div className="resourceUsageState collecting" role="status">
            <strong>{"Collecting resource samples\u2026"}</strong>
            <p>CPU, memory, and disk activity will appear after enough live measurements are available.</p>
          </div>
        ) : (
          <>
            <div className="resourceStatStrip">
              <ResourceStat label="CPU" value={formatCores(current?.cpuCores)} detail={formatPercent(current?.cpuMachinePercent)} />
              <ResourceStat label="Memory" value={formatBytes(current?.memoryBytes)} detail={`Observed peak ${formatBytes(resources.observedPeak?.memoryBytes)}`} />
              <ResourceStat label="Disk I/O" value={formatRate(totalIo(current?.readBytesPerSecond, current?.writeBytesPerSecond))} detail={`${formatRate(current?.readBytesPerSecond)} read \u00b7 ${formatRate(current?.writeBytesPerSecond)} write`} />
            </div>
            <div
              className="resourceCharts"
              role="group"
              tabIndex={0}
              aria-label="Resource use over the last 15 minutes. Use Left and Right arrow keys to inspect samples."
              aria-describedby={announcementId}
              onKeyDown={handleChartKeyDown}
              onPointerMove={handleChartPointerMove}
              onPointerLeave={handleChartPointerLeave}
            >
              {activeSample && <div className="resourceChartReadout" aria-hidden="true">
                <time dateTime={activeSample.timestamp}>{sampleTimeLabel(activeSample.timestamp)}</time>
                <span><b>CPU</b> {formatCores(activeSample.cpuCores)}</span>
                <span><b>Memory</b> {formatBytes(activeSample.memoryBytes)}</span>
                <span><b>Read</b> {formatRate(activeSample.readBytesPerSecond)}</span>
                <span><b>Write</b> {formatRate(activeSample.writeBytesPerSecond)}</span>
              </div>}
              <ChartLane
                label="CPU"
                maximumLabel={formatCores(cpuMaximum)}
                paths={[{ className: "resourceCpuLine", path: cpuPath }]}
                activeX={activeX}
                activeValues={[{ className: "resourceCpuPoint", value: finiteMetric(activeSample?.cpuCores), maximum: cpuMaximum }]}
              />
              <ChartLane
                label="Memory"
                maximumLabel={formatBytes(memoryMaximum)}
                paths={[{ className: "resourceMemoryLine", path: memoryPath }]}
                activeX={activeX}
                activeValues={[{ className: "resourceMemoryPoint", value: finiteMetric(activeSample?.memoryBytes), maximum: memoryMaximum }]}
              />
              <ChartLane
                label="Disk I/O"
                maximumLabel={formatRate(ioMaximum)}
                legend={(
                  <span className="resourceSeriesLegend">
                    <span><i className="resourceReadSwatch" />Read</span>
                    <span><i className="resourceWriteSwatch" />Write</span>
                  </span>
                )}
                paths={[
                  { className: "resourceReadLine", path: readPath },
                  { className: "resourceWriteLine", path: writePath },
                ]}
                activeX={activeX}
                activeValues={[
                  { className: "resourceReadPoint", value: finiteMetric(activeSample?.readBytesPerSecond), maximum: ioMaximum },
                  { className: "resourceWritePoint", value: finiteMetric(activeSample?.writeBytesPerSecond), maximum: ioMaximum },
                ]}
              />
              <div className="resourceChartAxis" aria-hidden="true">
                <span>{axisTimeLabel(windowStart)}</span>
                <span>{axisTimeLabel(windowStart + WINDOW_MS / 2)}</span>
                <span>{axisTimeLabel(windowEnd)}</span>
              </div>
              <p
                className="resourceChartAnnouncement"
                id={announcementId}
                aria-live="polite"
                aria-atomic="true"
                style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}
              >
                {inaccessibleSampleSummary(activeSample)}
              </p>
            </div>
          </>
      )}
    </DashboardDisclosurePanel>
  );
}
