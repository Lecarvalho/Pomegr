"use client";

import type { ResourceUsageUnavailableReason } from "../../../shared/monitor-contract";
import type { ResourceField, ResourceMinute, ResourceMinuteAggregate } from "../../../shared/session-domain-contract";
import { timelineTime } from "../../dashboard-utils";

/** Human labels for the four fields peaks, curves, and cards share. */
export const RESOURCE_FIELD_LABEL: Record<ResourceField, string> = {
  cpu_cores: "CPU",
  memory_bytes: "Memory",
  read_bps: "Read",
  write_bps: "Write",
};

/** Shared CSS class prefix per field; `evidence.css` defines `<prefix>Line` and `<prefix>Fill`. */
export const RESOURCE_FIELD_CLASS: Record<ResourceField, string> = {
  cpu_cores: "resourceCpu",
  memory_bytes: "resourceMemory",
  read_bps: "resourceRead",
  write_bps: "resourceWrite",
};

export const resourceUnavailableMessages: Record<ResourceUsageUnavailableReason, string> = {
  unsupported_platform: "Resource monitoring is not available on this platform.",
  missing_owner: "Exact process ownership is unavailable for this session.",
  shared_owner: "This session shares a process owner, so usage cannot be attributed safely.",
  owner_not_found: "The owning process is no longer available.",
  owner_identity_mismatch: "The process owner changed before usage could be verified.",
  collection_failed: "Resource collection is temporarily unavailable.",
};

export function finiteMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

export function formatCpuPercent(value: number | null | undefined) {
  const finite = finiteMetric(value);
  if (finite === null) return "Unavailable";
  if (finite > 0 && finite < 0.01) return "<0.01%";
  return `${finite.toLocaleString(undefined, { maximumFractionDigits: finite < 1 ? 2 : finite < 10 ? 1 : 0 })}%`;
}

export function formatBytes(value: number | null | undefined) {
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

export function formatRate(value: number | null | undefined) {
  const formatted = formatBytes(value);
  return formatted === "Unavailable" ? formatted : `${formatted}/s`;
}

/** The one formatter per `ResourceField`: cores render as a percent of one core. */
export function formatResourceFieldValue(field: ResourceField, value: number | null | undefined) {
  if (field === "cpu_cores") {
    const finite = finiteMetric(value);
    return formatCpuPercent(finite === null ? null : finite * 100);
  }
  if (field === "memory_bytes") return formatBytes(value);
  return formatRate(value);
}

/** The stored minute aggregate for one display field; the only field-to-column mapping. */
export function resourceMinuteAggregate(minute: ResourceMinute, field: ResourceField): ResourceMinuteAggregate | null {
  if (field === "cpu_cores") return minute.cpuCores;
  if (field === "memory_bytes") return minute.memoryBytes;
  if (field === "read_bps") return minute.readBytesPerSecond;
  return minute.writeBytesPerSecond;
}

export function resourceClockTime(iso: string) {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "unknown time";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(parsed);
}

export type SparklinePoint = { at: number; value: number | null };
export type SparklineBand = { at: number; min: number | null; max: number | null };

export type ResourceCardLegendEntry = { fieldClass: string; label: string };

export type ResourceCardModel = {
  key: string;
  eyebrow: string;
  unitCaption?: string;
  legend?: ResourceCardLegendEntry[];
  fieldClass: string;
  points: SparklinePoint[];
  secondaryFieldClass?: string;
  secondaryPoints?: SparklinePoint[];
  band?: SparklineBand[];
  secondaryBand?: SparklineBand[];
  formatValue: (value: number | null) => string;
  headlineValue: number | null;
  headlineLabel: string | null;
  peakValue: number | null;
  peakAt: string | null;
  axisStartLabel: string;
  axisEndLabel: string;
  /** Set when the whole window is known unavailable/loading; replaces the chart with a message. */
  unavailableMessage?: string | null;
};

const CHART_WIDTH = 400;
const CHART_HEIGHT = 80;

function scaleX(at: number, start: number, end: number) {
  const span = end - start;
  const progress = span > 0 ? (at - start) / span : 1;
  return Math.max(0, Math.min(1, progress)) * CHART_WIDTH;
}

function scaleY(value: number, maximum: number) {
  const progress = maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0;
  return CHART_HEIGHT - progress * CHART_HEIGHT;
}

function runsOf<T>(points: T[], finite: (point: T) => boolean): T[][] {
  const runs: T[][] = [];
  let current: T[] = [];
  for (const point of points) {
    if (finite(point)) current.push(point);
    else if (current.length) { runs.push(current); current = []; }
  }
  if (current.length) runs.push(current);
  return runs;
}

function seriesGeometry(points: SparklinePoint[], start: number, end: number, maximum: number) {
  return runsOf(points, (point) => point.value !== null).map((run) => {
    const coords = run.map((point) => [scaleX(point.at, start, end), scaleY(point.value as number, maximum)] as const);
    const line = coords.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
    const firstX = coords[0][0].toFixed(2);
    const lastX = coords[coords.length - 1][0].toFixed(2);
    return { line, fill: `${firstX},${CHART_HEIGHT} ${line} ${lastX},${CHART_HEIGHT}` };
  });
}

function bandGeometry(band: SparklineBand[], start: number, end: number, maximum: number) {
  return runsOf(band, (point) => point.min !== null && point.max !== null).map((run) => {
    const top = run.map((point) => `${scaleX(point.at, start, end).toFixed(2)},${scaleY(point.max as number, maximum).toFixed(2)}`);
    const bottom = run.slice().reverse().map((point) => `${scaleX(point.at, start, end).toFixed(2)},${scaleY(point.min as number, maximum).toFixed(2)}`);
    return [...top, ...bottom].join(" ");
  });
}

function windowMaximum(model: ResourceCardModel) {
  const values: number[] = [];
  for (const point of model.points) if (point.value !== null) values.push(point.value);
  for (const point of model.secondaryPoints || []) if (point.value !== null) values.push(point.value);
  for (const point of model.band || []) { if (point.max !== null) values.push(point.max); }
  for (const point of model.secondaryBand || []) { if (point.max !== null) values.push(point.max); }
  const maximum = values.length ? Math.max(0, ...values) : 0;
  return maximum > 0 ? maximum * 1.08 : 1;
}

/** One sparkline card: CPU, Memory, or Disk I/O. Gaps render as gaps, never as zero. */
export function ResourceSparklineCard({ model }: { model: ResourceCardModel }) {
  const hasPrimary = model.points.some((point) => point.value !== null);
  const hasSecondary = (model.secondaryPoints || []).some((point) => point.value !== null);
  const hasSeries = hasPrimary || hasSecondary;
  const start = model.points[0]?.at ?? model.secondaryPoints?.[0]?.at ?? 0;
  const end = model.points.at(-1)?.at ?? model.secondaryPoints?.at(-1)?.at ?? start;
  const maximum = windowMaximum(model);
  const primaryLines = model.band ? bandGeometry(model.band, start, end, maximum).map((fill) => ({ fill, line: null as string | null }))
    : seriesGeometry(model.points, start, end, maximum);
  const primaryMaxLine = model.band ? seriesGeometry(model.points, start, end, maximum) : null;
  const secondaryLines = model.secondaryBand ? bandGeometry(model.secondaryBand, start, end, maximum).map((fill) => ({ fill, line: null as string | null }))
    : model.secondaryPoints ? seriesGeometry(model.secondaryPoints, start, end, maximum) : [];
  const secondaryMaxLine = model.secondaryBand && model.secondaryPoints ? seriesGeometry(model.secondaryPoints, start, end, maximum) : null;

  return <article className="sessionOverviewPanel resourceCard">
    <div className="resourceCardHeader">
      <span className="sessionEyebrow">{model.eyebrow}</span>
      {model.legend ? <span className="resourceCardLegend">{model.legend.map((entry) => (
        <span className={`resourceCardLegendEntry ${entry.fieldClass}Legend`} key={entry.label}><i />{entry.label}</span>
      ))}</span> : <span className="resourceCardUnit">{model.unitCaption}</span>}
    </div>
    <div className="resourceCardHeadline">
      {model.headlineLabel && <span className="resourceCardHeadlineLabel">{model.headlineLabel}</span>}
      <span className="resourceCardValue">{model.formatValue(model.headlineValue)}</span>
      <span className="resourceCardPeak">{model.peakValue === null
        ? "No peak recorded for this window"
        : `peak ${model.formatValue(model.peakValue)}${model.peakAt ? ` at ${timelineTime(model.peakAt)}` : ""}`}</span>
    </div>
    {model.unavailableMessage || !hasSeries ? (
      <p className="resourceCardUnavailable" role="status">{model.unavailableMessage || "No samples were recorded for this window."}</p>
    ) : (
      <div className="resourceCardChart">
        <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
          <line className="resourceCardBaseline" x1="0" y1={CHART_HEIGHT - 0.5} x2={CHART_WIDTH} y2={CHART_HEIGHT - 0.5} />
          {secondaryLines.map((segment, index) => segment.fill && <polygon className={`${model.secondaryFieldClass}Fill`} points={segment.fill} key={`secondary-fill-${index}`} />)}
          {(secondaryMaxLine || secondaryLines).map((segment, index) => segment.line && <polyline className={`${model.secondaryFieldClass}Line`} points={segment.line} fill="none" key={`secondary-line-${index}`} />)}
          {primaryLines.map((segment, index) => segment.fill && <polygon className={`${model.fieldClass}Fill`} points={segment.fill} key={`primary-fill-${index}`} />)}
          {(primaryMaxLine || primaryLines).map((segment, index) => segment.line && <polyline className={`${model.fieldClass}Line`} points={segment.line} fill="none" key={`primary-line-${index}`} />)}
        </svg>
        <div className="resourceCardTicks"><span>{model.axisStartLabel}</span><span>{model.axisEndLabel}</span></div>
      </div>
    )}
  </article>;
}
