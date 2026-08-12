import { ThreadlightBrand } from "../ThreadlightBrand";
import { ThemeToggle } from "../ThemeToggle";
import { DesktopControls, type DesktopState } from "../DesktopControls";

export function DashboardHeader({ connected, connecting, historical, paused, desktopState, sessionsOpen, reportGenerating, canGenerateReport, onOpenSessions, onGenerateReport, onTogglePause, onSetLaunchAtLogin, onSetCloseBehavior, onQuit }: {
  connected: boolean;
  connecting: boolean;
  historical: boolean;
  paused: boolean;
  desktopState: DesktopState | null;
  sessionsOpen: boolean;
  reportGenerating: boolean;
  canGenerateReport: boolean;
  onOpenSessions: () => void;
  onGenerateReport: () => void;
  onTogglePause: () => void;
  onSetLaunchAtLogin: (value: boolean) => void;
  onSetCloseBehavior: (value: DesktopState["closeBehavior"]) => void;
  onQuit: () => void;
}) {
  return (
    <header className="topbar">
      <ThreadlightBrand href="#top" />
      <div className="topActions">
        <button className="sessionMenuButton" type="button" onClick={onOpenSessions} aria-expanded={sessionsOpen} aria-controls="session-navigation">Sessions</button>
        <span className={`connection ${connecting ? "connecting" : connected ? "online" : "offline"}`}><i /> {connecting ? "Connecting to monitor" : historical ? "Historical snapshot" : connected ? "Monitor connected" : "Monitor offline"}</span>
        {canGenerateReport && <button className="ghostButton reportButton" onClick={onGenerateReport} disabled={reportGenerating}>{reportGenerating ? "Preparing report…" : "Download report"}</button>}
        {!historical && !desktopState && <button className="ghostButton" onClick={onTogglePause}>{paused ? "Resume updates" : "Pause updates"}</button>}
        {desktopState && <DesktopControls state={desktopState} onTogglePause={onTogglePause} onSetLaunchAtLogin={onSetLaunchAtLogin} onSetCloseBehavior={onSetCloseBehavior} onQuit={onQuit} />}
        <ThemeToggle />
      </div>
    </header>
  );
}
