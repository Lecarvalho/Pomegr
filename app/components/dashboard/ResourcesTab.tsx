"use client";

import { useState, type ReactNode } from "react";
import type { ResourceUsageSample } from "../../../shared/monitor-contract";
import type { ResourceField, ResourceMinute, ResourcePeak, ResourceRetentionReason, ResourcesDomain } from "../../../shared/session-domain-contract";
import { timelineTime } from "../../dashboard-utils";
import { useSessionDomain } from "../../session-domain-store";
import {
  RESOURCE_FIELD_CLASS,
  type ResourceCardModel,
  ResourceSparklineCard,
  type SparklineBand,
  type SparklinePoint,
  finiteMetric,
  formatResourceFieldValue,
  resourceMinuteAggregate,
  resourceUnavailableMessages,
} from "./ResourceSparklineCard";
import { ResourcePeakZoomPanel, ResourcePeaksTable } from "./ResourcePeaksTable";

export type ResourcesTabProps = { sessionId: string; historical: boolean; paused?: boolean };

type WindowKind = "5min" | "30min" | "session";
const LIVE_WINDOW_MS: Record<"5min" | "30min", number> = { "5min": 5 * 60_000, "30min": 30 * 60_000 };
const RETENTION_MESSAGES: Record<ResourceRetentionReason, string> = {
  age_retention: "Stored minute curves were removed by the retention-age setting.",
  size_cleanup: "Stored minute curves were removed when the local store's size threshold triggered cleanup.",
  not_recorded: "No minute curves were recorded for this session, and no removal was recorded either.",
};

function liveReader(field: ResourceField): (sample: ResourceUsageSample) => number | null {
  if (field === "cpu_cores") return (sample) => sample.cpuCores;
  if (field === "memory_bytes") return (sample) => sample.memoryBytes;
  if (field === "read_bps") return (sample) => sample.readBytesPerSecond;
  return (sample) => sample.writeBytesPerSecond;
}

function currentReader(field: ResourceField, current: NonNullable<ResourcesDomain["live"]>["current"]): number | null {
  if (!current) return null;
  if (field === "cpu_cores") return current.cpuCores;
  if (field === "memory_bytes") return current.memoryBytes;
  if (field === "read_bps") return current.readBytesPerSecond;
  return current.writeBytesPerSecond;
}

function livePoints(samples: ResourceUsageSample[], field: ResourceField, windowStart: number): SparklinePoint[] {
  const read = liveReader(field);
  return samples.flatMap((sample) => {
    const at = Date.parse(sample.timestamp);
    if (!Number.isFinite(at) || at < windowStart) return [];
    return [{ at, value: finiteMetric(read(sample)) }];
  });
}

function livePeak(points: SparklinePoint[]) {
  let best: { value: number; at: number } | null = null;
  for (const point of points) if (point.value !== null && (best === null || point.value > best.value)) best = { value: point.value, at: point.at };
  return best;
}

function minutePoints(minutes: ResourceMinute[], field: ResourceField) {
  return minutes.flatMap((minute) => {
    const at = Date.parse(minute.minuteStart);
    if (!Number.isFinite(at)) return [];
    const aggregate = resourceMinuteAggregate(minute, field);
    return [{ at, value: aggregate ? aggregate.max : null, min: aggregate ? aggregate.min : null, maxAt: aggregate?.maxAt ?? null }];
  });
}

function sessionPeak(rows: ReturnType<typeof minutePoints>) {
  let best: { value: number; at: string } | null = null;
  for (const row of rows) if (row.value !== null && (best === null || row.value > best.value)) best = { value: row.value, at: row.maxAt || new Date(row.at).toISOString() };
  return best;
}

function liveWindowsEnabled(live: ResourcesDomain["live"]) {
  return (live?.samples.length ?? 0) > 0;
}

/** The three CPU / Memory / Disk I/O sparkline cards for the selected window. */
function buildCards(options: {
  window: WindowKind;
  live: ResourcesDomain["live"];
  minutes: ResourceMinute[];
}): ResourceCardModel[] {
  const { window, live, minutes } = options;
  const fields: Array<{ key: string; field: ResourceField; eyebrow: string; unitCaption: string }> = [
    { key: "cpu", field: "cpu_cores", eyebrow: "CPU", unitCaption: "of one core" },
    { key: "memory", field: "memory_bytes", eyebrow: "Memory", unitCaption: "resident, all processes" },
  ];
  const cards: ResourceCardModel[] = fields.map(({ key, field, eyebrow, unitCaption }) => {
    const formatValue = (value: number | null) => formatResourceFieldValue(field, value);
    if (window === "session") {
      const rows = minutePoints(minutes, field);
      const points: SparklinePoint[] = rows.map((row) => ({ at: row.at, value: row.value }));
      const band: SparklineBand[] = rows.map((row) => ({ at: row.at, min: row.min, max: row.value }));
      const peak = sessionPeak(rows);
      const latest = [...rows].reverse().find((row) => row.value !== null) || null;
      return {
        key, eyebrow, unitCaption, fieldClass: RESOURCE_FIELD_CLASS[field], points, band, formatValue,
        headlineValue: latest?.value ?? null, headlineLabel: "Latest minute",
        peakValue: peak?.value ?? null, peakAt: peak?.at ?? null,
        axisStartLabel: rows[0] ? timelineTime(new Date(rows[0].at).toISOString()) : "—",
        axisEndLabel: rows.at(-1) ? timelineTime(new Date(rows.at(-1)!.at).toISOString()) : "—",
      };
    }
    const windowStart = (live?.samples.at(-1) ? Date.parse(live.samples.at(-1)!.timestamp) : Date.now()) - LIVE_WINDOW_MS[window];
    const points = livePoints(live?.samples || [], field, windowStart);
    const peak = livePeak(points);
    return {
      key, eyebrow, unitCaption, fieldClass: RESOURCE_FIELD_CLASS[field], points, formatValue,
      headlineValue: finiteMetric(currentReader(field, live?.current ?? null)), headlineLabel: null,
      peakValue: peak?.value ?? null, peakAt: peak ? new Date(peak.at).toISOString() : null,
      axisStartLabel: points[0] ? timelineTime(new Date(points[0].at).toISOString()) : "—",
      axisEndLabel: "now",
    };
  });

  const diskFormatValue = (value: number | null) => formatResourceFieldValue("read_bps", value);
  if (window === "session") {
    const readRows = minutePoints(minutes, "read_bps");
    const writeRows = minutePoints(minutes, "write_bps");
    const readPeak = sessionPeak(readRows);
    const writePeak = sessionPeak(writeRows);
    const peak = readPeak && writePeak ? (readPeak.value >= writePeak.value ? readPeak : writePeak) : readPeak || writePeak;
    const latestRead = [...readRows].reverse().find((row) => row.value !== null) || null;
    const latestWrite = [...writeRows].reverse().find((row) => row.value !== null) || null;
    const headline = latestRead && latestWrite ? Math.max(latestRead.value ?? 0, latestWrite.value ?? 0)
      : latestRead?.value ?? latestWrite?.value ?? null;
    cards.push({
      key: "diskio", eyebrow: "Disk I/O",
      legend: [{ fieldClass: RESOURCE_FIELD_CLASS.read_bps, label: "read" }, { fieldClass: RESOURCE_FIELD_CLASS.write_bps, label: "write" }],
      fieldClass: RESOURCE_FIELD_CLASS.read_bps, secondaryFieldClass: RESOURCE_FIELD_CLASS.write_bps,
      points: readRows.map((row) => ({ at: row.at, value: row.value })),
      band: readRows.map((row) => ({ at: row.at, min: row.min, max: row.value })),
      secondaryPoints: writeRows.map((row) => ({ at: row.at, value: row.value })),
      secondaryBand: writeRows.map((row) => ({ at: row.at, min: row.min, max: row.value })),
      formatValue: diskFormatValue,
      headlineValue: headline, headlineLabel: "Latest minute",
      peakValue: peak?.value ?? null, peakAt: peak?.at ?? null,
      axisStartLabel: readRows[0] ? timelineTime(new Date(readRows[0].at).toISOString()) : "—",
      axisEndLabel: readRows.at(-1) ? timelineTime(new Date(readRows.at(-1)!.at).toISOString()) : "—",
    });
  } else {
    const windowStart = (live?.samples.at(-1) ? Date.parse(live.samples.at(-1)!.timestamp) : Date.now()) - LIVE_WINDOW_MS[window];
    const readPoints = livePoints(live?.samples || [], "read_bps", windowStart);
    const writePoints = livePoints(live?.samples || [], "write_bps", windowStart);
    const readPeak = livePeak(readPoints);
    const writePeak = livePeak(writePoints);
    const peak = readPeak && writePeak ? (readPeak.value >= writePeak.value ? readPeak : writePeak) : readPeak || writePeak;
    const readCurrent = finiteMetric(currentReader("read_bps", live?.current ?? null));
    const writeCurrent = finiteMetric(currentReader("write_bps", live?.current ?? null));
    cards.push({
      key: "diskio", eyebrow: "Disk I/O",
      legend: [{ fieldClass: RESOURCE_FIELD_CLASS.read_bps, label: "read" }, { fieldClass: RESOURCE_FIELD_CLASS.write_bps, label: "write" }],
      fieldClass: RESOURCE_FIELD_CLASS.read_bps, secondaryFieldClass: RESOURCE_FIELD_CLASS.write_bps,
      points: readPoints, secondaryPoints: writePoints, formatValue: diskFormatValue,
      headlineValue: readCurrent !== null || writeCurrent !== null ? Math.max(readCurrent ?? 0, writeCurrent ?? 0) : null,
      headlineLabel: null,
      peakValue: peak?.value ?? null, peakAt: peak ? new Date(peak.at).toISOString() : null,
      axisStartLabel: readPoints[0] ? timelineTime(new Date(readPoints[0].at).toISOString()) : "—",
      axisEndLabel: "now",
    });
  }
  return cards;
}

function peaksInWindow(peaks: ResourcePeak[], window: WindowKind, live: ResourcesDomain["live"]) {
  if (window === "session") return peaks;
  const latest = live?.samples.at(-1) ? Date.parse(live.samples.at(-1)!.timestamp) : null;
  if (latest === null) return [];
  const start = latest - LIVE_WINDOW_MS[window];
  return peaks.filter((peak) => { const at = Date.parse(peak.observedAt); return Number.isFinite(at) && at >= start && at <= latest; });
}

/** The Resources tab: sparkline cards, a window selector, a peak zoom panel, and a peaks table. */
export function ResourcesTab({ sessionId, historical, paused = false }: ResourcesTabProps) {
  const result = useSessionDomain({ sessionId, domain: "resources" }, { historical, enabled: !paused });
  const resources = result.data;

  const defaultWindow: WindowKind = historical ? "session" : "30min";
  const [windowState, setWindowState] = useState<{ sessionId: string; window: WindowKind }>({ sessionId, window: defaultWindow });
  if (windowState.sessionId !== sessionId) setWindowState({ sessionId, window: defaultWindow });
  const selectedWindow = windowState.window;

  const [peakState, setPeakState] = useState<{ key: string; id: string | null }>({ key: `${sessionId}:${selectedWindow}`, id: null });
  const peakKey = `${sessionId}:${selectedWindow}`;
  if (peakState.key !== peakKey) setPeakState({ key: peakKey, id: null });

  if (!resources) return <div className="sessionTabState" role="status">{result.unavailable ? "Resource evidence is unavailable for this session." : result.error ? "Resource evidence is temporarily unavailable." : "Loading resource evidence…"}</div>;
  if (resources.readiness === "loading") return <div className="sessionTabState" role="status">Loading resource evidence…</div>;

  const enabled = liveWindowsEnabled(resources.live);
  const selectWindow = (next: WindowKind) => {
    if (next !== "session" && !enabled) return;
    setWindowState({ sessionId, window: next });
  };

  const sourceCaption = selectedWindow === "session" ? "stored minute aggregates" : "live samples";

  let body: ReactNode;
  if (selectedWindow !== "session") {
    if (resources.live?.status === "unavailable") {
      body = <p className="resourcesWindowState" role="status">{resources.live.reason ? resourceUnavailableMessages[resources.live.reason] : "Resource collection is unavailable for this session."}</p>;
    } else if (!enabled) {
      body = <p className="resourcesWindowState" role="status">Collecting resource samples…</p>;
    } else {
      const cards = buildCards({ window: selectedWindow, live: resources.live, minutes: [] });
      const windowPeaks = peaksInWindow(resources.retained.peaks, selectedWindow, resources.live);
      const selectedPeak = windowPeaks.find((peak) => peak.id === peakState.id) || windowPeaks[0] || null;
      body = <>
        <div className="resourceCardsGrid">{cards.map((card) => <ResourceSparklineCard model={card} key={card.key} />)}</div>
        {resources.retained.readiness === "ready" ? <div className="resourcesLowerGrid">
          <ResourcePeakZoomPanel sessionId={sessionId} peak={selectedPeak} />
          <ResourcePeaksTable sessionId={sessionId} peaks={windowPeaks} selectedPeakId={selectedPeak?.id ?? null} onSelect={(id) => setPeakState({ key: peakKey, id })} />
        </div> : <p className="resourcesWindowState" role="status">{retainedStateMessage(resources.retained.readiness)}</p>}
      </>;
    }
  } else {
    const retained = resources.retained;
    if (retained.readiness !== "ready") {
      body = <p className="resourcesWindowState" role="status">{retainedStateMessage(retained.readiness)}</p>;
    } else if (retained.minutes.length === 0 && retained.peaks.length === 0 && !retained.curveRemoval) {
      body = <p className="resourcesWindowState" role="status">No resource history was recorded for this session.</p>;
    } else {
      const windowPeaks = retained.peaks;
      const selectedPeak = windowPeaks.find((peak) => peak.id === peakState.id) || windowPeaks[0] || null;
      const lowerGrid = <div className="resourcesLowerGrid">
        <ResourcePeakZoomPanel sessionId={sessionId} peak={selectedPeak} />
        <ResourcePeaksTable sessionId={sessionId} peaks={windowPeaks} selectedPeakId={selectedPeak?.id ?? null} onSelect={(id) => setPeakState({ key: peakKey, id })} />
      </div>;
      if (retained.minutes.length === 0) {
        body = <>
          <p className="resourcesRetentionState" role="status">{retained.curveRemoval ? RETENTION_MESSAGES[retained.curveRemoval.reason] : RETENTION_MESSAGES.not_recorded}</p>
          {lowerGrid}
        </>;
      } else {
        const cards = buildCards({ window: "session", live: resources.live, minutes: retained.minutes });
        body = <>
          <div className="resourceCardsGrid">{cards.map((card) => <ResourceSparklineCard model={card} key={card.key} />)}</div>
          {lowerGrid}
        </>;
      }
    }
  }

  return <div className="resourcesTab" aria-busy={result.fetching || undefined}>
    {result.error && <div className="notice" role="status"><span aria-hidden="true">!</span>Update failed. Showing the last recorded resource evidence.</div>}
    <div className="resourcesToolbar">
      <p className="resourcesToolbarCaption">Machine resources while this session ran · {sourceCaption}</p>
      <div className="commandSegmented" role="group" aria-label="Resource window" aria-describedby={enabled ? undefined : "resources-window-reason"}>
        <button type="button" aria-pressed={selectedWindow === "5min"} disabled={!enabled} onClick={() => selectWindow("5min")}>5 min</button>
        <button type="button" aria-pressed={selectedWindow === "30min"} disabled={!enabled} onClick={() => selectWindow("30min")}>30 min</button>
        <button type="button" aria-pressed={selectedWindow === "session"} onClick={() => selectWindow("session")}>Session</button>
      </div>
    </div>
    {!enabled && <p className="resourcesWindowReason" id="resources-window-reason">Live samples are unavailable for this session, so 5 min and 30 min are disabled.</p>}
    {body}
  </div>;
}

function retainedStateMessage(readiness: ResourcesDomain["retained"]["readiness"]) {
  if (readiness === "loading") return "Loading stored minute aggregates…";
  if (readiness === "rebuilding") return "Stored resource history is rebuilding after a restart.";
  return "Stored resource history is unavailable.";
}
