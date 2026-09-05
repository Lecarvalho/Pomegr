import type { Activity, Agent, SessionProgress } from "../../../shared/monitor-contract";
import { AnimatedProgressBar, useAnimatedProgressValue } from "../AnimatedProgress";
import { RelativeTimeText } from "../LiveTime";
import { useLiveNow } from "../../hooks/LiveClockContext";

const STALE_AFTER_MS = 10 * 60 * 1000;

export const PHASE_LABELS: Record<SessionProgress["phase"], string> = {
  planning: "Planning",
  implementing: "Implementing",
  verifying: "Verifying",
  blocked: "Blocked",
  complete: "Complete",
};

function absoluteTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function confidenceLabel(value: SessionProgress["confidence"]) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

export function remainingLabel(progress: SessionProgress) {
  if (progress.remainingMinutesMin === undefined || progress.remainingMinutesMax === undefined) return "Not reported";
  if (progress.remainingMinutesMin === progress.remainingMinutesMax) return `${progress.remainingMinutesMin} min`;
  return `${progress.remainingMinutesMin}–${progress.remainingMinutesMax} min`;
}

function primaryAgent(agents: Agent[]) {
  return agents.find((agent) => agent.id === "primary") || agents.find((agent) => !agent.parentId) || null;
}

function timestampOf(value: string | null | undefined) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function primaryActivityAfter(progress: SessionProgress, primary: Agent | null, activity: Activity[]) {
  const reportedAt = timestampOf(progress.reportedAt);
  if (!primary || !Number.isFinite(reportedAt)) return false;
  const primaryIds = new Set([primary.id, primary.label]);
  const agentTimestamp = Math.max(
    timestampOf(primary.updatedAt),
    timestampOf(primary.lastSeen),
    timestampOf(primary.currentActivity?.observedAt),
  );
  const activityTimestamp = (activity || [])
    .filter((event) => primaryIds.has(event.actor))
    .reduce((latest, event) => Math.max(latest, timestampOf(event.timestamp)), Number.NEGATIVE_INFINITY);
  return Math.max(agentTimestamp, activityTimestamp) > reportedAt;
}

function SessionProgressInstrument({
  progress,
  phaseLabel,
  eta,
  complete,
  historical,
  compact = false,
}: {
  progress: SessionProgress;
  phaseLabel: string;
  eta: string;
  complete: boolean;
  historical: boolean;
  compact?: boolean;
}) {
  const displayedPercent = useAnimatedProgressValue(progress.percent, compact ? "compact" : "detail", !historical);

  if (compact) {
    return <>
      <div className="sessionProgressCompactValue"><strong className="sessionProgressPercent">{Math.round(displayedPercent)}%</strong><span>agent-reported</span></div>
      <AnimatedProgressBar
        value={progress.percent}
        displayedValue={displayedPercent}
        label="Agent-reported session progress"
        valueText={`${progress.percent}% complete · ${phaseLabel}`}
        motion="compact"
        blocked={progress.phase === "blocked"}
      />
      <dl className="sessionKv sessionProgressCompactMeasures">
        <dt>Remaining</dt><dd>{complete ? "Complete" : eta}</dd>
        <dt>Confidence</dt><dd>{confidenceLabel(progress.confidence)}</dd>
        <dt>Recorded</dt><dd><time dateTime={progress.reportedAt}>{absoluteTime(progress.reportedAt)}</time></dd>
      </dl>
    </>;
  }

  return (
    <div className="sessionProgressInstrument">
      <div className="sessionProgressHeadline">
        <div>
          <span>Agent-reported progress</span>
        </div>
        <strong className="sessionProgressPercent" aria-hidden="true">{Math.round(displayedPercent)}%</strong>
      </div>
      <AnimatedProgressBar
        value={progress.percent}
        displayedValue={displayedPercent}
        label="Agent-reported session progress"
        valueText={`${progress.percent}% complete · ${phaseLabel}`}
        motion="detail"
      />
      <div className="sessionProgressMeasures">
        {!complete && <div>
          <span>REMAINING</span>
          <strong>{eta}</strong>
        </div>}
        <div className="sessionProgressConfidence">
          <span>CONFIDENCE</span>
          <strong>{confidenceLabel(progress.confidence)}</strong>
        </div>
      </div>
    </div>
  );
}

export function SessionProgressPanel({
  progress,
  agents = [],
  activity = [],
  connected = true,
  paused = false,
  historical = false,
  needsInput = false,
  variant = "panel",
}: {
  progress: SessionProgress | null | undefined;
  agents?: Agent[];
  activity?: Activity[];
  connected?: boolean;
  paused?: boolean;
  historical?: boolean;
  needsInput?: boolean;
  variant?: "panel" | "compact";
}) {
  const now = useLiveNow();
  if (!progress) {
    if (variant !== "compact") return null;
    return <article className="sessionSummaryCard sessionProgressCard sessionProgressCard-empty panel" aria-label="Agent estimate progress">
      <div className="sessionSummaryCardHeader">
        <span className="sessionEyebrow">Agent estimate · progress</span>
      </div>
      <div className="sessionProgressCompactValue"><strong className="sessionProgressPercent">—</strong><span>No estimate recorded</span></div>
    </article>;
  }

  const primary = primaryAgent(agents);
  const primaryStatus = primary?.status;
  const inputPaused = needsInput || primaryStatus === "needs_input";
  const waitingPaused = primaryStatus === "waiting";
  const blocked = progress.phase === "blocked";
  const etaPaused = blocked || inputPaused || waitingPaused;
  const reportedAt = timestampOf(progress.reportedAt);
  const reportAge = Number.isFinite(reportedAt) ? Math.max(0, now - reportedAt) : 0;
  const stale = !historical
    && connected
    && !paused
    && !etaPaused
    && reportAge >= STALE_AFTER_MS
    && primaryActivityAfter(progress, primary, activity);
  const eta = blocked
    ? "ETA paused — blocked"
    : inputPaused
      ? "ETA paused — needs input"
      : waitingPaused
        ? "ETA paused — waiting"
        : progress.phase === "complete" && progress.percent === 100
            ? "Complete"
          : remainingLabel(progress);
  const complete = progress.phase === "complete" && progress.percent === 100;
  const phaseLabel = PHASE_LABELS[progress.phase];
  const reportLabel = historical
    ? <><span>Recorded agent estimate · </span><time dateTime={progress.reportedAt}>{absoluteTime(progress.reportedAt)}</time></>
    : <><span>Reported </span><time dateTime={progress.reportedAt}><RelativeTimeText value={progress.reportedAt} /></time></>;
  const compactNote = !historical && etaPaused
    ? `The estimate is retained while this session is ${blocked ? "blocked" : inputPaused ? "waiting for input" : "waiting"}.`
    : "Snapshot from the session transcript, not a Pomegr judgment.";

  if (variant === "compact") {
    return <article className={`sessionSummaryCard sessionProgressCard panel${stale ? " sessionProgressStale" : ""}`} aria-label="Agent estimate progress">
      <div className="sessionSummaryCardHeader">
        <span className="sessionEyebrow" title={compactNote}>Agent estimate · progress</span>
        <span className={`sessionSummaryChip sessionProgressPhase sessionProgressPhase-${progress.phase}`}>{phaseLabel}</span>
      </div>
      <SessionProgressInstrument progress={progress} phaseLabel={phaseLabel} eta={eta} complete={complete} historical={historical} compact />
      {stale && <p className="sessionProgressCompactWarning">May be stale — later primary-agent activity was observed.</p>}
      <p className="sessionProgressNote">{compactNote}</p>
    </article>;
  }

  return (
    <section className={`sessionProgressPanel panel${stale ? " sessionProgressStale" : ""}`} aria-labelledby="session-progress-title">
      <header className="sessionProgressHeader">
        <div>
          <span className="sessionProgressEyebrow">Agent estimate</span>
          <h2 id="session-progress-title">Session progress</h2>
        </div>
        <span className={`sessionProgressPhase sessionProgressPhase-${progress.phase}`}>{phaseLabel}</span>
      </header>
      <SessionProgressInstrument progress={progress} phaseLabel={phaseLabel} eta={eta} complete={complete} historical={historical} />
      <div className="sessionProgressReportRow">
        <span>{reportLabel}</span>
        {stale && <strong>May be stale — later primary-agent activity was observed.</strong>}
      </div>
      {historical
        ? <p className="sessionProgressNote">Recorded agent estimate. This is a snapshot from the session transcript.</p>
        : etaPaused
          ? <p className="sessionProgressNote">The estimate is retained while this session is {blocked ? "blocked" : inputPaused ? "waiting for input" : "waiting"}.</p>
          : null}
    </section>
  );
}
