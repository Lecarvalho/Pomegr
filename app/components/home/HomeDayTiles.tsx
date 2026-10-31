import { CommandIcon } from "../command-center/CommandIcon";
import { DAY_EVENTS } from "./home-model";
import styles from "./HomeDayTiles.module.css";

/** The small mark beside the greeting that names the window of the tiles. It comes from Pomegr's task logs, not from the chat, so it shows while Aril is Off. */
export function HomeDayMark() {
  return <span className={styles.mark}><CommandIcon name="spark" size="small" />Last 24 hours</span>;
}

/**
 * The last 24 hours in four tiles: how many tasks started, reached Review, were merged, and were marked Done. A fixed rule counts them from the task logs
 * (`dayCounts` in `home-model.ts`); no model runs. With no activity the tiles read zero. A phone draws the short labels in one row.
 */
export function HomeDayTiles({ counts, unreadable = 0 }: { counts: readonly number[]; unreadable?: number }) {
  return <div className={styles.day}>
    <ul className={styles.tiles} aria-label="Tasks in the last 24 hours">
      {DAY_EVENTS.map((event, index) => {
        const count = counts[index] ?? 0;
        // Zero is quiet, a count reads as ink, and Marked Done is the one affirmative signal.
        const tone = count === 0 ? styles.zero : index === DAY_EVENTS.length - 1 ? styles.done : "";
        return <li key={event.label} className={styles.tile}>
          <span className={`${styles.number} ${tone}`}>{count}</span>
          <span className={styles.label}><span className={styles.long}>{event.label}</span><span className={styles.short} aria-hidden="true">{event.short}</span></span>
        </li>;
      })}
    </ul>
    {unreadable > 0 && <p className={styles.note} role="status">Some logs could not be read.</p>}
  </div>;
}

/** While the logs are read: quiet words, never a count. */
export function HomeDayReading() {
  return <p className={styles.note} role="status">Reading the task logs…</p>;
}
