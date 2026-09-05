import type { SessionSummary } from "../../../shared/monitor-contract";
import { sessionState } from "../../dashboard-utils";

export function SessionCommandBar({ activityStatus, connected, connecting, historical, paused, reportGenerating, canGenerateReport, onGenerateReport, onTogglePause }: {
  activityStatus: SessionSummary["activityStatus"] | null | undefined;
  connected: boolean;
  connecting: boolean;
  historical: boolean;
  paused: boolean;
  reportGenerating: boolean;
  canGenerateReport: boolean;
  onGenerateReport: () => void;
  onTogglePause: () => void;
}) {
  const activity = sessionState({ activityStatus: activityStatus || "unknown" });
  const status = connecting ? "Connecting to monitor" : historical ? "Historical snapshot" : !connected ? "Monitor offline" : activity.label;
  const statusTone = connecting ? "connecting" : historical ? "idle" : !connected ? "offline" : activity.state;
  const reportLabel = reportGenerating ? "Preparing report…" : "Download report";
  const pauseLabel = paused ? "Resume updates" : "Pause updates";
  return (
    <div className="commandSessionBar" aria-label="Session controls">
      <span className={`commandSessionConnection ${statusTone}`} aria-label={`Session state: ${status}`}><i />{status}</span>
      <div>
        {canGenerateReport && <button className="commandSecondaryAction" type="button" onClick={onGenerateReport} disabled={reportGenerating} aria-label={reportLabel} title={reportLabel}>
          <svg className="commandSessionActionIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></svg>
          <span className="commandSessionActionLabel">{reportLabel}</span>
        </button>}
        {!historical && <button className="commandSecondaryAction" type="button" onClick={onTogglePause} aria-label={pauseLabel} title={pauseLabel}>
          <svg className="commandSessionActionIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none">{paused ? <path d="m8 4 12 8-12 8Z" /> : <path d="M8 5v14M16 5v14" />}</svg>
          <span className="commandSessionActionLabel">{pauseLabel}</span>
        </button>}
      </div>
    </div>
  );
}
