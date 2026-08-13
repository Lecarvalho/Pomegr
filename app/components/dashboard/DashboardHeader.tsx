import { PomegrBrand } from "../PomegrBrand";
import { ThemeToggle } from "../ThemeToggle";
import { DesktopControls, type DesktopState } from "../DesktopControls";

export function DashboardHeader({ connected, connecting, historical, paused, desktopState, sessionsOpen, reportGenerating, canGenerateReport, onOpenSessions, onGenerateReport, onTogglePause, onSetLaunchAtLogin, onSetCloseBehavior, onSetNotifications, onSetNotificationQuiet, onQuit }: {
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
  onSetNotifications: (value: boolean) => void;
  onSetNotificationQuiet: (value: boolean) => void;
  onQuit: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbarLead">
        <button className="sessionMenuButton" type="button" onClick={onOpenSessions} aria-label="Open sessions menu" aria-expanded={sessionsOpen} aria-controls="session-navigation" title="Open sessions menu">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        <PomegrBrand href="#top" />
      </div>
      <div className="topActions">
        <span className={`connection ${connecting ? "connecting" : connected ? "online" : "offline"}`}><i /> {connecting ? "Connecting to monitor" : historical ? "Historical snapshot" : connected ? "Monitor connected" : "Monitor offline"}</span>
        {canGenerateReport && <button className="ghostButton reportButton" onClick={onGenerateReport} disabled={reportGenerating} aria-label={reportGenerating ? "Preparing report" : "Download report"}><span className="desktopActionLabel">{reportGenerating ? "Preparing report…" : "Download report"}</span><span className="mobileActionLabel">{reportGenerating ? "Preparing…" : "Report"}</span></button>}
        {!historical && !desktopState && <button className="ghostButton" onClick={onTogglePause} aria-label={paused ? "Resume updates" : "Pause updates"}><span className="desktopActionLabel">{paused ? "Resume updates" : "Pause updates"}</span><span className="mobileActionLabel">{paused ? "Resume" : "Pause"}</span></button>}
        {desktopState && <DesktopControls state={desktopState} onTogglePause={onTogglePause} onSetLaunchAtLogin={onSetLaunchAtLogin} onSetCloseBehavior={onSetCloseBehavior} onSetNotifications={onSetNotifications} onSetNotificationQuiet={onSetNotificationQuiet} onQuit={onQuit} />}
        <ThemeToggle />
      </div>
    </header>
  );
}
