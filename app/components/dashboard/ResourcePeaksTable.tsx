"use client";

import Link from "next/link";
import type { ResourcePeak } from "../../../shared/session-domain-contract";
import { encodeSessionRoute } from "../../../shared/session-route.mjs";
import { formatDuration } from "../../dashboard-utils";
import { WORK_LABELS } from "../agents/agent-presentation";
import { DottedInfoPopover } from "../DottedInfoPopover";
import { RESOURCE_FIELD_CLASS, RESOURCE_FIELD_LABEL, formatResourceFieldValue, resourceClockTime, resourceMinuteAggregate } from "./ResourceSparklineCard";

function activitiesHref(sessionId: string) {
  try { return `/sessions/${encodeSessionRoute(sessionId)}?tab=activities`; } catch { return "/sessions"; }
}

function requestHref(sessionId: string, requestNumber: number) {
  try { return `/sessions/${encodeSessionRoute(sessionId)}?tab=activities&request=${requestNumber}`; } catch { return "/sessions"; }
}

const ZOOM_WIDTH = 560;
const ZOOM_HEIGHT = 96;

function ZoomChart({ peak }: { peak: ResourcePeak }) {
  const samples = peak.window.samples;
  const times = samples.map((sample) => Date.parse(sample.at)).filter((time) => Number.isFinite(time));
  const start = times.length ? Math.min(...times) : 0;
  const end = times.length ? Math.max(...times) : 0;
  const finiteValues = samples.map((sample) => sample.value).filter((value): value is number => value !== null);
  const maximum = finiteValues.length ? Math.max(0, ...finiteValues) * 1.08 || 1 : 1;
  const scaleX = (at: number) => { const span = end - start; const progress = span > 0 ? (at - start) / span : 0.5; return Math.max(0, Math.min(1, progress)) * ZOOM_WIDTH; };
  const scaleY = (value: number) => ZOOM_HEIGHT - (maximum > 0 ? Math.max(0, Math.min(1, value / maximum)) : 0) * ZOOM_HEIGHT;
  const runs: string[] = [];
  let current: string[] = [];
  for (const sample of samples) {
    const time = Date.parse(sample.at);
    if (sample.value === null || !Number.isFinite(time)) { if (current.length) { runs.push(current.join(" ")); current = []; } continue; }
    current.push(`${scaleX(time).toFixed(2)},${scaleY(sample.value).toFixed(2)}`);
  }
  if (current.length) runs.push(current.join(" "));
  const peakTime = Date.parse(peak.observedAt);
  const peakX = Number.isFinite(peakTime) ? scaleX(peakTime) : ZOOM_WIDTH / 2;
  const fieldClass = RESOURCE_FIELD_CLASS[peak.field];
  return <div className="resourcePeakZoomChart">
    <svg viewBox={`0 0 ${ZOOM_WIDTH} ${ZOOM_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      {runs.map((points, index) => <polyline className={`${fieldClass}Line`} points={points} fill="none" key={index} />)}
      <line className="resourcePeakZoomMarker" x1={peakX} y1="0" x2={peakX} y2={ZOOM_HEIGHT} strokeDasharray="3 3" />
    </svg>
  </div>;
}

function MinuteFallback({ peak }: { peak: ResourcePeak }) {
  const minute = peak.window.minute;
  const aggregate = minute ? resourceMinuteAggregate(minute, peak.field) : null;
  return <div className="resourcePeakZoomFallback" role="status">
    <p>Full-resolution window not retained.</p>
    {aggregate ? <dl className="resourcePeakZoomMinute">
      <div><dt>Min</dt><dd>{formatResourceFieldValue(peak.field, aggregate.min)}</dd></div>
      <div><dt>Avg</dt><dd>{formatResourceFieldValue(peak.field, aggregate.avg)}</dd></div>
      <div><dt>Max</dt><dd>{formatResourceFieldValue(peak.field, aggregate.max)}</dd></div>
    </dl> : <p className="resourcePeakZoomEmpty">No minute aggregate was recorded for this peak.</p>}
  </div>;
}

/** The full-resolution (or minute-fallback) inspector for one selected peak. */
export function ResourcePeakZoomPanel({ sessionId, peak }: { sessionId: string; peak: ResourcePeak | null }) {
  if (!peak) return <section className="sessionOverviewPanel resourcePeakZoomPanel">
    <p className="resourcePeaksEmpty">Select a peak to inspect its evidence.</p>
  </section>;
  return <section className="sessionOverviewPanel resourcePeakZoomPanel" aria-labelledby="resource-peak-zoom-heading">
    <div className="resourcePeakZoomHeader">
      <div className="resourcePeakZoomTitle">
        <h2 id="resource-peak-zoom-heading" className="resourcesPanelHeading">Peak {resourceClockTime(peak.observedAt)}</h2>
        <span className="commandChip">{RESOURCE_FIELD_LABEL[peak.field]} {formatResourceFieldValue(peak.field, peak.value)}</span>
      </div>
      {peak.window.status === "retained" && <span className="resourcePeakZoomCaption">full resolution · 2 min before and after</span>}
    </div>
    {peak.window.status === "retained" ? <ZoomChart peak={peak} /> : <MinuteFallback peak={peak} />}
    <div className="resourcePeakZoomRow">
      <span className="resourcePeakZoomRowLabel">Overlapping tasks</span>
      {peak.tasks.length === 0 ? <span className="resourcePeakZoomEmpty">No overlapping tasks were recorded.</span> : <ul className="resourcePeakZoomTasks">
        {peak.tasks.map((task) => <li key={task.id}>{WORK_LABELS[task.workKind]} · <b>{task.label}</b> · {task.durationMs === null ? "running" : formatDuration(task.durationMs)} · started {resourceClockTime(task.startedAt)}</li>)}
      </ul>}
    </div>
    {peak.request && <div className="resourcePeakZoomRow resourcePeakZoomRequest">
      <span className="resourcePeakZoomRowLabel">Request</span>
      <p>
        <Link className="commandTextLink" href={requestHref(sessionId, peak.request.number)}>{`#${peak.request.number}`}</Link>
        {" "}Request observed near this peak · {peak.request.uncachedInputTokens === null ? "uncached input tokens unavailable" : `${peak.request.uncachedInputTokens.toLocaleString()} uncached input tokens`}
      </p>
    </div>}
    <p className="resourcePeakZoomCaveat"><DottedInfoPopover ariaLabel="About this evidence" content="Matched tasks and requests only overlapped this peak in time; no per-task or per-request cost is derived from it.">Time overlap only, not attribution.</DottedInfoPopover></p>
  </section>;
}

/** The ranked list of peaks in the selected window; selecting a row drives the zoom panel. */
export function ResourcePeaksTable({ sessionId, peaks, selectedPeakId, onSelect }: {
  sessionId: string;
  peaks: ResourcePeak[];
  selectedPeakId: string | null;
  onSelect: (id: string) => void;
}) {
  return <section className="sessionOverviewPanel resourcePeaksTablePanel" aria-labelledby="resource-peaks-heading">
    <div className="resourcePeaksTableHeader">
      <h2 id="resource-peaks-heading" className="resourcesPanelHeading">Peaks in this window</h2>
      <Link className="commandQuietAction" href={activitiesHref(sessionId)}>Show in Activity</Link>
    </div>
    {peaks.length === 0 ? <p className="resourcePeaksEmpty">No peaks were recorded for this window.</p> : <div className="resourcePeaksRows">
      {peaks.map((peak) => {
        const selected = peak.id === selectedPeakId;
        const primaryTask = peak.tasks[0];
        return <div className={`resourcePeaksRow${selected ? " isSelected" : ""}`} key={peak.id}>
          <button type="button" className="resourcePeaksRowSelect" aria-pressed={selected} onClick={() => onSelect(peak.id)}>
            <span className="resourcePeaksRowTime">{resourceClockTime(peak.observedAt)}</span>
            <span className="resourcePeaksRowSummary">
              {RESOURCE_FIELD_LABEL[peak.field]} {formatResourceFieldValue(peak.field, peak.value)}
              {primaryTask && <> · during <b>{primaryTask.label}</b>{peak.tasks.length > 1 ? ` +${peak.tasks.length - 1} more` : ""}</>}
            </span>
          </button>
          <span className="resourcePeaksRowRequest">{peak.request && <Link href={requestHref(sessionId, peak.request.number)}>{`#${peak.request.number}`}</Link>}</span>
        </div>;
      })}
    </div>}
    <p className="resourcePeaksCaveat"><DottedInfoPopover ariaLabel="About peak matching" content="Peaks are matched to activity by time only. Coincidence, not causation.">Matched to activity by time only.</DottedInfoPopover></p>
  </section>;
}
