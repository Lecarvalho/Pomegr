import { DesktopControls, type DesktopState } from "../DesktopControls";

export function SessionCommandBar({ connected, connecting, historical, paused, desktopState, reportGenerating, canGenerateReport, onGenerateReport, onTogglePause, onSetLaunchAtLogin, onSetCloseBehavior, onSetNotifications, onSetNotificationQuiet, onQuit }: {
  connected: boolean;
  connecting: boolean;
  historical: boolean;
  paused: boolean;
  desktopState: DesktopState | null;
  reportGenerating: boolean;
  canGenerateReport: boolean;
  onGenerateReport: () => void;
  onTogglePause: () => void;
  onSetLaunchAtLogin: (value: boolean) => void;
  onSetCloseBehavior: (value: DesktopState["closeBehavior"]) => void;
  onSetNotifications: (value: boolean) => void;
  onSetNotificationQuiet: (value: boolean) => void;
  onQuit: () => void;
}) {
  const status = connecting ? "Connecting to monitor" : historical ? "Historical snapshot" : connected ? "Monitor connected" : "Monitor offline";
  const reportLabel = reportGenerating ? "Preparing report…" : "Download report";
  const pauseLabel = paused ? "Resume updates" : "Pause updates";
  return (
    <div className="commandSessionBar" aria-label="Session controls">
      <span className={`commandSessionConnection ${connecting ? "connecting" : connected ? "online" : "offline"}`}><i />{status}</span>
      <div>
        {canGenerateReport && <button className="commandSecondaryAction" type="button" onClick={onGenerateReport} disabled={reportGenerating} aria-label={reportLabel} title={reportLabel}>
          <svg className="commandSessionActionIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></svg>
          <span className="commandSessionActionLabel">{reportLabel}</span>
        </button>}
        {!historical && !desktopState && <button className="commandSecondaryAction" type="button" onClick={onTogglePause} aria-label={pauseLabel} title={pauseLabel}>
          <svg className="commandSessionActionIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none">{paused ? <path d="m8 4 12 8-12 8Z" /> : <path d="M8 5v14M16 5v14" />}</svg>
          <span className="commandSessionActionLabel">{pauseLabel}</span>
        </button>}
        {desktopState && <DesktopControls state={desktopState} onTogglePause={onTogglePause} onSetLaunchAtLogin={onSetLaunchAtLogin} onSetCloseBehavior={onSetCloseBehavior} onSetNotifications={onSetNotifications} onSetNotificationQuiet={onSetNotificationQuiet} onQuit={onQuit} />}
      </div>
    </div>
  );
}
