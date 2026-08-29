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
  return (
    <div className="commandSessionBar" aria-label="Session controls">
      <span className={`commandSessionConnection ${connecting ? "connecting" : connected ? "online" : "offline"}`}><i />{status}</span>
      <div>
        {canGenerateReport && <button className="commandSecondaryAction" type="button" onClick={onGenerateReport} disabled={reportGenerating}>{reportGenerating ? "Preparing report…" : "Download report"}</button>}
        {!historical && !desktopState && <button className="commandSecondaryAction" type="button" onClick={onTogglePause}>{paused ? "Resume updates" : "Pause updates"}</button>}
        {desktopState && <DesktopControls state={desktopState} onTogglePause={onTogglePause} onSetLaunchAtLogin={onSetLaunchAtLogin} onSetCloseBehavior={onSetCloseBehavior} onSetNotifications={onSetNotifications} onSetNotificationQuiet={onSetNotificationQuiet} onQuit={onQuit} />}
      </div>
    </div>
  );
}
