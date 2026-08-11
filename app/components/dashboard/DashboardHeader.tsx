import { ThreadlightBrand } from "../ThreadlightBrand";
import { ThemeToggle } from "../ThemeToggle";

export function DashboardHeader({ connected, historical, paused, sessionsOpen, reportGenerating, canGenerateReport, onOpenSessions, onGenerateReport, onTogglePause }: {
  connected: boolean;
  historical: boolean;
  paused: boolean;
  sessionsOpen: boolean;
  reportGenerating: boolean;
  canGenerateReport: boolean;
  onOpenSessions: () => void;
  onGenerateReport: () => void;
  onTogglePause: () => void;
}) {
  return (
    <header className="topbar">
      <ThreadlightBrand href="#top" />
      <div className="topActions">
        <button className="sessionMenuButton" type="button" onClick={onOpenSessions} aria-expanded={sessionsOpen} aria-controls="session-navigation">Sessions</button>
        <span className={`connection ${connected ? "online" : "offline"}`}><i /> {historical ? "Historical snapshot" : connected ? "Monitor connected" : "Monitor offline"}</span>
        {canGenerateReport && <button className="ghostButton reportButton" onClick={onGenerateReport} disabled={reportGenerating}>{reportGenerating ? "Preparing report…" : "Download report"}</button>}
        {!historical && canGenerateReport && <button className="ghostButton" onClick={onTogglePause}>{paused ? "Resume updates" : "Pause updates"}</button>}
        <ThemeToggle />
      </div>
    </header>
  );
}
