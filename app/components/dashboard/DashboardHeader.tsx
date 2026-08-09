import { ThreadlightBrand } from "../ThreadlightBrand";

export function DashboardHeader({ connected, historical, paused, reportGenerating, canGenerateReport, onOpenSessions, onGenerateReport, onTogglePause }: {
  connected: boolean;
  historical: boolean;
  paused: boolean;
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
        <button className="sessionMenuButton" type="button" onClick={onOpenSessions}>Sessions</button>
        <span className={`connection ${connected ? "online" : "offline"}`}><i /> {historical ? "Historical session" : connected ? "Monitor connected" : "Monitor offline"}</span>
        <button className="ghostButton reportButton" onClick={onGenerateReport} disabled={!canGenerateReport || reportGenerating}>{reportGenerating ? "Generating…" : "Generate report"}</button>
        {!historical && <button className="ghostButton" onClick={onTogglePause}>{paused ? "Resume" : "Pause"}</button>}
      </div>
    </header>
  );
}
