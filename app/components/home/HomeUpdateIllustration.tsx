import type { ReactNode } from "react";
import styles from "./HomeUpdateIllustration.module.css";

// Artwork for the current What's new announcement: a static miniature of the Overview Events
// panel. Sample rows only; it never reads session state. Replace the rows (or the whole frame)
// when the announcement changes, keeping the 408px authored width the card thumbnail scales from.
const ROWS: Array<{ time: string; glyph: ReactNode; label: string; detail?: string }> = [
  { time: "14:32", glyph: <><circle cx="4" cy="4" r="1.6" /><circle cx="4" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><path d="M4 5.6v4.8M12 10.4V7a2 2 0 0 0-2-2H8" /></>, label: "Pull request opened", detail: "#44" },
  { time: "14:29", glyph: <><circle cx="8" cy="8" r="2.5" /><path d="M2 8h3.5M10.5 8H14" /></>, label: "Commit observed", detail: "Git-observed" },
  { time: "14:21", glyph: <><circle cx="8" cy="8" r="6" /><path d="M5 8l2 2 4-4" /></>, label: "Agent finished", detail: "Explore: tests · 4m wall" },
  { time: "14:18", glyph: <path d="M4 14V2.5M4 3h8l-2 3 2 3H4" />, label: "Signal reported", detail: "Privacy verified · agent-reported" },
  { time: "14:02", glyph: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />, label: "User message" },
  { time: "14:01", glyph: <><circle cx="8" cy="8" r="6" /><path d="M7 5.5l3.5 2.5L7 10.5z" /></>, label: "Agent started", detail: "Explore: tests" },
];

export function HomeUpdateIllustration() {
  return <div className={styles.frame}>
    <div className={styles.heading}>Events · newest first</div>
    {ROWS.map((row) => <div key={row.time} className={styles.row}>
      <span className={styles.time}>{row.time}</span>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{row.glyph}</svg>
      <span className={styles.text}><strong>{row.label}</strong>{row.detail && <span>{row.detail}</span>}</span>
      <svg className={styles.chevron} viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" /></svg>
    </div>)}
  </div>;
}
