import styles from "./HomeUpdateIllustration.module.css";

// Artwork for the current What's new announcement: the Tasks strip of an active Aril grant above the task log, cropped at the bottom edge.
type Row = { time: string; task: string | null; label: string; pullRequest?: number };

// Invented sample rows, newest first, with the labels the task log shows.
const ROWS: Row[] = [
  { time: "15:30", task: "T-5", label: "Merged by Aril under a grant", pullRequest: 12 },
  { time: "15:00", task: "T-5", label: "Review passed" },
  { time: "14:30", task: null, label: "Resumed after provider usage (codex)" },
  { time: "14:00", task: null, label: "Paused for provider usage (codex)" },
  { time: "13:30", task: "T-5", label: "Sent back by Aril under a grant" },
  { time: "13:00", task: "T-5", label: "Review failed" },
];

export function HomeUpdateIllustration() {
  return <div className={styles.frame}>
    <div className={styles.strip}>
      <span>Aril grant until <span className={styles.value}>18:00</span></span>
      <span className={styles.actions}><span>Aril settings</span><span>Log</span></span>
    </div>
    <div className={styles.log}>
      <div className={styles.head}>Task log</div>
      {ROWS.map((row) => <div key={row.time} className={styles.row}>
        <span className={styles.time}>{row.time}</span>
        <span className={styles.task}>{row.task}</span>
        <span className={styles.label}>{row.label}</span>
        {row.pullRequest !== undefined && <span className={styles.pr}>PR #{row.pullRequest}</span>}
      </div>)}
    </div>
  </div>;
}
