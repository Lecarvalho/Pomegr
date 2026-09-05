export function SessionReportButton({ generating, onGenerate }: { generating: boolean; onGenerate: () => void }) {
  const label = generating ? "Preparing report…" : "Download report";
  return <button className="commandSecondaryAction sessionReportButton" type="button" onClick={onGenerate} disabled={generating} aria-label={label} title={label}>
    <svg className="commandSessionActionIcon" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></svg>
    <span className="commandSessionActionLabel">{label}</span>
  </button>;
}
