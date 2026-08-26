import type { Activity, Agent, SessionProgress } from "../../../shared/monitor-contract";
import { RelativeTimeText } from "../LiveTime";
import { useLiveNow } from "../../hooks/LiveClockContext";

const STALE_AFTER_MS = 10 * 60 * 1000;

const PHASE_LABELS: Record<SessionProgress["phase"], string> = {
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

function remainingLabel(progress: SessionProgress) {
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

export function SessionProgressPanel({
  progress,
  agents = [],
  activity = [],
  connected = true,
  paused = false,
  historical = false,
  needsInput = false,
}: {
  progress: SessionProgress | null | undefined;
  agents?: Agent[];
  activity?: Activity[];
  connected?: boolean;
  paused?: boolean;
  historical?: boolean;
  needsInput?: boolean;
}) {
  const now = useLiveNow();
  if (!progress) return null;

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

  return (
    <section className={`sessionProgressPanel panel${stale ? " sessionProgressStale" : ""}`} aria-labelledby="session-progress-title">
      <header className="sessionProgressHeader">
        <div>
          <span className="sessionProgressEyebrow">Agent estimate</span>
          <h2 id="session-progress-title">Session progress</h2>
        </div>
        <span className={`sessionProgressPhase sessionProgressPhase-${progress.phase}`}>{phaseLabel}</span>
      </header>
      <div className="sessionProgressInstrument">
        <div className="sessionProgressHeadline">
          <div>
            <strong>{phaseLabel}</strong>
            <span>Provider-reported progress</span>
          </div>
          <strong className="sessionProgressPercent">{progress.percent}%</strong>
        </div>
        <progress max={100} value={progress.percent} aria-label="Agent-reported session progress" aria-valuetext={`${progress.percent}% complete · ${phaseLabel}`} />
        <div className="sessionProgressMeasures">
          {!complete && <div>
            <span>REMAINING</span>
            <strong>{eta}</strong>
          </div>}
          <div>
            <span>CONFIDENCE</span>
            <strong>{confidenceLabel(progress.confidence)}</strong>
          </div>
        </div>
      </div>
      <div className="sessionProgressReportRow">
        <span>{reportLabel}</span>
        {stale && <strong>May be stale — later primary-agent activity was observed.</strong>}
      </div>
      {historical
        ? <p className="sessionProgressNote">Recorded agent estimate. This is a snapshot from the session transcript.</p>
        : etaPaused
          ? <p className="sessionProgressNote">The estimate is retained while this session is {blocked ? "blocked" : inputPaused ? "waiting for input" : "waiting"}.</p>
          : stale
            ? <p className="sessionProgressNote">Values are retained from the last report and may be stale.</p>
            : <p className="sessionProgressNote">An agent-reported snapshot, not a countdown or Pomegr prediction.</p>}
    </section>
  );
}
