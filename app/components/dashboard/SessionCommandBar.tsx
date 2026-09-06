import { SessionReportButton } from "./SessionReportButton";

export function SessionCommandBar({ connected, connecting, reportGenerating, canGenerateReport, onGenerateReport }: {
  connected: boolean;
  connecting: boolean;
  reportGenerating: boolean;
  canGenerateReport: boolean;
  onGenerateReport: () => void;
}) {
  const status = connecting ? "Connecting to monitor" : "Monitor offline";
  const statusTone = connecting ? "connecting" : "offline";
  const showConnection = connecting || !connected;
  if (!showConnection && !canGenerateReport) return null;
  return (
    <div className="commandSessionBar" aria-label="Session controls">
      {showConnection && <span className={`commandSessionConnection ${statusTone}`} aria-label={`Session state: ${status}`}><i />{status}</span>}
      <div>
        {canGenerateReport && <SessionReportButton generating={reportGenerating} onGenerate={onGenerateReport} />}
      </div>
    </div>
  );
}
